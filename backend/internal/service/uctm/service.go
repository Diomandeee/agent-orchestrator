// Package uctm owns AO's read-only UCTM projection service: the single place
// where the integration mode is honoured, freshness is derived, and a failed
// read is turned into an honest display state instead of a fabricated one.
package uctm

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/adapters/uctm"
	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

// DefaultProjectionTTL is the lifetime AO grants a projection when the UCTM
// service does not say. It is short on purpose: a projection that outlives its
// source is worse than a read that costs one round trip.
const DefaultProjectionTTL = 60 * time.Second

// Options configures the projection service. Source may be nil in every mode
// that does not read; Store may be nil in tests, which makes the service
// stateless instead of failing.
//
// Callers that hold a concrete pointer must pass a real nil rather than a typed
// nil: a nil *sqlite.Store boxed into the Store interface is non-nil here, and
// the first read would dereference it. The daemon's wiring does that check where
// the concrete type is still in scope.
type Options struct {
	Mode       domain.UCTMMode
	Source     ports.UCTMSource
	Store      ports.UCTMProjectionStore
	Now        func() time.Time
	DefaultTTL time.Duration
}

// Service reads UCTM projections under one explicit mode.
type Service struct {
	mode       domain.UCTMMode
	source     ports.UCTMSource
	store      ports.UCTMProjectionStore
	now        func() time.Time
	defaultTTL time.Duration
}

// New builds the projection service. A zero or unknown mode is normalised to
// off: the safe direction for an unconfigured integration is silence.
func New(opts Options) *Service {
	mode := opts.Mode
	if !mode.Valid() {
		mode = domain.UCTMModeOff
	}
	now := opts.Now
	if now == nil {
		now = time.Now
	}
	ttl := opts.DefaultTTL
	if ttl <= 0 {
		ttl = DefaultProjectionTTL
	}
	return &Service{mode: mode, source: opts.Source, store: opts.Store, now: now, defaultTTL: ttl}
}

// Mode reports the active integration mode. It is the only authority the read
// path consults; nothing else, including a configured base URL, enables reads.
func (s *Service) Mode() domain.UCTMMode { return s.mode }

// Read returns the display state for one projection kind.
//
// The result is always renderable. A read never fails for a reason the UI could
// only express as an error page: mode, freshness, and a stable reason code
// describe exactly what is known, and unknown states carry no payload. The only
// error is invalid input.
func (s *Service) Read(
	ctx context.Context,
	projectID domain.ProjectID,
	kind domain.UCTMProjectionKind,
) (domain.UCTMProjectionRead, error) {
	if !kind.Valid() {
		return domain.UCTMProjectionRead{}, fmt.Errorf("uctm read: unknown projection kind %q", kind)
	}
	read := domain.UCTMProjectionRead{Mode: s.mode, Kind: kind, ProjectID: projectID}

	if !s.mode.ReadsEnabled() {
		read.Freshness = domain.UCTMFreshnessDisabled
		read.Reason = domain.UCTMReasonModeOff
		return read, nil
	}

	now := s.now().UTC()

	// A projection that is still inside its granted window is served without
	// contacting UCTM. The UI polls; the service should not pay a round trip for
	// a fact it already holds a valid copy of.
	if cached, found := s.load(ctx, projectID, kind); found && cached.FreshnessAt(now) == domain.UCTMFreshnessFresh {
		read.Freshness = domain.UCTMFreshnessFresh
		read.Reason = domain.UCTMReasonFreshProjection
		read.Projection = &cached
		return read, nil
	}

	if s.source == nil {
		return s.degrade(ctx, read, domain.UCTMReasonTransportNotConfigured), nil
	}

	response, err := s.source.Fetch(ctx, kind)
	if err != nil {
		return s.degrade(ctx, read, reasonForError(err)), nil
	}
	// An abstention carries no claim, so there is nothing to authorise: a 204 has
	// no metadata at all. It is handled first for that reason.
	if response.NoFacts {
		return s.degrade(ctx, read, domain.UCTMReasonNoFacts), nil
	}
	// The service's own claimed ceiling is checked against AO's mode before the
	// payload is stored or shown. A response that claims more authority than AO
	// is willing to display is refused, not downgraded.
	if err := response.Metadata.CheckAuthority(s.mode); err != nil {
		return s.degrade(ctx, read, domain.UCTMReasonServiceRejected), nil
	}

	ttl := response.MaxAge
	if ttl <= 0 {
		ttl = s.defaultTTL
	}
	record := domain.UCTMProjectionRecord{
		ProjectID:   projectID,
		Kind:        kind,
		SourceHash:  domain.ContentAddress(response.Payload),
		Metadata:    response.Metadata,
		PayloadJSON: response.Payload,
		ObservedAt:  now,
		ExpiresAt:   now.Add(ttl),
	}
	reason := domain.UCTMReasonFreshProjection
	if s.store != nil {
		if _, err := s.store.UpsertUCTMProjection(ctx, record); err != nil {
			// The fact was read; only its durability failed. Saying "unknown"
			// would deny a fact AO is holding, so the projection is returned
			// fresh with a reason that names the durability gap: the next read
			// re-fetches instead of trusting a cache that may not be there.
			reason = domain.UCTMReasonProjectionUnpersisted
		}
	}

	read.Freshness = domain.UCTMFreshnessFresh
	read.Reason = reason
	read.Projection = &record
	return read, nil
}

// degrade turns a failed or empty attempt into the strongest claim the durable
// facts support. A surviving projection is stale, never fresh; with no
// projection at all the state is unknown. There is no path from failure to
// healthy.
func (s *Service) degrade(ctx context.Context, read domain.UCTMProjectionRead, reason domain.UCTMReadReason) domain.UCTMProjectionRead {
	read.Reason = reason
	if cached, found := s.load(ctx, read.ProjectID, read.Kind); found {
		read.Freshness = domain.UCTMFreshnessStale
		read.Projection = &cached
		return read
	}
	read.Freshness = domain.UCTMFreshnessUnknown
	return read
}

// load reads the durable projection for the kind. A load failure is treated as
// absence: a projection AO cannot read is one it cannot vouch for.
func (s *Service) load(ctx context.Context, projectID domain.ProjectID, kind domain.UCTMProjectionKind) (domain.UCTMProjectionRecord, bool) {
	if s.store == nil {
		return domain.UCTMProjectionRecord{}, false
	}
	record, found, err := s.store.GetUCTMProjection(ctx, projectID, kind, "")
	if err != nil || !found {
		return domain.UCTMProjectionRecord{}, false
	}
	if record.SourceHash == "" || len(record.PayloadJSON) == 0 {
		return domain.UCTMProjectionRecord{}, false
	}
	return record, true
}

// reasonForError maps a transport failure onto a stable display reason. Unknown
// failures are treated as unavailability, never as a rejection AO could act on.
func reasonForError(err error) domain.UCTMReadReason {
	var adapterErr *uctm.Error
	if errors.As(err, &adapterErr) {
		switch adapterErr.Kind {
		case uctm.ErrorStatus, uctm.ErrorProtocol:
			return domain.UCTMReasonServiceRejected
		default:
			return domain.UCTMReasonServiceUnavailable
		}
	}
	return domain.UCTMReasonServiceUnavailable
}
