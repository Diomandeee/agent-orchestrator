package daemon

import (
	"context"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/config"
	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
)

func discardLogger() *slog.Logger { return slog.New(slog.NewTextHandler(io.Discard, nil)) }

func TestWireUCTMProjectionOffModeReadsNothing(t *testing.T) {
	svc := wireUCTMProjection(config.UCTMConfig{Mode: domain.UCTMModeOff}, nil, discardLogger())
	read, err := svc.Read(context.Background(), "", domain.UCTMKindStatus)
	if err != nil {
		t.Fatalf("Read: %v", err)
	}
	if read.Freshness != domain.UCTMFreshnessDisabled || read.Reason != domain.UCTMReasonModeOff {
		t.Fatalf("read = %+v, want disabled/mode_off", read)
	}
}

func TestWireUCTMProjectionReadsThroughAQualifiedTransport(t *testing.T) {
	var hits atomic.Int64
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		hits.Add(1)
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{
			"schema_version": "uctm.projection.v0",
			"source_commit_or_freeze_id": "freeze-1",
			"generated_at": "2026-09-18T12:00:00Z",
			"historical_or_current": "current",
			"authority_ceiling": "interface_read_only",
			"receipt_ref": "receipt-1",
			"content_hash_or_etag": "\"etag-1\"",
			"payload": {"spine": "not_connected"}
		}`))
	}))
	t.Cleanup(upstream.Close)

	svc := wireUCTMProjection(config.UCTMConfig{
		Mode: domain.UCTMModeReadOnly, BaseURL: upstream.URL, Token: "secret", Timeout: 2 * time.Second,
	}, nil, discardLogger())

	read, err := svc.Read(context.Background(), "", domain.UCTMKindStatus)
	if err != nil {
		t.Fatalf("Read: %v", err)
	}
	if read.Freshness != domain.UCTMFreshnessFresh {
		t.Fatalf("read = %+v, want fresh", read)
	}
	if hits.Load() != 1 {
		t.Fatalf("upstream hits = %d, want 1", hits.Load())
	}
}

// A transport AO cannot prove is loopback must fail closed without taking the
// harness down: reads stop, the configured mode stays visible, and the display
// names the misconfiguration instead of pretending the integration is off.
func TestWireUCTMProjectionRefusesAnUnqualifiedTransport(t *testing.T) {
	rejected := map[string]config.UCTMConfig{
		"dns name":        {Mode: domain.UCTMModeReadOnly, BaseURL: "http://uctm.internal:8010", Token: "secret"},
		"lan address":     {Mode: domain.UCTMModeReadOnly, BaseURL: "http://10.0.0.4:8010", Token: "secret"},
		"missing token":   {Mode: domain.UCTMModeReadOnly, BaseURL: "http://127.0.0.1:8010"},
		"missing base":    {Mode: domain.UCTMModeReadOnly, Token: "secret"},
		"path on base":    {Mode: domain.UCTMModeReadOnly, BaseURL: "http://127.0.0.1:8010/v1", Token: "secret"},
		"no port":         {Mode: domain.UCTMModeReadOnly, BaseURL: "http://127.0.0.1", Token: "secret"},
		"shadow mode too": {Mode: domain.UCTMModeShadow, BaseURL: "http://uctm.internal:8010", Token: "secret"},
	}
	for name, cfg := range rejected {
		t.Run(name, func(t *testing.T) {
			svc := wireUCTMProjection(cfg, nil, discardLogger())
			if svc.Mode() != cfg.Mode {
				t.Fatalf("mode = %q, want the configured %q preserved", svc.Mode(), cfg.Mode)
			}
			read, err := svc.Read(context.Background(), "", domain.UCTMKindStatus)
			if err != nil {
				t.Fatalf("Read: %v", err)
			}
			if read.Freshness != domain.UCTMFreshnessUnknown || read.Reason != domain.UCTMReasonTransportNotConfigured {
				t.Fatalf("read = %+v, want unknown/transport_not_configured", read)
			}
			if read.Projection != nil {
				t.Fatal("an unwired transport produced a projection")
			}
		})
	}
}

// Modes that authorise no read must not construct a transport at all: a client
// built and then ignored is one refactor away from being used.
func TestWireUCTMProjectionBuildsNoTransportWithoutReads(t *testing.T) {
	for _, mode := range []domain.UCTMMode{domain.UCTMModeOff, domain.UCTMModeHumanGated, domain.UCTMMode("")} {
		svc := wireUCTMProjection(config.UCTMConfig{
			Mode: mode, BaseURL: "http://127.0.0.1:8010", Token: "secret",
		}, nil, discardLogger())
		read, err := svc.Read(context.Background(), "", domain.UCTMKindStatus)
		if err != nil {
			t.Fatalf("Read: %v", err)
		}
		if read.Freshness != domain.UCTMFreshnessDisabled {
			t.Fatalf("mode %q read = %+v, want disabled", mode, read)
		}
	}
}
