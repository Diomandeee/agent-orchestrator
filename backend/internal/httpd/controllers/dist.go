package controllers

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io"
	"net/http"
	"os"
	"strings"

	"github.com/go-chi/chi/v5"

	"github.com/aoagents/agent-orchestrator/backend/internal/httpd/apierr"
	"github.com/aoagents/agent-orchestrator/backend/internal/httpd/apispec"
	"github.com/aoagents/agent-orchestrator/backend/internal/httpd/envelope"
	dist "github.com/aoagents/agent-orchestrator/backend/internal/service/dist"
)

// DistService is the controller-facing distribution-queue contract,
// satisfied by dist.Service.
type DistService interface {
	List() []dist.DistItem
	Enqueue(park, caption, scheduledAt, provider, externalID string) (dist.DistItem, error)
	SetStatus(id, status string) (dist.DistItem, error)
	Reorder(ids []string) ([]dist.DistItem, error)
	ApplyWebhook(event, externalID string, st dist.Stats) (dist.DistItem, error)
}

// DistItemIDParam names the distribution-item path parameter.
type DistItemIDParam struct {
	ID string `path:"id" description:"Distribution item identifier."`
}

// DistItem is one queued distribution post.
type DistItem struct {
	ID          string `json:"id"`
	Park        string `json:"park"`
	Caption     string `json:"caption"`
	Status      string `json:"status" description:"Lifecycle state: draft, scheduled, posted, linked, or failed."`
	ScheduledAt string `json:"scheduled_at,omitempty"`
	Views       int    `json:"views"`
	Likes       int    `json:"likes"`
	Comments    int    `json:"comments"`
	Provider    string `json:"provider" description:"Distribution provider: doublespeed or farm."`
	ExternalID  string `json:"external_id,omitempty"`
}

// EnqueueDistRequest creates a draft distribution item.
type EnqueueDistRequest struct {
	Park        string `json:"park"`
	Caption     string `json:"caption,omitempty"`
	ScheduledAt string `json:"scheduled_at,omitempty"`
	Provider    string `json:"provider,omitempty" description:"Distribution provider: doublespeed or farm. Defaults to doublespeed."`
	ExternalID  string `json:"external_id,omitempty" description:"Provider post id when already known; webhooks match on it."`
}

// SetDistStatusRequest moves an item between draft and scheduled.
type SetDistStatusRequest struct {
	Status string `json:"status" description:"Target state: draft or scheduled."`
}

// ReorderDistQueueRequest replaces the queue firing order.
type ReorderDistQueueRequest struct {
	IDs []string `json:"ids" description:"Item ids in the new firing order; must list every item exactly once."`
}

// DistWebhookStats carries provider-reported engagement counters.
type DistWebhookStats struct {
	Views    int `json:"views,omitempty"`
	Likes    int `json:"likes,omitempty"`
	Comments int `json:"comments,omitempty"`
}

// DistWebhookRequest records a provider outcome for a posted item.
type DistWebhookRequest struct {
	Event      string           `json:"event" description:"Provider event: post.succeeded, post.failed, or post.linked."`
	ExternalID string           `json:"external_id"`
	Stats      DistWebhookStats `json:"stats,omitempty"`
}

// DistQueueResponse is the queue in firing order.
type DistQueueResponse struct {
	Items []DistItem `json:"items"`
}

// DistController owns the distribution-lane routes.
type DistController struct {
	Svc DistService
	// Secret overrides DIST_WEBHOOK_SECRET in tests.
	Secret string
}

func (c *DistController) webhookSecret() string {
	if c.Secret != "" {
		return c.Secret
	}
	return os.Getenv("DIST_WEBHOOK_SECRET")
}

// Register mounts the distribution-lane routes.
func (c *DistController) Register(r chi.Router) {
	r.Get("/dist/queue", c.queue)
	r.Post("/dist/enqueue", c.enqueue)
	r.Patch("/dist/items/{id}/status", c.setStatus)
	r.Post("/dist/queue/reorder", c.reorder)
	r.Post("/dist/webhooks", c.webhook)
}

func toDistItem(it dist.DistItem) DistItem {
	return DistItem{
		ID: it.ID, Park: it.Park, Caption: it.Caption, Status: it.Status,
		ScheduledAt: it.ScheduledAt, Views: it.Views, Likes: it.Likes,
		Comments: it.Comments, Provider: it.Provider, ExternalID: it.ExternalID,
	}
}

func (c *DistController) queue(w http.ResponseWriter, r *http.Request) {
	if c.Svc == nil {
		apispec.NotImplemented(w, r, http.MethodGet, "/api/v1/dist/queue")
		return
	}
	items := c.Svc.List()
	out := make([]DistItem, 0, len(items))
	for _, it := range items {
		out = append(out, toDistItem(it))
	}
	envelope.WriteJSON(w, http.StatusOK, DistQueueResponse{Items: out})
}

