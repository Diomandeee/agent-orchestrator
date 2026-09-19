package controllers_test

import (
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	adaptersuctm "github.com/aoagents/agent-orchestrator/backend/internal/adapters/uctm"
	"github.com/aoagents/agent-orchestrator/backend/internal/config"
	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/httpd"
	uctmsvc "github.com/aoagents/agent-orchestrator/backend/internal/service/uctm"
)

type uctmResponseView struct {
	Kind                   string          `json:"kind"`
	Mode                   string          `json:"mode"`
	ProjectID              string          `json:"projectId"`
	Freshness              string          `json:"freshness"`
	Reason                 string          `json:"reason"`
	AuthorityCeiling       string          `json:"authorityCeiling"`
	ReceiptRef             string          `json:"receiptRef"`
	SchemaVersion          string          `json:"schemaVersion"`
	SourceCommitOrFreezeID string          `json:"sourceCommitOrFreezeId"`
	HistoricalOrCurrent    string          `json:"historicalOrCurrent"`
	ContentHashOrETag      string          `json:"contentHashOrEtag"`
	SourceHash             string          `json:"sourceHash"`
	Payload                json.RawMessage `json:"payload"`
}

func newUCTMServer(t *testing.T) (*httptest.Server, *atomic.Int64) {
	t.Helper()
	var hits atomic.Int64
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits.Add(1)
		if r.URL.Path != "/v1/status" {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Cache-Control", "max-age=120")
		_, _ = w.Write([]byte(`{
			"schema_version": "uctm.projection.v0",
			"source_commit_or_freeze_id": "20260918-workspace-6",
			"generated_at": "2026-09-18T12:00:00Z",
			"historical_or_current": "historical",
			"authority_ceiling": "interface_read_only",
			"receipt_ref": "receipt-1",
			"content_hash_or_etag": "\"etag-1\"",
			"payload": {"spine": "not_connected"}
		}`))
	}))
	t.Cleanup(srv.Close)
	return srv, &hits
}

func newUCTMRouter(t *testing.T, cfg config.UCTMConfig) (*httptest.Server, *atomic.Int64) {
	t.Helper()
	source, hits := newUCTMServer(t)
	return newUCTMRouterWithSource(t, cfg, source.URL), hits
}

func newUCTMRouterWithSource(t *testing.T, cfg config.UCTMConfig, baseURL string) *httptest.Server {
	t.Helper()
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	var projectionSvc *uctmsvc.Service
	if cfg.Mode.ReadsEnabled() && baseURL != "" {
		client, err := adaptersuctm.NewClient(adaptersuctm.Config{
			BaseURL: baseURL, Token: "token", Timeout: 2 * time.Second,
		})
		if err != nil {
			t.Fatalf("NewClient: %v", err)
		}
		projectionSvc = uctmsvc.New(uctmsvc.Options{Mode: cfg.Mode, Source: client})
	} else {
		projectionSvc = uctmsvc.New(uctmsvc.Options{Mode: cfg.Mode})
	}
	srv := httptest.NewServer(httpd.NewRouterWithControl(
		config.Config{}, log, nil, httpd.APIDeps{UCTM: projectionSvc}, httpd.ControlDeps{},
	))
	t.Cleanup(srv.Close)
	return srv
}

func decodeUCTM(t *testing.T, body []byte) uctmResponseView {
	t.Helper()
	var view uctmResponseView
	if err := json.Unmarshal(body, &view); err != nil {
		t.Fatalf("decode %s: %v", body, err)
	}
	return view
}

// The whole stack in one journey: a real HTTP peer, the real adapter, the real
// service, and the real route. Nothing here is faked above the socket, so a
// regression in any layer shows up as a wrong display state.
func TestUCTMRouteServesARealProjectionEndToEnd(t *testing.T) {
	srv, hits := newUCTMRouter(t, config.UCTMConfig{Mode: domain.UCTMModeReadOnly})

	body, status, _ := doRequest(t, srv, http.MethodGet, "/api/v1/uctm/status?projectId=uctm-studio", "")
	if status != http.StatusOK {
		t.Fatalf("status = %d; body=%s", status, body)
	}
	view := decodeUCTM(t, body)
	if view.Freshness != "fresh" || view.Reason != "fresh_projection" {
		t.Fatalf("view = %+v, want fresh/fresh_projection", view)
	}
	if view.Mode != "read_only" || view.Kind != "status" || view.ProjectID != "uctm-studio" {
		t.Fatalf("view identity = %+v", view)
	}
	if view.AuthorityCeiling != "interface_read_only" || view.ReceiptRef != "receipt-1" {
		t.Fatalf("provenance missing: %+v", view)
	}
	if view.SourceHash == "" || view.SourceHash != domain.ContentAddress([]byte(`{"spine":"not_connected"}`)) {
		t.Fatalf("sourceHash = %q, want the payload content address", view.SourceHash)
	}
	if string(view.Payload) != `{"spine":"not_connected"}` {
		t.Fatalf("payload = %s", view.Payload)
	}
	if hits.Load() != 1 {
		t.Fatalf("upstream hits = %d, want 1", hits.Load())
	}
}

