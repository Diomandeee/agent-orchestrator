package uctm_test

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	uctmsvc "github.com/aoagents/agent-orchestrator/backend/internal/service/uctm"
)

type fakeSource struct {
	responses map[domain.UCTMProjectionKind]domain.UCTMSourceResponse
	err       error
	calls     int
}

func (f *fakeSource) Fetch(_ context.Context, kind domain.UCTMProjectionKind) (domain.UCTMSourceResponse, error) {
	f.calls++
	if f.err != nil {
		return domain.UCTMSourceResponse{}, f.err
	}
	resp, ok := f.responses[kind]
	if !ok {
		return domain.UCTMSourceResponse{NoFacts: true}, nil
	}
	return resp, nil
}

type fakeStore struct {
	records   map[string]domain.UCTMProjectionRecord
	upserts   int
	upsertErr error
	getErr    error
}

func newFakeStore() *fakeStore {
	return &fakeStore{records: map[string]domain.UCTMProjectionRecord{}}
}

func (f *fakeStore) key(projectID domain.ProjectID, kind domain.UCTMProjectionKind, externalID string) string {
	return string(projectID) + "|" + string(kind) + "|" + externalID
}

func (f *fakeStore) UpsertUCTMProjection(_ context.Context, record domain.UCTMProjectionRecord) (bool, error) {
	f.upserts++
	if f.upsertErr != nil {
		return false, f.upsertErr
	}
	key := f.key(record.ProjectID, record.Kind, record.ExternalID)
	previous, existed := f.records[key]
	f.records[key] = record
	return !existed || previous.SourceHash != record.SourceHash, nil
}

func (f *fakeStore) GetUCTMProjection(_ context.Context, projectID domain.ProjectID, kind domain.UCTMProjectionKind, externalID string) (domain.UCTMProjectionRecord, bool, error) {
	if f.getErr != nil {
		return domain.UCTMProjectionRecord{}, false, f.getErr
	}
	record, ok := f.records[f.key(projectID, kind, externalID)]
	return record, ok, nil
}

func responseFor(payload string, maxAge time.Duration) domain.UCTMSourceResponse {
	return domain.UCTMSourceResponse{
		Metadata: domain.UCTMWireMetadata{
			SchemaVersion:          "uctm.projection.v0",
			SourceCommitOrFreezeID: "freeze-1",
			GeneratedAt:            time.Date(2026, 9, 18, 12, 0, 0, 0, time.UTC),
			HistoricalOrCurrent:    domain.UCTMHistorical,
			AuthorityCeiling:       domain.UCTMCeilingReadOnly,
			ReceiptRef:             "receipt-1",
			ContentHashOrETag:      `"etag-1"`,
		},
		Payload: []byte(payload),
		MaxAge:  maxAge,
	}
}

func clockAt(t time.Time) func() time.Time { return func() time.Time { return t } }

// A mode that authorises no read must not call UCTM at all. "Off" is a promise
// about network behaviour, not just about what the route prints.
func TestReadModeOffNeverContactsTheSource(t *testing.T) {
	source := &fakeSource{}
	store := newFakeStore()
	svc := uctmsvc.New(uctmsvc.Options{Mode: domain.UCTMModeOff, Source: source, Store: store})

	read, err := svc.Read(context.Background(), "", domain.UCTMKindStatus)
	if err != nil {
		t.Fatalf("Read: %v", err)
	}
	if source.calls != 0 {
		t.Fatalf("mode off made %d UCTM calls", source.calls)
	}
	if store.upserts != 0 {
		t.Fatalf("mode off wrote %d projections", store.upserts)
	}
	if read.Freshness != domain.UCTMFreshnessDisabled || read.Reason != domain.UCTMReasonModeOff {
		t.Fatalf("read = %+v, want disabled/mode_off", read)
	}
	if read.Projection != nil {
		t.Fatal("disabled read carried a projection")
	}
}

// The zero mode is the one a half-configured daemon has. It must behave exactly
// like off rather than defaulting to anything that reads.
func TestReadZeroModeIsOff(t *testing.T) {
	source := &fakeSource{}
	svc := uctmsvc.New(uctmsvc.Options{Source: source})
	if svc.Mode() != domain.UCTMModeOff {
		t.Fatalf("zero-value service mode = %q, want off", svc.Mode())
	}
	read, err := svc.Read(context.Background(), "", domain.UCTMKindStatus)
	if err != nil || read.Freshness != domain.UCTMFreshnessDisabled {
		t.Fatalf("read = %+v err = %v", read, err)
	}
	if source.calls != 0 {
		t.Fatal("unconfigured service contacted UCTM")
	}
}

