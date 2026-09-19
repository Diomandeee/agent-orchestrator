package httpd

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

// UCTM projections describe protected-history governance. The v0/v1 contract
// keeps them on the loopback listener, so the LAN listener must answer as if the
// prefix were never mounted — not with a 403 that confirms it exists.
func TestLANListenerBlocksUCTMRoutes(t *testing.T) {
	blocked := []string{
		"/api/v1/uctm",
		"/api/v1/uctm/",
		"/api/v1/uctm/status",
		"/api/v1/uctm/adjudication/queue",
		"/api/v1/uctm/receipts",
	}
	for _, path := range blocked {
		if !isLANControlBlockedPath(path) {
			t.Errorf("LAN listener would expose %s", path)
		}
	}

	// The block is segment-exact: a sibling path that merely starts with the
	// same characters is a different route and must stay reachable.
	allowed := []string{"/api/v1/uctmish", "/api/v1/uctm-extra", "/api/v1/uctm_x"}
	for _, path := range allowed {
		if isLANControlBlockedPath(path) {
			t.Errorf("LAN block swallowed the unrelated path %s", path)
		}
	}
}

func TestUCTMBlockedOnLANTransportNotJustByPath(t *testing.T) {
	inner := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("mounted"))
	})
	handler := lanControlBlock(inner)

	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/v1/uctm/status", nil))
	if rec.Code != http.StatusNotFound {
		t.Fatalf("status = %d, want 404 for a UCTM route on the LAN listener", rec.Code)
	}
	if body := rec.Body.String(); body == "mounted" {
		t.Fatal("UCTM route reached the shared router through the LAN listener")
	}

	ok := httptest.NewRecorder()
	handler.ServeHTTP(ok, httptest.NewRequest(http.MethodGet, "/api/v1/uctmish", nil))
	if ok.Code != http.StatusOK {
		t.Fatalf("unrelated path status = %d, want 200", ok.Code)
	}
}
