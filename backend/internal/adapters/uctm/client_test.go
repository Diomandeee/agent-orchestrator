package uctm_test

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	adaptersuctm "github.com/aoagents/agent-orchestrator/backend/internal/adapters/uctm"
	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
)

func TestValidateBaseURL(t *testing.T) {
	rejected := []struct {
		name string
		raw  string
	}{
		{"empty", ""},
		{"blank", "   "},
		{"no scheme", "127.0.0.1:8010"},
		{"dns name", "http://localhost:8010"},
		{"dns name in a domain", "http://uctm.internal:8010"},
		{"unspecified address", "http://0.0.0.0:8010"},
		{"private lan address", "http://10.0.0.1:8010"},
		{"public address", "http://93.184.216.34:8010"},
		{"missing port", "http://127.0.0.1"},
		{"credentials", "http://user:pass@127.0.0.1:8010"},
		{"path", "http://127.0.0.1:8010/v1"},
		{"query", "http://127.0.0.1:8010?mode=read_only"},
		{"fragment", "http://127.0.0.1:8010#frag"},
		{"other scheme", "ftp://127.0.0.1:8010"},
		{"file scheme", "file:///tmp/uctm.sock"},
	}
	for _, tc := range rejected {
		t.Run("reject "+tc.name, func(t *testing.T) {
			if _, err := adaptersuctm.ValidateBaseURL(tc.raw); err == nil {
				t.Fatalf("ValidateBaseURL(%q) accepted a non-loopback transport", tc.raw)
			}
		})
	}

	accepted := []string{
		"http://127.0.0.1:8010",
		"https://127.0.0.1:8443",
		"http://127.0.0.2:8010",
		"http://[::1]:8010",
		"http://127.0.0.1:8010/",
	}
	for _, raw := range accepted {
		t.Run("accept "+raw, func(t *testing.T) {
			if _, err := adaptersuctm.ValidateBaseURL(raw); err != nil {
				t.Fatalf("ValidateBaseURL(%q) = %v", raw, err)
			}
		})
	}
}

func TestNewClientRequiresToken(t *testing.T) {
	if _, err := adaptersuctm.NewClient(adaptersuctm.Config{BaseURL: "http://127.0.0.1:8010"}); err == nil {
		t.Fatal("NewClient accepted a read transport with no bearer token")
	}
	if _, err := adaptersuctm.NewClient(adaptersuctm.Config{BaseURL: "http://127.0.0.1:8010", Token: "  "}); err == nil {
		t.Fatal("NewClient accepted a blank bearer token")
	}
}

// metadataJSON builds a complete required-metadata block. Tests mutate one field
// at a time so a failure names the field that stopped being enforced.
func metadataJSON(t *testing.T, mutate func(map[string]any)) string {
	t.Helper()
	fields := map[string]any{
		"schema_version":             "uctm.projection.v0",
		"source_commit_or_freeze_id": "20260918-workspace-6",
		"generated_at":               "2026-09-18T12:00:00Z",
		"historical_or_current":      "historical",
		"authority_ceiling":          "interface_read_only",
		"receipt_ref":                "receipt-1",
		"content_hash_or_etag":       `"etag-1"`,
		"payload":                    map[string]any{"facts": []any{}},
	}
	if mutate != nil {
		mutate(fields)
	}
	encoded, err := json.Marshal(fields)
	if err != nil {
		t.Fatalf("marshal response: %v", err)
	}
	return string(encoded)
}

// rawJSON marks a string as already-encoded JSON so the response builder embeds
// it verbatim instead of quoting it.
type rawJSON string

// MarshalJSON satisfies json.Marshaler.
func (r rawJSON) MarshalJSON() ([]byte, error) { return []byte(r), nil }

func newMetadataServer(t *testing.T, mutate func(map[string]any)) *httptest.Server {
	t.Helper()
	body := metadataJSON(t, mutate)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if got := r.Header.Get("Authorization"); got != "Bearer secret-token" {
			t.Errorf("Authorization = %q, want bearer credential", got)
		}
		if got := r.Header.Get("Accept"); got != "application/json" {
			t.Errorf("Accept = %q", got)
		}
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Cache-Control", "max-age=120")
		_, _ = w.Write([]byte(body))
	}))
	t.Cleanup(srv.Close)
	return srv
}

func newClientFor(t *testing.T, server *httptest.Server) *adaptersuctm.Client {
	t.Helper()
	client, err := adaptersuctm.NewClient(adaptersuctm.Config{
		BaseURL: server.URL,
		Token:   "secret-token",
		Timeout: 2 * time.Second,
	})
	if err != nil {
		t.Fatalf("NewClient: %v", err)
	}
	return client
}

