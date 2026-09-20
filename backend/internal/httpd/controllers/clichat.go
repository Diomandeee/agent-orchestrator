package controllers

import (
	"encoding/json"
	"net/http"
	"strconv"

	"github.com/go-chi/chi/v5"

	"github.com/aoagents/agent-orchestrator/backend/internal/httpd/apierr"
	"github.com/aoagents/agent-orchestrator/backend/internal/httpd/apispec"
	"github.com/aoagents/agent-orchestrator/backend/internal/httpd/envelope"
	"github.com/aoagents/agent-orchestrator/backend/internal/service/clichat"
)

// CLICLIChatService is the controller-facing read-only CLI session contract.
// The store is the UCTM CLI session directory; the daemon never writes it.
type CLICLIChatService interface {
	List() []clichat.Summary
	Transcript(id string, limit int) (clichat.Transcript, bool)
}

// CLISessionIDParam names the CLI session path parameter.
type CLISessionIDParam struct {
	ID string `path:"id" description:"CLI session identifier (filename stem)."`
}

// CLITranscriptQuery carries the transcript cap.
type CLITranscriptQuery struct {
	Limit int `query:"limit,omitempty" description:"Max events newest-first. Defaults to the 200-event cap."`
}

// CLISessionSummary is one CLI session rendered for the dashboard.
type CLISessionSummary struct {
	ID             string `json:"id"`
	Display        string `json:"display"`
	MessageCount   int    `json:"messageCount"`
	LastActivityNs string `json:"lastActivityNs"`
	TailDigest     string `json:"tailDigest,omitempty"`
	ChainOK        bool   `json:"chainOk"`
	Project        string `json:"project,omitempty"`
}

// CLITranscriptEvent is one chain event rendered verbatim.
type CLITranscriptEvent struct {
	Seq    uint64          `json:"seq"`
	Kind   string          `json:"kind"`
	TimeNs string          `json:"timeNs"`
	Data   json.RawMessage `json:"data"`
}

// CLITranscriptResponse is the capped transcript view.
type CLITranscriptResponse struct {
	ID       string               `json:"id"`
	ChainOK  bool                 `json:"chainOk"`
	Total    int                  `json:"total"`
	CappedAt int                  `json:"cappedAt"`
	Events   []CLITranscriptEvent `json:"events"`
}

// CLIChatController owns the read-only CLI session routes.
type CLIChatController struct {
	Svc CLICLIChatService
}

// Register mounts the CLI session routes.
func (c *CLIChatController) Register(r chi.Router) {
	r.Get("/uctm/cli-sessions", c.list)
	r.Get("/uctm/cli-sessions/{id}/transcript", c.transcript)
}

func (c *CLIChatController) list(w http.ResponseWriter, r *http.Request) {
	if c.Svc == nil {
		apispec.NotImplemented(w, r, http.MethodGet, "/api/v1/uctm/cli-sessions")
		return
	}
	summaries := c.Svc.List()
	out := make([]CLISessionSummary, 0, len(summaries))
	for _, s := range summaries {
		out = append(out, CLISessionSummary{
			ID: s.ID, Display: s.Display, MessageCount: s.MessageCount,
			LastActivityNs: s.LastActivityNs, TailDigest: s.TailDigest,
			ChainOK: s.ChainOK, Project: s.Project,
		})
	}
	envelope.WriteJSON(w, http.StatusOK, out)
}

func (c *CLIChatController) transcript(w http.ResponseWriter, r *http.Request) {
	if c.Svc == nil {
		apispec.NotImplemented(w, r, http.MethodGet, "/api/v1/uctm/cli-sessions/{id}/transcript")
		return
	}
	limit := 0
	if raw := r.URL.Query().Get("limit"); raw != "" {
		parsed, err := strconv.Atoi(raw)
		if err != nil || parsed < 0 {
			envelope.WriteError(w, r, apierr.Invalid("CLI_LIMIT_INVALID", "limit must be a non-negative integer", nil))
			return
		}
		limit = parsed
	}
	tr, found := c.Svc.Transcript(chi.URLParam(r, "id"), limit)
	if !found {
		envelope.WriteError(w, r, apierr.NotFound("CLI_SESSION_NOT_FOUND", "Unknown CLI session"))
		return
	}
	events := make([]CLITranscriptEvent, 0, len(tr.Events))
	for _, e := range tr.Events {
		events = append(events, CLITranscriptEvent{Seq: e.Seq, Kind: e.Kind, TimeNs: e.TimeNs, Data: e.Data})
	}
	envelope.WriteJSON(w, http.StatusOK, CLITranscriptResponse{
		ID: tr.ID, ChainOK: tr.ChainOK, Total: tr.Total, CappedAt: tr.CappedAt, Events: events,
	})
}