// read_only with no usable transport is a misconfiguration, and the display must
// name it instead of showing a healthy-looking empty dashboard.
func TestReadWithoutTransportReportsTransportNotConfigured(t *testing.T) {
	svc := uctmsvc.New(uctmsvc.Options{Mode: domain.UCTMModeReadOnly})
	read, err := svc.Read(context.Background(), "", domain.UCTMKindGates)
	if err != nil {
		t.Fatalf("Read: %v", err)
	}
	if read.Freshness != domain.UCTMFreshnessUnknown || read.Reason != domain.UCTMReasonTransportNotConfigured {
		t.Fatalf("read = %+v, want unknown/transport_not_configured", read)
	}
	if read.Projection != nil {
		t.Fatal("unconfigured read carried a projection")
	}
}

func TestReadStoresAndServesAFreshProjection(t *testing.T) {
	now := time.Date(2026, 9, 18, 12, 0, 0, 0, time.UTC)
	source := &fakeSource{responses: map[domain.UCTMProjectionKind]domain.UCTMSourceResponse{
		domain.UCTMKindStatus: responseFor(`{"facts":[]}`, 2*time.Minute),
	}}
	store := newFakeStore()
	svc := uctmsvc.New(uctmsvc.Options{Mode: domain.UCTMModeReadOnly, Source: source, Store: store, Now: clockAt(now)})

	read, err := svc.Read(context.Background(), "proj", domain.UCTMKindStatus)
	if err != nil {
		t.Fatalf("Read: %v", err)
	}
	if read.Freshness != domain.UCTMFreshnessFresh || read.Reason != domain.UCTMReasonFreshProjection {
		t.Fatalf("read = %+v, want fresh/fresh_projection", read)
	}
	if store.upserts != 1 {
		t.Fatalf("upserts = %d, want 1", store.upserts)
	}
	stored := store.records["proj|status|"]
	if string(stored.PayloadJSON) != `{"facts":[]}` {
		t.Fatalf("stored payload = %s", stored.PayloadJSON)
	}
	if !stored.ExpiresAt.Equal(now.Add(2 * time.Minute)) {
		t.Fatalf("ExpiresAt = %s, want the service-granted 2m", stored.ExpiresAt)
	}
	if stored.SourceHash != domain.ContentAddress([]byte(`{"facts":[]}`)) {
		t.Fatalf("SourceHash = %q, want the payload content address", stored.SourceHash)
	}
}

// The UI polls. A projection still inside its granted window is served without a
// round trip, which is what keeps the read path from becoming a load source.
func TestReadServesAnUnexpiredProjectionWithoutRefetching(t *testing.T) {
	now := time.Date(2026, 9, 18, 12, 0, 0, 0, time.UTC)
	source := &fakeSource{responses: map[domain.UCTMProjectionKind]domain.UCTMSourceResponse{
		domain.UCTMKindStatus: responseFor(`{"facts":[]}`, time.Minute),
	}}
	store := newFakeStore()
	svc := uctmsvc.New(uctmsvc.Options{Mode: domain.UCTMModeReadOnly, Source: source, Store: store, Now: clockAt(now)})

	if _, err := svc.Read(context.Background(), "", domain.UCTMKindStatus); err != nil {
		t.Fatalf("first Read: %v", err)
	}
	if _, err := svc.Read(context.Background(), "", domain.UCTMKindStatus); err != nil {
		t.Fatalf("second Read: %v", err)
	}
	if source.calls != 1 {
		t.Fatalf("source calls = %d, want 1 (a fresh projection must not refetch)", source.calls)
	}
}

func TestReadRefetchesAnExpiredProjection(t *testing.T) {
	start := time.Date(2026, 9, 18, 12, 0, 0, 0, time.UTC)
	current := start
	source := &fakeSource{responses: map[domain.UCTMProjectionKind]domain.UCTMSourceResponse{
		domain.UCTMKindStatus: responseFor(`{"facts":[]}`, time.Minute),
	}}
	store := newFakeStore()
	svc := uctmsvc.New(uctmsvc.Options{
		Mode: domain.UCTMModeReadOnly, Source: source, Store: store, Now: func() time.Time { return current },
	})

	if _, err := svc.Read(context.Background(), "", domain.UCTMKindStatus); err != nil {
		t.Fatalf("first Read: %v", err)
	}
	current = start.Add(2 * time.Minute)
	read, err := svc.Read(context.Background(), "", domain.UCTMKindStatus)
	if err != nil {
		t.Fatalf("second Read: %v", err)
	}
	if source.calls != 2 {
		t.Fatalf("source calls = %d, want 2 after expiry", source.calls)
	}
	if read.Freshness != domain.UCTMFreshnessFresh {
		t.Fatalf("freshness = %q, want fresh after a successful refetch", read.Freshness)
	}
}

