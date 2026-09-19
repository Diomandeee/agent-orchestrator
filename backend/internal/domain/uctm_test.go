package domain_test

import (
	"testing"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
)

func TestParseUCTMMode(t *testing.T) {
	tests := []struct {
		name    string
		raw     string
		want    domain.UCTMMode
		wantErr bool
	}{
		{name: "unset is off, never on", raw: "", want: domain.UCTMModeOff},
		{name: "whitespace is off", raw: "   ", want: domain.UCTMModeOff},
		{name: "read_only", raw: "read_only", want: domain.UCTMModeReadOnly},
		{name: "shadow", raw: "shadow", want: domain.UCTMModeShadow},
		{name: "human_gated", raw: "human_gated", want: domain.UCTMModeHumanGated},
		{name: "typo is rejected", raw: "readonly", wantErr: true},
		{name: "on is not a mode", raw: "on", wantErr: true},
		{name: "case is significant", raw: "READ_ONLY", wantErr: true},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got, err := domain.ParseUCTMMode(tc.raw)
			if tc.wantErr {
				if err == nil {
					t.Fatalf("ParseUCTMMode(%q) = %q, want error", tc.raw, got)
				}
				return
			}
			if err != nil {
				t.Fatalf("ParseUCTMMode(%q) error = %v", tc.raw, err)
			}
			if got != tc.want {
				t.Fatalf("ParseUCTMMode(%q) = %q, want %q", tc.raw, got, tc.want)
			}
		})
	}
}

func TestUCTMModeReadsEnabled(t *testing.T) {
	enabled := map[domain.UCTMMode]bool{
		domain.UCTMModeOff:        false,
		domain.UCTMModeReadOnly:   true,
		domain.UCTMModeShadow:     true,
		domain.UCTMModeHumanGated: false,
		domain.UCTMMode(""):       false,
	}
	for mode, want := range enabled {
		if got := mode.ReadsEnabled(); got != want {
			t.Errorf("%q.ReadsEnabled() = %v, want %v", mode, got, want)
		}
	}
}

// A ceiling AO cannot bound must be treated as wider than AO's authority, not
// narrower: an unrecognised label is exactly the case where guessing is worst.
func TestAuthorityCeilingPermittedBy(t *testing.T) {
	tests := []struct {
		ceiling domain.UCTMAuthorityCeiling
		mode    domain.UCTMMode
		want    bool
	}{
		{domain.UCTMCeilingReadOnly, domain.UCTMModeReadOnly, true},
		{domain.UCTMCeilingReadOnly, domain.UCTMModeShadow, true},
		{domain.UCTMCeilingProposalOnly, domain.UCTMModeReadOnly, false},
		{domain.UCTMCeilingTraining, domain.UCTMModeReadOnly, false},
		{domain.UCTMCeilingDownstreamEffect, domain.UCTMModeShadow, false},
		{domain.UCTMCeilingReadOnly, domain.UCTMModeOff, false},
		{domain.UCTMAuthorityCeiling("root"), domain.UCTMModeReadOnly, false},
		{domain.UCTMAuthorityCeiling(""), domain.UCTMModeReadOnly, false},
	}
	for _, tc := range tests {
		if got := tc.ceiling.PermittedBy(tc.mode); got != tc.want {
			t.Errorf("%q.PermittedBy(%q) = %v, want %v", tc.ceiling, tc.mode, got, tc.want)
		}
	}
}

