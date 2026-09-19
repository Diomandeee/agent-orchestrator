package controllers

import (
	"context"
	"net/http"

	"github.com/go-chi/chi/v5"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/httpd/apispec"
	"github.com/aoagents/agent-orchestrator/backend/internal/httpd/envelope"
)

// UCTMProjectionService is the controller-facing read-only UCTM contract.
//
// Read never fails for an operational reason: an unreachable, refusing, or
// silent UCTM service is a freshness state, not an HTTP error, because the
// dashboard's job is to say what AO knows — including that it knows nothing.
type UCTMProjectionService interface {
	Mode() domain.UCTMMode
	Read(ctx context.Context, projectID domain.ProjectID, kind domain.UCTMProjectionKind) (domain.UCTMProjectionRead, error)
}

// UCTMController owns the v0 read-only UCTM projection routes.
type UCTMController struct {
	Svc UCTMProjectionService
}

// Register mounts every v0 projection route. The kind list is the single source
// of routes: a kind added to the domain without a route (or the reverse) cannot
// compile past this loop, and the OpenAPI parity test catches a kind that has no
// operation registered.
func (c *UCTMController) Register(r chi.Router) {
	for _, kind := range domain.AllUCTMProjectionKinds {
		r.Get("/uctm/"+kind.RouteSegment(), c.readHandler(kind))
	}
}

func (c *UCTMController) readHandler(kind domain.UCTMProjectionKind) http.HandlerFunc {
	path := kind.AOFacingPath()
	return func(w http.ResponseWriter, r *http.Request) {
		if c.Svc == nil {
			apispec.NotImplemented(w, r, http.MethodGet, path)
			return
		}
		read, err := c.Svc.Read(r.Context(), domain.ProjectID(r.URL.Query().Get("projectId")), kind)
		if err != nil {
			envelope.WriteError(w, r, err)
			return
		}
		envelope.WriteJSON(w, http.StatusOK, uctmProjectionResponse(read))
	}
}

// uctmProjectionResponse renders a read. Provenance fields are copied only when
// a projection exists: an unknown state must not carry a receipt reference or a
// content hash that would imply AO had something to show.
func uctmProjectionResponse(read domain.UCTMProjectionRead) UCTMProjectionResponse {
	out := UCTMProjectionResponse{
		Kind:      string(read.Kind),
		Mode:      string(read.Mode),
		ProjectID: string(read.ProjectID),
		Freshness: string(read.Freshness),
		Reason:    string(read.Reason),
	}
	if read.Projection == nil {
		return out
	}
	projection := read.Projection
	out.AuthorityCeiling = string(projection.Metadata.AuthorityCeiling)
	out.ReceiptRef = projection.Metadata.ReceiptRef
	out.SchemaVersion = projection.Metadata.SchemaVersion
	out.SourceCommitOrFreezeID = projection.Metadata.SourceCommitOrFreezeID
	out.HistoricalOrCurrent = string(projection.Metadata.HistoricalOrCurrent)
	out.ContentHashOrETag = projection.Metadata.ContentHashOrETag
	out.SourceHash = projection.SourceHash
	generatedAt := projection.Metadata.GeneratedAt
	out.GeneratedAt = &generatedAt
	observedAt := projection.ObservedAt
	out.ObservedAt = &observedAt
	expiresAt := projection.ExpiresAt
	out.ExpiresAt = &expiresAt
	out.Payload = projection.PayloadJSON
	return out
}