// The core failure doctrine: an unreachable service derives stale from the last
// projection, and unknown when there is none. There is no path to "fresh".
func TestReadFailureDerivesStaleOrUnknownNeverHealthy(t *testing.T) {
	now := time.Date(2026, 9, 18, 12, 0, 0, 0, time.UTC)

	t.Run("surviving projection becomes stale", func(t *testing.T) {
		store := newFakeStore()
		store.records["|gates|"] = domain.UCTMProjectionRecord{
			Kind: domain.UCTMKindGates, PayloadJSON: []byte(`{"facts":[]}`),
			SourceHash: domain.ContentAddress([]byte(`{"facts":[]}`)),
			Metadata: domain.UCTMWireMetadata{
				SchemaVersion: "v0", SourceCommitOrFreezeID: "f1", GeneratedAt: now,
				HistoricalOrCurrent: domain.UCTMHistorical, AuthorityCeiling: domain.UCTMCeilingReadOnly,
				ReceiptRef: "r1", ContentHashOrETag: `"e1"`,
			},
			ObservedAt: now.Add(-time.Hour), ExpiresAt: now.Add(-time.Minute),
		}
		source := &fakeSource{err: errors.New("connection refused")}
		svc := uctmsvc.New(uctmsvc.Options{Mode: domain.UCTMModeReadOnly, Source: source, Store: store, Now: clockAt(now)})

		read, err := svc.Read(context.Background(), "", domain.UCTMKindGates)
		if err != nil {
			t.Fatalf("Read: %v", err)
		}
		if read.Freshness != domain.UCTMFreshnessStale {
			t.Fatalf("freshness = %q, want stale", read.Freshness)
		}
		if read.Projection == nil {
			t.Fatal("stale read dropped the surviving projection")
		}
		if read.Reason != domain.UCTMReasonServiceUnavailable {
			t.Fatalf("reason = %q", read.Reason)
		}
	})

	t.Run("no projection becomes unknown", func(t *testing.T) {
		source := &fakeSource{err: errors.New("connection refused")}
		svc := uctmsvc.New(uctmsvc.Options{
			Mode: domain.UCTMModeReadOnly, Source: source, Store: newFakeStore(), Now: clockAt(now),
		})
		read, err := svc.Read(context.Background(), "", domain.UCTMKindGates)
		if err != nil {
			t.Fatalf("Read: %v", err)
		}
		if read.Freshness != domain.UCTMFreshnessUnknown || read.Projection != nil {
			t.Fatalf("read = %+v, want unknown with no projection", read)
		}
	})
}

// An abstention is a claim ("no facts"), not an empty fact. It must not overwrite
// a projection AO already holds.
func TestReadAbstentionDoesNotOverwriteAProjection(t *testing.T) {
	now := time.Date(2026, 9, 18, 12, 0, 0, 0, time.UTC)
	store := newFakeStore()
	store.records["|families|"] = domain.UCTMProjectionRecord{
		Kind: domain.UCTMKindFamilies, PayloadJSON: []byte(`{"facts":[1]}`),
		SourceHash: domain.ContentAddress([]byte(`{"facts":[1]}`)),
		Metadata: domain.UCTMWireMetadata{
			SchemaVersion: "v0", SourceCommitOrFreezeID: "f1", GeneratedAt: now,
			HistoricalOrCurrent: domain.UCTMHistorical, AuthorityCeiling: domain.UCTMCeilingReadOnly,
			ReceiptRef: "r1", ContentHashOrETag: `"e1"`,
		},
		ObservedAt: now.Add(-time.Hour), ExpiresAt: now.Add(-time.Minute),
	}
	source := &fakeSource{responses: map[domain.UCTMProjectionKind]domain.UCTMSourceResponse{
		domain.UCTMKindFamilies: {NoFacts: true},
	}}
	svc := uctmsvc.New(uctmsvc.Options{Mode: domain.UCTMModeReadOnly, Source: source, Store: store, Now: clockAt(now)})

	read, err := svc.Read(context.Background(), "", domain.UCTMKindFamilies)
	if err != nil {
		t.Fatalf("Read: %v", err)
	}
	if store.upserts != 0 {
		t.Fatalf("abstention wrote %d projections", store.upserts)
	}
	if read.Freshness != domain.UCTMFreshnessStale || read.Reason != domain.UCTMReasonNoFacts {
		t.Fatalf("read = %+v, want stale/no_facts", read)
	}
}

