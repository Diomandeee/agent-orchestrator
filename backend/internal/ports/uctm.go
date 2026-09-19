package ports

import (
	"context"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
)

// UCTMSource is AO's outbound read contract to a UCTM service. Implementations
// own transport, authentication, and payload validation; they never decide what
// AO may display, and they never write to UCTM.
//
// The port returns exactly one projection per call. A source that cannot answer
// returns an error; it must not return a partially decoded payload, and it must
// not return a zero response to mean "healthy but empty".
type UCTMSource interface {
	Fetch(ctx context.Context, kind domain.UCTMProjectionKind) (domain.UCTMSourceResponse, error)
}

// UCTMProjectionStore is the durable half of the read path. AO projection rows
// are a display cache, never UCTM truth.
type UCTMProjectionStore interface {
	// UpsertUCTMProjection writes one projection and reports whether the payload
	// content address changed, so callers can distinguish a refresh from a new
	// fact without comparing bytes themselves.
	UpsertUCTMProjection(ctx context.Context, record domain.UCTMProjectionRecord) (contentChanged bool, err error)

	// GetUCTMProjection reads one projection. found is false when AO has never
	// observed it.
	GetUCTMProjection(
		ctx context.Context,
		projectID domain.ProjectID,
		kind domain.UCTMProjectionKind,
		externalID string,
	) (record domain.UCTMProjectionRecord, found bool, err error)
}