func TestClientFetchHappyPath(t *testing.T) {
	srv := newMetadataServer(t, nil)
	client := newClientFor(t, srv)

	resp, err := client.Fetch(context.Background(), domain.UCTMKindStatus)
	if err != nil {
		t.Fatalf("Fetch: %v", err)
	}
	if resp.NoFacts {
		t.Fatal("Fetch reported NoFacts for a real projection")
	}
	if resp.Metadata.SchemaVersion != "uctm.projection.v0" {
		t.Fatalf("schema version = %q", resp.Metadata.SchemaVersion)
	}
	if resp.Metadata.HistoricalOrCurrent != domain.UCTMHistorical {
		t.Fatalf("historicality = %q", resp.Metadata.HistoricalOrCurrent)
	}
	if resp.MaxAge != 120*time.Second {
		t.Fatalf("MaxAge = %s, want 2m from Cache-Control", resp.MaxAge)
	}
	if string(resp.Payload) != `{"facts":[]}` {
		t.Fatalf("payload = %s", resp.Payload)
	}
}

// Every required provenance field is load-bearing: a response missing one is not
// a UCTM fact, and the adapter must not hand AO something it cannot attribute.
func TestClientFetchRejectsIncompleteMetadata(t *testing.T) {
	mutations := map[string]func(map[string]any){
		"schema_version":             func(m map[string]any) { m["schema_version"] = "" },
		"source_commit_or_freeze_id": func(m map[string]any) { delete(m, "source_commit_or_freeze_id") },
		"generated_at":               func(m map[string]any) { m["generated_at"] = "not-a-time" },
		"historical_or_current":      func(m map[string]any) { m["historical_or_current"] = "someday" },
		"authority_ceiling":          func(m map[string]any) { m["authority_ceiling"] = "root" },
		"receipt_ref":                func(m map[string]any) { m["receipt_ref"] = " " },
		"content_hash_or_etag":       func(m map[string]any) { delete(m, "content_hash_or_etag") },
		"payload":                    func(m map[string]any) { m["payload"] = nil },
	}
	for name, mutate := range mutations {
		t.Run(name, func(t *testing.T) {
			srv := newMetadataServer(t, mutate)
			client := newClientFor(t, srv)
			_, err := client.Fetch(context.Background(), domain.UCTMKindStatus)
			if err == nil {
				t.Fatalf("Fetch accepted a response with a broken %s", name)
			}
			var adapterErr *adaptersuctm.Error
			if !errors.As(err, &adapterErr) || adapterErr.Kind != adaptersuctm.ErrorProtocol {
				t.Fatalf("error = %v, want a protocol error", err)
			}
		})
	}
}

// A field AO does not know is a contract change a human has to review. Dropping
// it silently would let a semantic change look like a no-op.
func TestClientFetchRejectsUnknownFields(t *testing.T) {
	srv := newMetadataServer(t, func(m map[string]any) { m["surprise"] = "value" })
	client := newClientFor(t, srv)
	_, err := client.Fetch(context.Background(), domain.UCTMKindStatus)
	var adapterErr *adaptersuctm.Error
	if !errors.As(err, &adapterErr) || adapterErr.Kind != adaptersuctm.ErrorProtocol {
		t.Fatalf("error = %v, want a protocol error for an unknown field", err)
	}
}

func TestClientFetchVerifiesClaimedContentHash(t *testing.T) {
	payload := `{"facts":[1]}`
	sum := sha256.Sum256([]byte(payload))
	good := hex.EncodeToString(sum[:])

	t.Run("matching digest is accepted", func(t *testing.T) {
		srv := newMetadataServer(t, func(m map[string]any) {
			m["payload"] = rawJSON(`{"facts":[1]}`)
			m["content_hash_or_etag"] = "sha256:" + good
		})
		if _, err := newClientFor(t, srv).Fetch(context.Background(), domain.UCTMKindGates); err != nil {
			t.Fatalf("Fetch rejected a matching content hash: %v", err)
		}
	})

	t.Run("mismatched digest fails closed", func(t *testing.T) {
		srv := newMetadataServer(t, func(m map[string]any) {
			m["payload"] = rawJSON(`{"facts":[1]}`)
			m["content_hash_or_etag"] = strings.Repeat("0", 64)
		})
		_, err := newClientFor(t, srv).Fetch(context.Background(), domain.UCTMKindGates)
		var adapterErr *adaptersuctm.Error
		if !errors.As(err, &adapterErr) || adapterErr.Kind != adaptersuctm.ErrorProtocol {
			t.Fatalf("error = %v, want a protocol error for a hash mismatch", err)
		}
	})
}