func TestUCTMWireMetadataValidate(t *testing.T) {
	complete := domain.UCTMWireMetadata{
		SchemaVersion:          "uctm.projection.v0",
		SourceCommitOrFreezeID: "20260918-workspace-6",
		GeneratedAt:            time.Date(2026, 9, 18, 12, 0, 0, 0, time.UTC),
		HistoricalOrCurrent:    domain.UCTMHistorical,
		AuthorityCeiling:       domain.UCTMCeilingReadOnly,
		ReceiptRef:             "receipt-1",
		ContentHashOrETag:      "\"abc\"",
	}
	if err := complete.Validate(); err != nil {
		t.Fatalf("complete metadata rejected: %v", err)
	}
	if err := complete.CheckAuthority(domain.UCTMModeReadOnly); err != nil {
		t.Fatalf("read-only ceiling refused in read_only mode: %v", err)
	}

	blank := func(mutate func(*domain.UCTMWireMetadata)) domain.UCTMWireMetadata {
		out := complete
		mutate(&out)
		return out
	}
	missing := []struct {
		name string
		meta domain.UCTMWireMetadata
	}{
		{"schema_version", blank(func(m *domain.UCTMWireMetadata) { m.SchemaVersion = " " })},
		{"source_commit_or_freeze_id", blank(func(m *domain.UCTMWireMetadata) { m.SourceCommitOrFreezeID = "" })},
		{"generated_at", blank(func(m *domain.UCTMWireMetadata) { m.GeneratedAt = time.Time{} })},
		{"historical_or_current", blank(func(m *domain.UCTMWireMetadata) { m.HistoricalOrCurrent = "someday" })},
		{"authority_ceiling", blank(func(m *domain.UCTMWireMetadata) { m.AuthorityCeiling = "root" })},
		{"receipt_ref", blank(func(m *domain.UCTMWireMetadata) { m.ReceiptRef = "" })},
		{"content_hash_or_etag", blank(func(m *domain.UCTMWireMetadata) { m.ContentHashOrETag = "" })},
	}
	for _, tc := range missing {
		t.Run(tc.name, func(t *testing.T) {
			if err := tc.meta.Validate(); err == nil {
				t.Fatalf("metadata missing %s was accepted", tc.name)
			}
		})
	}
}

func TestUCTMProjectionRecordFreshnessAt(t *testing.T) {
	observed := time.Date(2026, 9, 18, 12, 0, 0, 0, time.UTC)
	fresh := domain.UCTMProjectionRecord{ObservedAt: observed, ExpiresAt: observed.Add(time.Minute)}
	if got := fresh.FreshnessAt(observed.Add(30 * time.Second)); got != domain.UCTMFreshnessFresh {
		t.Errorf("inside window = %q, want fresh", got)
	}
	if got := fresh.FreshnessAt(observed.Add(time.Minute)); got != domain.UCTMFreshnessStale {
		t.Errorf("at expiry = %q, want stale", got)
	}
	if got := fresh.FreshnessAt(observed.Add(2 * time.Minute)); got != domain.UCTMFreshnessStale {
		t.Errorf("past expiry = %q, want stale", got)
	}
	zero := domain.UCTMProjectionRecord{}
	if got := zero.FreshnessAt(observed); got != domain.UCTMFreshnessStale {
		t.Errorf("zero record = %q, want stale", got)
	}
}

func TestContentAddressStability(t *testing.T) {
	a := domain.ContentAddress([]byte(`{"a":1}`))
	b := domain.ContentAddress([]byte(`{"a":1}`))
	if a != b {
		t.Fatalf("content address is not stable: %q vs %q", a, b)
	}
	if !domain.ValidContentAddress(a) {
		t.Fatalf("content address %q is not valid", a)
	}
	if domain.ValidContentAddress("short") || domain.ValidContentAddress(a+"00") {
		t.Fatal("malformed content addresses accepted")
	}
	if domain.ContentAddress([]byte(`{"a":1}`)) == domain.ContentAddress([]byte(`{"a":2}`)) {
		t.Fatal("different payloads share a content address")
	}
}

func TestUCTMProjectionKindPaths(t *testing.T) {
	for _, kind := range domain.AllUCTMProjectionKinds {
		if !kind.Valid() {
			t.Errorf("%q is in AllUCTMProjectionKinds but not Valid()", kind)
		}
		if kind.AOFacingPath() != "/api/v1/uctm/"+kind.RouteSegment() {
			t.Errorf("%q route and path disagree: %q", kind, kind.AOFacingPath())
		}
	}
	if got := domain.UCTMKindAdjudicationQueue.ServicePath(); got != "/v1/adjudication/queue" {
		t.Errorf("adjudication queue service path = %q", got)
	}
	if got := domain.UCTMKindStatus.ServicePath(); got != "/v1/status" {
		t.Errorf("status service path = %q", got)
	}
	if domain.UCTMProjectionKind("nope").Valid() {
		t.Error("unknown kind reported valid")
	}
}
