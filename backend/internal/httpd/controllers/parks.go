package controllers

import (
	"encoding/json"
	"net/http"

	"github.com/go-chi/chi/v5"

	"github.com/aoagents/agent-orchestrator/backend/internal/httpd/apierr"
	"github.com/aoagents/agent-orchestrator/backend/internal/httpd/apispec"
	"github.com/aoagents/agent-orchestrator/backend/internal/httpd/envelope"
	"github.com/aoagents/agent-orchestrator/backend/internal/service/parks"
)

// ParksService is the controller-facing read-only parked-idea contract.
// The store is the bridge parks directory; the daemon never writes it.
type ParksService interface {
	List() []parks.Summary
	Packet(name string) (json.RawMessage, bool)
}

// ParkIDParam names the parked-idea path parameter.
type ParkIDParam struct {
	Name string `path:"name" description:"Parked idea identifier (packet filename stem)."`
}

// ParkSummary is one parked idea rendered as a garden card.
// Wave and Tier carry the fleet-board grouping; garden packets leave them zero.
type ParkSummary struct {
	Name    string   `json:"name"`
	Created string   `json:"created"`
	Status  string   `json:"status"`
	State   string   `json:"state"`
	Blocked []string `json:"blocked"`
	Next    []string `json:"next"`
	Wave    int      `json:"wave"`
	Tier    string   `json:"tier"`
}

// ParkPacketResponse is the verbatim handoff packet for one parked idea.
type ParkPacketResponse struct {
	Name   string          `json:"name"`
	Packet json.RawMessage `json:"packet"`
}

// ParksController owns the read-only parked-idea routes.
type ParksController struct {
	Svc ParksService
}

// Register mounts the parked-idea routes.
func (c *ParksController) Register(r chi.Router) {
	r.Get("/uctm/parks", c.list)
	r.Get("/uctm/parks/{name}/packet", c.packet)
}

func (c *ParksController) list(w http.ResponseWriter, r *http.Request) {
	if c.Svc == nil {
		apispec.NotImplemented(w, r, http.MethodGet, "/api/v1/uctm/parks")
		return
	}
	summaries := c.Svc.List()
	out := make([]ParkSummary, 0, len(summaries))
	for _, s := range summaries {
		out = append(out, ParkSummary{
			Name: s.Name, Created: s.Created, Status: s.Status,
			State: s.State, Blocked: s.Blocked, Next: s.Next,
			Wave: s.Wave, Tier: s.Tier,
		})
	}
	envelope.WriteJSON(w, http.StatusOK, out)
}

func (c *ParksController) packet(w http.ResponseWriter, r *http.Request) {
	if c.Svc == nil {
		apispec.NotImplemented(w, r, http.MethodGet, "/api/v1/uctm/parks/{name}/packet")
		return
	}
	raw, found := c.Svc.Packet(chi.URLParam(r, "name"))
	if !found {
		envelope.WriteError(w, r, apierr.NotFound("PARK_NOT_FOUND", "Unknown parked idea"))
		return
	}
	envelope.WriteJSON(w, http.StatusOK, ParkPacketResponse{
		Name: chi.URLParam(r, "name"), Packet: raw,
	})
}