func (c *DistController) enqueue(w http.ResponseWriter, r *http.Request) {
	if c.Svc == nil {
		apispec.NotImplemented(w, r, http.MethodPost, "/api/v1/dist/enqueue")
		return
	}
	var req EnqueueDistRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		envelope.WriteAPIError(w, r, http.StatusBadRequest, "bad_request", "INVALID_JSON", "Invalid JSON body", nil)
		return
	}
	if strings.TrimSpace(req.Park) == "" {
		envelope.WriteError(w, r, apierr.Invalid("MISSING_PARK", "park is required", nil))
		return
	}
	it, err := c.Svc.Enqueue(req.Park, req.Caption, req.ScheduledAt, req.Provider, req.ExternalID)
	if err != nil {
		envelope.WriteError(w, r, apierr.Invalid("INVALID_DIST_ITEM", err.Error(), nil))
		return
	}
	envelope.WriteJSON(w, http.StatusCreated, toDistItem(it))
}

func (c *DistController) setStatus(w http.ResponseWriter, r *http.Request) {
	if c.Svc == nil {
		apispec.NotImplemented(w, r, "PATCH", "/api/v1/dist/items/{id}/status")
		return
	}
	var req SetDistStatusRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		envelope.WriteAPIError(w, r, http.StatusBadRequest, "bad_request", "INVALID_JSON", "Invalid JSON body", nil)
		return
	}
	if req.Status != dist.StatusDraft && req.Status != dist.StatusScheduled {
		envelope.WriteError(w, r, apierr.Invalid("INVALID_DIST_STATUS", "status must be draft or scheduled", nil))
		return
	}
	it, err := c.Svc.SetStatus(chi.URLParam(r, "id"), req.Status)
	if err != nil {
		if strings.HasPrefix(err.Error(), "unknown dist item") {
			envelope.WriteError(w, r, apierr.NotFound("DIST_ITEM_NOT_FOUND", "Unknown distribution item"))
			return
		}
		envelope.WriteError(w, r, apierr.Invalid("INVALID_DIST_STATUS", err.Error(), nil))
		return
	}
	envelope.WriteJSON(w, http.StatusOK, toDistItem(it))
}

func (c *DistController) reorder(w http.ResponseWriter, r *http.Request) {
	if c.Svc == nil {
		apispec.NotImplemented(w, r, http.MethodPost, "/api/v1/dist/queue/reorder")
		return
	}
	var req ReorderDistQueueRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		envelope.WriteAPIError(w, r, http.StatusBadRequest, "bad_request", "INVALID_JSON", "Invalid JSON body", nil)
		return
	}
	items, err := c.Svc.Reorder(req.IDs)
	if err != nil {
		envelope.WriteError(w, r, apierr.Invalid("INVALID_DIST_ORDER", err.Error(), nil))
		return
	}
	out := make([]DistItem, 0, len(items))
	for _, it := range items {
		out = append(out, toDistItem(it))
	}
	envelope.WriteJSON(w, http.StatusOK, DistQueueResponse{Items: out})
}

// verifyWebhookSignature checks the X-DS-Signature header against an
// HMAC-SHA256 of the raw body. The header carries hex, with or without a
// "sha256=" prefix.
func verifyWebhookSignature(secret string, body []byte, sig string) bool {
	if secret == "" || sig == "" {
		return false
	}
	sig = strings.TrimPrefix(sig, "sha256=")
	want, err := hex.DecodeString(sig)
	if err != nil {
		return false
	}
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write(body)
	return hmac.Equal(mac.Sum(nil), want)
}

func (c *DistController) webhook(w http.ResponseWriter, r *http.Request) {
	if c.Svc == nil {
		apispec.NotImplemented(w, r, http.MethodPost, "/api/v1/dist/webhooks")
		return
	}
	body, err := io.ReadAll(r.Body)
	if err != nil {
		envelope.WriteAPIError(w, r, http.StatusBadRequest, "bad_request", "INVALID_JSON", "Invalid JSON body", nil)
		return
	}
	if !verifyWebhookSignature(c.webhookSecret(), body, r.Header.Get("X-DS-Signature")) {
		envelope.WriteAPIError(w, r, http.StatusUnauthorized, "unauthorized", "INVALID_WEBHOOK_SIGNATURE", "Missing or invalid webhook signature", nil)
		return
	}
	var req DistWebhookRequest
	if err := json.Unmarshal(body, &req); err != nil {
		envelope.WriteAPIError(w, r, http.StatusBadRequest, "bad_request", "INVALID_JSON", "Invalid JSON body", nil)
		return
	}
	switch req.Event {
	case dist.EventSucceeded, dist.EventFailed, dist.EventLinked:
	default:
		envelope.WriteError(w, r, apierr.Invalid("INVALID_WEBHOOK_EVENT", "event must be post.succeeded, post.failed, or post.linked", nil))
		return
	}
	if strings.TrimSpace(req.ExternalID) == "" {
		envelope.WriteError(w, r, apierr.Invalid("MISSING_EXTERNAL_ID", "external_id is required", nil))
		return
	}
	it, err := c.Svc.ApplyWebhook(req.Event, req.ExternalID, dist.Stats{
		Views: req.Stats.Views, Likes: req.Stats.Likes, Comments: req.Stats.Comments,
	})
	if err != nil {
		if strings.HasPrefix(err.Error(), "no dist item") {
			envelope.WriteError(w, r, apierr.NotFound("DIST_ITEM_NOT_FOUND", "No distribution item matches external_id"))
			return
		}
		envelope.WriteError(w, r, apierr.Invalid("INVALID_WEBHOOK", err.Error(), nil))
		return
	}
	envelope.WriteJSON(w, http.StatusOK, toDistItem(it))
}