// A service that starts claiming more authority than AO's mode allows is
// refused, not downgraded. Displaying it would launder the claim.
func TestReadRefusesAnAuthorityCeilingAboveTheMode(t *testing.T) {
	now := time.Date(2026, 9, 18, 12, 0, 0, 0, time.UTC)
	for _, ceiling := range []domain.UCTMAuthorityCeiling{
		domain.UCTMCeilingProposalOnly,
		domain.UCTMCeilingHumanAdjudication,
		domain.UCTMCeilingTraining,
		domain.UCTMCeilingDownstreamEffect,
		domain.UCTMAuthorityCeiling("root"),
	} {
		t.Run(string(ceiling), func(t *testing.T) {
			resp := responseFor(`{"facts":[]}`, time.Minute)
			resp.Metadata.AuthorityCeiling = ceiling
			source := &fakeSource{responses: map[domain.UCTMProjectionKind]domain.UCTMSourceResponse{
				domain.UCTMKindStatus: resp,
			}}
			store := newFakeStore()
			svc := uctmsvc.New(uctmsvc.Options{
				Mode: domain.UCTMModeReadOnly, Source: source, Store: store, Now: clockAt(now),
			})

			read, err := svc.Read(context.Background(), "", domain.UCTMKindStatus)
			if err != nil {
				t.Fatalf("Read: %v", err)
			}
			if read.Freshness != domain.UCTMFreshnessUnknown || read.Reason != domain.UCTMReasonServiceRejected {
				t.Fatalf("read = %+v, want unknown/service_rejected", read)
			}
			if read.Projection != nil {
				t.Fatal("over-authority projection was displayed")
			}
			if store.upserts != 0 {
				t.Fatalf("over-authority projection was stored %d times", store.upserts)
			}
		})
	}
}

// A durability failure must not deny the fact AO is holding, and must not hide
// itself either: the reason names the gap.
func TestReadNamesAProjectionItCouldNotPersist(t *testing.T) {
	now := time.Date(2026, 9, 18, 12, 0, 0, 0, time.UTC)
	source := &fakeSource{responses: map[domain.UCTMProjectionKind]domain.UCTMSourceResponse{
		domain.UCTMKindStatus: responseFor(`{"facts":[]}`, time.Minute),
	}}
	store := newFakeStore()
	store.upsertErr = errors.New("disk full")
	svc := uctmsvc.New(uctmsvc.Options{Mode: domain.UCTMModeReadOnly, Source: source, Store: store, Now: clockAt(now)})

	read, err := svc.Read(context.Background(), "", domain.UCTMKindStatus)
	if err != nil {
		t.Fatalf("Read: %v", err)
	}
	if read.Freshness != domain.UCTMFreshnessFresh || read.Reason != domain.UCTMReasonProjectionUnpersisted {
		t.Fatalf("read = %+v, want fresh/projection_not_persisted", read)
	}
	if read.Projection == nil {
		t.Fatal("unpersisted read dropped the projection it had already read")
	}
}

func TestReadAppliesTheDefaultTTLWhenTheServiceGrantsNone(t *testing.T) {
	now := time.Date(2026, 9, 18, 12, 0, 0, 0, time.UTC)
	source := &fakeSource{responses: map[domain.UCTMProjectionKind]domain.UCTMSourceResponse{
		domain.UCTMKindEvaluations: responseFor(`{"facts":[]}`, 0),
	}}
	svc := uctmsvc.New(uctmsvc.Options{
		Mode: domain.UCTMModeReadOnly, Source: source, Store: newFakeStore(), Now: clockAt(now),
	})
	read, err := svc.Read(context.Background(), "", domain.UCTMKindEvaluations)
	if err != nil {
		t.Fatalf("Read: %v", err)
	}
	want := now.Add(uctmsvc.DefaultProjectionTTL)
	if !read.Projection.ExpiresAt.Equal(want) {
		t.Fatalf("ExpiresAt = %s, want %s", read.Projection.ExpiresAt, want)
	}
}

func TestReadRejectsAnUnknownKind(t *testing.T) {
	svc := uctmsvc.New(uctmsvc.Options{Mode: domain.UCTMModeReadOnly})
	if _, err := svc.Read(context.Background(), "", domain.UCTMProjectionKind("nope")); err == nil {
		t.Fatal("Read accepted an unknown projection kind")
	}
}

// Shadow mode reads; AO-F2 implements no proposal path, so reading is all it
// does here. The mode must at least be honoured as a read authorisation.
func TestReadShadowModeReads(t *testing.T) {
	source := &fakeSource{responses: map[domain.UCTMProjectionKind]domain.UCTMSourceResponse{
		domain.UCTMKindLanes: responseFor(`{"facts":[]}`, time.Minute),
	}}
	svc := uctmsvc.New(uctmsvc.Options{Mode: domain.UCTMModeShadow, Source: source, Store: newFakeStore()})
	read, err := svc.Read(context.Background(), "", domain.UCTMKindLanes)
	if err != nil {
		t.Fatalf("Read: %v", err)
	}
	if read.Freshness != domain.UCTMFreshnessFresh {
		t.Fatalf("read = %+v, want fresh", read)
	}
	if source.calls != 1 {
		t.Fatalf("source calls = %d", source.calls)
	}
}