func TestClientFetchContentTypeAndStatusHandling(t *testing.T) {
	t.Run("204 is an abstention, not an error", func(t *testing.T) {
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			w.WriteHeader(http.StatusNoContent)
		}))
		t.Cleanup(srv.Close)
		resp, err := newClientFor(t, srv).Fetch(context.Background(), domain.UCTMKindStatus)
		if err != nil {
			t.Fatalf("Fetch on 204 = %v", err)
		}
		if !resp.NoFacts {
			t.Fatal("204 did not report NoFacts")
		}
	})

	t.Run("non-JSON content type is refused", func(t *testing.T) {
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			w.Header().Set("Content-Type", "text/html")
			_, _ = w.Write([]byte("<html>proxy</html>"))
		}))
		t.Cleanup(srv.Close)
		_, err := newClientFor(t, srv).Fetch(context.Background(), domain.UCTMKindStatus)
		if err == nil || !strings.Contains(err.Error(), "application/json") {
			t.Fatalf("error = %v, want a content-type refusal", err)
		}
	})

	t.Run("5xx is a status error", func(t *testing.T) {
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			w.WriteHeader(http.StatusInternalServerError)
		}))
		t.Cleanup(srv.Close)
		_, err := newClientFor(t, srv).Fetch(context.Background(), domain.UCTMKindStatus)
		var adapterErr *adaptersuctm.Error
		if !errors.As(err, &adapterErr) || adapterErr.Kind != adaptersuctm.ErrorStatus || adapterErr.StatusCode != 500 {
			t.Fatalf("error = %v, want a status error carrying 500", err)
		}
	})
}

// A redirect is how a loopback-only promise gets broken: the next hop is chosen
// by the peer. It must be refused, not followed.
func TestClientRefusesRedirects(t *testing.T) {
	var reached bool
	other := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		reached = true
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(metadataJSON(t, nil)))
	}))
	t.Cleanup(other.Close)

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, other.URL+"/v1/status", http.StatusFound)
	}))
	t.Cleanup(srv.Close)

	_, err := newClientFor(t, srv).Fetch(context.Background(), domain.UCTMKindStatus)
	if err == nil {
		t.Fatal("Fetch followed a redirect")
	}
	if reached {
		t.Fatal("Fetch reached the redirect target")
	}
}

func TestClientRejectsOversizedResponse(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(strings.Repeat("a", (8<<20)+16)))
	}))
	t.Cleanup(srv.Close)
	_, err := newClientFor(t, srv).Fetch(context.Background(), domain.UCTMKindStatus)
	if err == nil || !strings.Contains(err.Error(), "exceeds") {
		t.Fatalf("error = %v, want an oversized-response refusal", err)
	}
}

func TestClientRefusesUnknownKind(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {}))
	t.Cleanup(srv.Close)
	if _, err := newClientFor(t, srv).Fetch(context.Background(), domain.UCTMProjectionKind("nope")); err == nil {
		t.Fatal("Fetch accepted an unknown projection kind")
	}
}

// An unreachable peer must surface as a transport error so the service can show
// stale/unknown rather than an invented healthy state.
func TestClientUnreachableIsATransportError(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {}))
	base := srv.URL
	srv.Close()

	client, err := adaptersuctm.NewClient(adaptersuctm.Config{BaseURL: base, Token: "t", Timeout: time.Second})
	if err != nil {
		t.Fatalf("NewClient: %v", err)
	}
	_, err = client.Fetch(context.Background(), domain.UCTMKindStatus)
	var adapterErr *adaptersuctm.Error
	if !errors.As(err, &adapterErr) || adapterErr.Kind != adaptersuctm.ErrorTransport {
		t.Fatalf("error = %v, want a transport error", err)
	}
	if strings.Contains(err.Error(), "t") && strings.Contains(err.Error(), "Bearer") {
		t.Fatalf("transport error leaked the bearer header: %v", err)
	}
}

// Cache-Control decides how long AO may serve a projection without asking
// again. An unparseable or ambiguous header must yield no grant, so the caller's
// short default applies instead of a value nobody can justify.
func TestFetchHonoursCacheControlMaxAge(t *testing.T) {
	tests := []struct {
		header string
		want   time.Duration
	}{
		{"max-age=60", time.Minute},
		{"public, max-age=30, immutable", 30 * time.Second},
		{`max-age="45"`, 45 * time.Second},
		{"no-store", 0},
		{"max-age=abc", 0},
		{"max-age=-5", 0},
		{"max-age=10, max-age=20", 0},
	}
	for _, tc := range tests {
		t.Run(tc.header, func(t *testing.T) {
			body := metadataJSON(t, nil)
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				w.Header().Set("Content-Type", "application/json")
				if tc.header != "" {
					w.Header().Set("Cache-Control", tc.header)
				}
				_, _ = w.Write([]byte(body))
			}))
			t.Cleanup(srv.Close)
			resp, err := newClientFor(t, srv).Fetch(context.Background(), domain.UCTMKindStatus)
			if err != nil {
				t.Fatalf("Fetch: %v", err)
			}
			if resp.MaxAge != tc.want {
				t.Fatalf("MaxAge(%q) = %s, want %s", tc.header, resp.MaxAge, tc.want)
			}
		})
	}
}
