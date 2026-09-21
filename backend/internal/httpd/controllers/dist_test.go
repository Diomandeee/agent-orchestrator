package controllers

import (
	"bytes"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/go-chi/chi/v5"

	dist "github.com/aoagents/agent-orchestrator/backend/internal/service/dist"
)

func testDistRouter(t *testing.T, c *DistController) *chi.Mux {
	t.Helper()
	r := chi.NewRouter()
	c.Register(r)
	return r
}

func doDistReq(t *testing.T, r http.Handler, method, target string, body any, headers map[string]string) *httptest.ResponseRecorder {
	t.Helper()
	var buf bytes.Buffer
	if body != nil {
		if raw, ok := body.([]byte); ok {
			buf.Write(raw)
		} else if err := json.NewEncoder(&buf).Encode(body); err != nil {
			t.Fatal(err)
		}
	}
	req := httptest.NewRequest(method, target, &buf)
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)
	return rec
}

func signDistBody(secret string, body []byte) string {
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write(body)
	return hex.EncodeToString(mac.Sum(nil))
}

func TestDistQueueEmpty(t *testing.T) {
	c := &DistController{Svc: dist.Service{Dir: t.TempDir()}}
	rec := doDistReq(t, testDistRouter(t, c), http.MethodGet, "/dist/queue", nil, nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d: %s", rec.Code, rec.Body.String())
	}
}

func TestDistEnqueueAndStatusPatch(t *testing.T) {
	c := &DistController{Svc: dist.Service{Dir: t.TempDir()}}
	r := testDistRouter(t, c)
	rec := doDistReq(t, r, http.MethodPost, "/dist/enqueue", EnqueueDistRequest{Park: "fleet-app-aura", Caption: "hi"}, nil)
	if rec.Code != http.StatusCreated {
		t.Fatalf("enqueue status = %d: %s", rec.Code, rec.Body.String())
	}
	var created DistItem
	if err := json.Unmarshal(rec.Body.Bytes(), &created); err != nil {
		t.Fatal(err)
	}
	if created.Status != dist.StatusDraft {
		t.Fatalf("status = %q", created.Status)
	}
	rec = doDistReq(t, r, "PATCH", "/dist/items/"+created.ID+"/status", SetDistStatusRequest{Status: "scheduled"}, nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("patch status = %d: %s", rec.Code, rec.Body.String())
	}
	rec = doDistReq(t, r, "PATCH", "/dist/items/"+created.ID+"/status", SetDistStatusRequest{Status: "posted"}, nil)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("posted-via-patch status = %d, want 400", rec.Code)
	}
	rec = doDistReq(t, r, http.MethodPost, "/dist/enqueue", EnqueueDistRequest{}, nil)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("missing-park status = %d, want 400", rec.Code)
	}
}

func TestDistReorder(t *testing.T) {
	svc := dist.Service{Dir: t.TempDir()}
	c := &DistController{Svc: svc}
	r := testDistRouter(t, c)
	a, _ := svc.Enqueue("p1", "a", "", "", "")
	b, _ := svc.Enqueue("p2", "b", "", "", "")
	rec := doDistReq(t, r, http.MethodPost, "/dist/queue/reorder", ReorderDistQueueRequest{IDs: []string{b.ID, a.ID}}, nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("reorder status = %d: %s", rec.Code, rec.Body.String())
	}
	var q DistQueueResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &q); err != nil {
		t.Fatal(err)
	}
	if len(q.Items) != 2 || q.Items[0].ID != b.ID {
		t.Fatalf("order wrong: %+v", q)
	}
}

func TestDistWebhookAuthAndOutcome(t *testing.T) {
	const secret = "test-secret"
	svc := dist.Service{Dir: t.TempDir()}
	c := &DistController{Svc: svc, Secret: secret}
	r := testDistRouter(t, c)
	if _, err := svc.Enqueue("p", "c", "", "", "ds-9"); err != nil {
		t.Fatal(err)
	}
	payload, _ := json.Marshal(DistWebhookRequest{
		Event: "post.succeeded", ExternalID: "ds-9",
		Stats: DistWebhookStats{Views: 10, Likes: 2, Comments: 1},
	})

	// Unsigned is rejected with 401.
	rec := doDistReq(t, r, http.MethodPost, "/dist/webhooks", payload, nil)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("unsigned status = %d, want 401", rec.Code)
	}
	// Wrong secret is rejected with 401.
	rec = doDistReq(t, r, http.MethodPost, "/dist/webhooks", payload,
		map[string]string{"X-DS-Signature": signDistBody("wrong", payload)})
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("bad-sig status = %d, want 401", rec.Code)
	}
	// Unknown external id is 404.
	unknown, _ := json.Marshal(DistWebhookRequest{Event: "post.failed", ExternalID: "ds-missing"})
	rec = doDistReq(t, r, http.MethodPost, "/dist/webhooks", unknown,
		map[string]string{"X-DS-Signature": signDistBody(secret, unknown)})
	if rec.Code != http.StatusNotFound {
		t.Fatalf("unknown external status = %d, want 404: %s", rec.Code, rec.Body.String())
	}
	// Signed match records outcome and stats.
	rec = doDistReq(t, r, http.MethodPost, "/dist/webhooks", payload,
		map[string]string{"X-DS-Signature": signDistBody(secret, payload)})
	if rec.Code != http.StatusOK {
		t.Fatalf("webhook status = %d: %s", rec.Code, rec.Body.String())
	}
	var out DistItem
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		t.Fatal(err)
	}
	if out.Status != dist.StatusPosted || out.Views != 10 || out.Likes != 2 || out.Comments != 1 {
		t.Fatalf("outcome wrong: %+v", out)
	}
}