// Off is a claim about the network, not a label on a response: the route must
// answer, and no packet may leave the daemon.
func TestUCTMRoutesInOffModeNeverReachTheService(t *testing.T) {
	srv, hits := newUCTMRouter(t, config.UCTMConfig{Mode: domain.UCTMModeOff})
	for _, kind := range domain.AllUCTMProjectionKinds {
		body, status, _ := doRequest(t, srv, http.MethodGet, kind.AOFacingPath(), "")
		if status != http.StatusOK {
			t.Fatalf("%s status = %d; body=%s", kind, status, body)
		}
		view := decodeUCTM(t, body)
		if view.Freshness != "disabled" || view.Reason != "mode_off" {
			t.Fatalf("%s = %+v, want disabled/mode_off", kind, view)
		}
		if len(view.Payload) != 0 || view.AuthorityCeiling != "" {
			t.Fatalf("%s carried provenance while disabled: %+v", kind, view)
		}
	}
	if hits.Load() != 0 {
		t.Fatalf("mode off produced %d upstream requests", hits.Load())
	}
}

func TestUCTMRouteReportsAConfiguredButUnwiredTransport(t *testing.T) {
	srv := newUCTMRouterWithSource(t, config.UCTMConfig{Mode: domain.UCTMModeReadOnly}, "")
	body, status, _ := doRequest(t, srv, http.MethodGet, "/api/v1/uctm/gates", "")
	if status != http.StatusOK {
		t.Fatalf("status = %d; body=%s", status, body)
	}
	view := decodeUCTM(t, body)
	if view.Freshness != "unknown" || view.Reason != "transport_not_configured" {
		t.Fatalf("view = %+v, want unknown/transport_not_configured", view)
	}
	if view.Mode != "read_only" {
		t.Fatalf("mode = %q; a misconfigured transport must not silently become off", view.Mode)
	}
}

func TestUCTMRouteReportsAnUnreachableServiceAsUnknown(t *testing.T) {
	dead := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {}))
	base := dead.URL
	dead.Close()

	srv := newUCTMRouterWithSource(t, config.UCTMConfig{Mode: domain.UCTMModeReadOnly}, base)
	body, status, _ := doRequest(t, srv, http.MethodGet, "/api/v1/uctm/families", "")
	if status != http.StatusOK {
		t.Fatalf("status = %d; body=%s", status, body)
	}
	view := decodeUCTM(t, body)
	if view.Freshness != "unknown" || view.Reason != "service_unavailable" {
		t.Fatalf("view = %+v, want unknown/service_unavailable", view)
	}
}

// Every kind in the domain gets a route, and a kind that is not in the domain is
// not routable. The domain list is the single source of the route set.
func TestUCTMRoutesCoverEveryProjectionKind(t *testing.T) {
	srv, _ := newUCTMRouter(t, config.UCTMConfig{Mode: domain.UCTMModeOff})
	for _, kind := range domain.AllUCTMProjectionKinds {
		body, status, _ := doRequest(t, srv, http.MethodGet, kind.AOFacingPath(), "")
		if status != http.StatusOK {
			t.Fatalf("%s status = %d; body=%s", kind.AOFacingPath(), status, body)
		}
		if decodeUCTM(t, body).Kind != string(kind) {
			t.Fatalf("%s reported the wrong kind", kind.AOFacingPath())
		}
	}
	if _, status, _ := doRequest(t, srv, http.MethodGet, "/api/v1/uctm/not_a_kind", ""); status != http.StatusNotFound {
		t.Fatalf("unknown kind status = %d, want 404", status)
	}
}

// A daemon built without the UCTM service wired must say so per route. The
// OpenAPI operation has to exist for that answer to be possible at all, which is
// what keeps "unwired" distinguishable from "route deleted".
func TestUCTMRoutesAnswerNotImplementedWithoutAService(t *testing.T) {
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	srv := httptest.NewServer(httpd.NewRouterWithControl(config.Config{}, log, nil, httpd.APIDeps{}, httpd.ControlDeps{}))
	t.Cleanup(srv.Close)

	for _, kind := range domain.AllUCTMProjectionKinds {
		body, status, _ := doRequest(t, srv, http.MethodGet, kind.AOFacingPath(), "")
		if status != http.StatusNotImplemented {
			t.Fatalf("%s status = %d, want 501; body=%s", kind.AOFacingPath(), status, body)
		}
		if !strings.Contains(string(body), "NOT_IMPLEMENTED") {
			t.Fatalf("%s body = %s", kind.AOFacingPath(), body)
		}
	}
}
