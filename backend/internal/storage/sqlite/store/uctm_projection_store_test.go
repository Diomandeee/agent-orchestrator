package store_test

import (
	"context"
	"testing"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
)

func sampleUCTMProjection(payload string, observed time.Time) domain.UCTMProjectionRecord {
	return domain.UCTMProjectionRecord{
		ProjectID:   "proj",
		Kind:        domain.UCTMKindStatus,
		SourceHash:  domain.ContentAddress([]byte(payload)),
		PayloadJSON: []byte(payload),
		Metadata: domain.UCTMWireMetadata{
			SchemaVersion:          "uctm.projection.v0",
			SourceCommitOrFreezeID: "freeze-1",
			GeneratedAt:            observed.Add(-time.Second),
			HistoricalOrCurrent:    domain.UCTMHistorical,
			AuthorityCeiling:       domain.UCTMCeilingReadOnly,
			ReceiptRef:             "receipt-1",
			ContentHashOrETag:      `"etag-1"`,
		},
		ObservedAt: observed,
		ExpiresAt:  observed.Add(time.Minute),
	}
}

func TestUCTMProjectionStoreUpsertAndRead(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()
	observed := time.Date(2026, 9, 18, 12, 0, 0, 0, time.UTC)

	changed, err := s.UpsertUCTMProjection(ctx, sampleUCTMProjection(`{"facts":[]}`, observed))
	if err != nil {
		t.Fatalf("UpsertUCTMProjection: %v", err)
	}
	if !changed {
		t.Fatal("first write did not report a content change")
	}

	record, found, err := s.GetUCTMProjection(ctx, "proj", domain.UCTMKindStatus, "")
	if err != nil || !found {
		t.Fatalf("GetUCTMProjection found=%v err=%v", found, err)
	}
	if string(record.PayloadJSON) != `{"facts":[]}` {
		t.Fatalf("payload = %s", record.PayloadJSON)
	}
	if record.Metadata.ReceiptRef != "receipt-1" || record.Metadata.AuthorityCeiling != domain.UCTMCeilingReadOnly {
		t.Fatalf("provenance did not round-trip: %+v", record.Metadata)
	}
	if !record.ObservedAt.Equal(observed) || !record.ExpiresAt.Equal(observed.Add(time.Minute)) {
		t.Fatalf("window did not round-trip: %s..%s", record.ObservedAt, record.ExpiresAt)
	}

	// Identical content written again is a refresh, not a change: this is what
	// makes a projection content-addressed instead of append-only.
	changed, err = s.UpsertUCTMProjection(ctx, sampleUCTMProjection(`{"facts":[]}`, observed.Add(30*time.Second)))
	if err != nil {
		t.Fatalf("second upsert: %v", err)
	}
	if changed {
		t.Fatal("re-writing identical content reported a change")
	}
	refreshed, _, err := s.GetUCTMProjection(ctx, "proj", domain.UCTMKindStatus, "")
	if err != nil {
		t.Fatalf("GetUCTMProjection: %v", err)
	}
	if !refreshed.ObservedAt.Equal(observed.Add(30 * time.Second)) {
		t.Fatalf("refresh did not advance the window: %s", refreshed.ObservedAt)
	}

	changed, err = s.UpsertUCTMProjection(ctx, sampleUCTMProjection(`{"facts":[1]}`, observed.Add(time.Minute)))
	if err != nil {
		t.Fatalf("third upsert: %v", err)
	}
	if !changed {
		t.Fatal("changed content did not report a change")
	}
	list, err := s.ListUCTMProjections(ctx, "proj")
	if err != nil {
		t.Fatalf("ListUCTMProjections: %v", err)
	}
	if len(list) != 1 {
		t.Fatalf("list length = %d, want 1 (upsert must not append)", len(list))
	}
}

func TestUCTMProjectionStoreNamespaceIsolation(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()
	observed := time.Date(2026, 9, 18, 12, 0, 0, 0, time.UTC)

	global := sampleUCTMProjection(`{"facts":[]}`, observed)
	global.ProjectID = ""
	if _, err := s.UpsertUCTMProjection(ctx, global); err != nil {
		t.Fatalf("upsert global projection: %v", err)
	}
	if _, err := s.UpsertUCTMProjection(ctx, sampleUCTMProjection(`{"facts":[]}`, observed)); err != nil {
		t.Fatalf("upsert namespaced projection: %v", err)
	}

	if _, found, err := s.GetUCTMProjection(ctx, "", domain.UCTMKindStatus, ""); err != nil || !found {
		t.Fatalf("global projection found=%v err=%v", found, err)
	}
	if _, found, err := s.GetUCTMProjection(ctx, "other", domain.UCTMKindStatus, ""); err != nil || found {
		t.Fatalf("unmapped namespace found=%v err=%v, want miss", found, err)
	}

	deleted, err := s.DeleteUCTMProjections(ctx, "proj", domain.UCTMKindStatus)
	if err != nil || deleted != 1 {
		t.Fatalf("DeleteUCTMProjections deleted=%d err=%v", deleted, err)
	}
	if _, found, _ := s.GetUCTMProjection(ctx, "", domain.UCTMKindStatus, ""); !found {
		t.Fatal("deleting one namespace removed another")
	}
}

// An unsound projection row is refused at the write boundary, so no later read
// has to re-check whether what it is displaying is a fact.
func TestUCTMProjectionStoreRejectsUnsoundRows(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()
	observed := time.Date(2026, 9, 18, 12, 0, 0, 0, time.UTC)

	bad := map[string]func(*domain.UCTMProjectionRecord){
		"unknown kind":      func(r *domain.UCTMProjectionRecord) { r.Kind = "nope" },
		"malformed address": func(r *domain.UCTMProjectionRecord) { r.SourceHash = "short" },
		"address mismatch":  func(r *domain.UCTMProjectionRecord) { r.SourceHash = domain.ContentAddress([]byte(`{}`)) },
		"invalid json": func(r *domain.UCTMProjectionRecord) {
			r.PayloadJSON = []byte(`{`)
			r.SourceHash = domain.ContentAddress(r.PayloadJSON)
		},
		"missing provenance": func(r *domain.UCTMProjectionRecord) { r.Metadata.ReceiptRef = "" },
		"unknown ceiling":    func(r *domain.UCTMProjectionRecord) { r.Metadata.AuthorityCeiling = "root" },
		"zero window":        func(r *domain.UCTMProjectionRecord) { r.ObservedAt = time.Time{} },
		"inverted window": func(r *domain.UCTMProjectionRecord) {
			r.ExpiresAt = r.ObservedAt.Add(-time.Minute)
		},
	}
	for name, mutate := range bad {
		t.Run(name, func(t *testing.T) {
			record := sampleUCTMProjection(`{"facts":[]}`, observed)
			mutate(&record)
			if _, err := s.UpsertUCTMProjection(ctx, record); err == nil {
				t.Fatalf("store accepted a projection with %s", name)
			}
			if _, found, _ := s.GetUCTMProjection(ctx, "proj", domain.UCTMKindStatus, ""); found {
				t.Fatalf("rejected projection with %s was persisted anyway", name)
			}
		})
	}
}
