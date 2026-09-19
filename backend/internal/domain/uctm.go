package domain

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"strings"
	"time"
)

// UCTMMode is the single, explicit integration mode between AO and UCTM. There
// is exactly one mode at a time; nothing is inferred from the presence of a base
// URL, and no read happens in a mode that does not name reads.
//
// The zero value is invalid on purpose. AO must never reach UCTM because an
// environment variable was unset and something defaulted to "on".
type UCTMMode string

const (
	// UCTMModeOff performs no UCTM service call at all. Routes answer an
	// explicit disabled state rather than an empty or invented one.
	UCTMModeOff UCTMMode = "off"
	// UCTMModeReadOnly fetches and displays UCTM facts. It never proposes.
	UCTMModeReadOnly UCTMMode = "read_only"
	// UCTMModeShadow reads plus may submit pointer/hash proposals. AO-F2 does not
	// implement proposal submission; the mode is parsed so it can be refused
	// loudly instead of silently treated as read-only.
	UCTMModeShadow UCTMMode = "shadow"
	// UCTMModeHumanGated adds explicit local desktop adjudication proposals after
	// separate qualification. Not implemented; refused loudly.
	UCTMModeHumanGated UCTMMode = "human_gated"
)

// AllUCTMModes is the closed set of modes, in increasing authority order.
var AllUCTMModes = []UCTMMode{
	UCTMModeOff, UCTMModeReadOnly, UCTMModeShadow, UCTMModeHumanGated,
}

// Valid reports whether m is a mode AO knows.
func (m UCTMMode) Valid() bool {
	for _, known := range AllUCTMModes {
		if m == known {
			return true
		}
	}
	return false
}

// ReadsEnabled reports whether m authorises AO to call the UCTM service for
// read projections. It is false for off and for the zero value.
func (m UCTMMode) ReadsEnabled() bool {
	return m == UCTMModeReadOnly || m == UCTMModeShadow
}

// ParseUCTMMode converts operator-supplied input into a mode, strictly. An
// empty string means "not configured" and resolves to UCTMModeOff so a missing
// variable can never enable the integration. Anything unrecognised is an error:
// a typo in UCTM_MODE must fail the daemon at boot, not degrade to a different
// authority level than the operator asked for.
func ParseUCTMMode(raw string) (UCTMMode, error) {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" {
		return UCTMModeOff, nil
	}
	mode := UCTMMode(trimmed)
	if !mode.Valid() {
		return "", fmt.Errorf("invalid UCTM mode %q: want one of %s", raw, strings.Join(uCTMModeNames(), ", "))
	}
	return mode, nil
}

func uCTMModeNames() []string {
	names := make([]string, 0, len(AllUCTMModes))
	for _, m := range AllUCTMModes {
		names = append(names, string(m))
	}
	return names
}

// UCTMProjectionKind names one read-only projection AO keeps of a UCTM fact
// family. The set is closed: an unknown kind is a programming error, not a
// forward-compatible extension, because every kind needs a route and a schema
// entry before it can be served.
type UCTMProjectionKind string

const (
	UCTMKindStatus            UCTMProjectionKind = "status"
	UCTMKindProgram           UCTMProjectionKind = "program"
	UCTMKindLanes             UCTMProjectionKind = "lanes"
	UCTMKindGates             UCTMProjectionKind = "gates"
	UCTMKindReceipts          UCTMProjectionKind = "receipts"
	UCTMKindFamilies          UCTMProjectionKind = "families"
	UCTMKindAdjudicationQueue UCTMProjectionKind = "adjudication_queue"
	UCTMKindEvaluations       UCTMProjectionKind = "evaluations"
)

// AllUCTMProjectionKinds is the v0 read set, in route order.
var AllUCTMProjectionKinds = []UCTMProjectionKind{
	UCTMKindStatus, UCTMKindProgram, UCTMKindLanes, UCTMKindGates,
	UCTMKindReceipts, UCTMKindFamilies, UCTMKindAdjudicationQueue, UCTMKindEvaluations,
}

// Valid reports whether k is one of the v0 projection kinds.
func (k UCTMProjectionKind) Valid() bool {
	for _, known := range AllUCTMProjectionKinds {
		if k == known {
			return true
		}
	}
	return false
}

// ServicePath is the UCTM service path the kind is read from. It is the remote
// half of the contract; the AO-facing route is derived by RouteSegment.
func (k UCTMProjectionKind) ServicePath() string {
	switch k {
	case UCTMKindAdjudicationQueue:
		return "/v1/adjudication/queue"
	default:
		return "/v1/" + string(k)
	}
}

// RouteSegment is the AO route suffix for the kind, relative to /api/v1/uctm/.
func (k UCTMProjectionKind) RouteSegment() string {
	switch k {
	case UCTMKindAdjudicationQueue:
		return "adjudication/queue"
	default:
		return string(k)
	}
}

// AOFacingPath is the full AO route path for the kind, used for OpenAPI parity.
func (k UCTMProjectionKind) AOFacingPath() string {
	return "/api/v1/uctm/" + k.RouteSegment()
}

// UCTMFreshness is the derived display state of a projection. Like every other
// AO display status it is never stored: it is computed at read time from the
// durable projection facts (observed_at, expires_at) plus the outcome of the
// current attempt.
//
// There is deliberately no "healthy" value. A projection is fresh, stale,
// unknown, or disabled; nothing else is allowed to mean "fine".
type UCTMFreshness string

const (
	// UCTMFreshnessDisabled means the integration mode authorises no read.
	UCTMFreshnessDisabled UCTMFreshness = "disabled"
	// UCTMFreshnessFresh means a projection exists and has not expired.
	UCTMFreshnessFresh UCTMFreshness = "fresh"
	// UCTMFreshnessStale means a projection exists but is past its expiry, or the
	// latest attempt failed while an older projection survives.
	UCTMFreshnessStale UCTMFreshness = "stale"
	// UCTMFreshnessUnknown means AO has no usable projection. Service failure
	// derives this or stale, never fresh.
	UCTMFreshnessUnknown UCTMFreshness = "unknown"
)

// UCTMHistoricality classifies whether a projection describes history or
// current state. It is part of the required response metadata, so an
// unrecognised value is refused rather than carried through as free text: a
// consumer must not have to guess what an unknown label means.
type UCTMHistoricality string

const (
	UCTMHistorical UCTMHistoricality = "historical"
	UCTMCurrent    UCTMHistoricality = "current"
	UCTMMixed      UCTMHistoricality = "mixed"
)

// Valid reports whether h is a recognised classification.
func (h UCTMHistoricality) Valid() bool {
	switch h {
	case UCTMHistorical, UCTMCurrent, UCTMMixed:
		return true
	default:
		return false
	}
}

// UCTMAuthorityCeiling is the highest effect a UCTM response claims for itself.
// It is recorded, never obeyed: AO's own mode decides what AO does. The value is
// checked only to prove it does not exceed the mode's ceiling, so a service that
// starts claiming training authority is refused instead of quietly displayed as
// if it were merely readable.
type UCTMAuthorityCeiling string

const (
	UCTMCeilingReadOnly          UCTMAuthorityCeiling = "interface_read_only"
	UCTMCeilingProposalOnly      UCTMAuthorityCeiling = "proposal_only"
	UCTMCeilingHumanAdjudication UCTMAuthorityCeiling = "human_adjudication"
	UCTMCeilingTraining          UCTMAuthorityCeiling = "training"
	UCTMCeilingDownstreamEffect  UCTMAuthorityCeiling = "downstream_effect"
)

// uctmCeilingRank orders ceilings by the authority they claim. Higher is wider.
var uctmCeilingRank = map[UCTMAuthorityCeiling]int{
	UCTMCeilingReadOnly:          0,
	UCTMCeilingProposalOnly:      1,
	UCTMCeilingHumanAdjudication: 2,
	UCTMCeilingTraining:          3,
	UCTMCeilingDownstreamEffect:  4,
}

// Valid reports whether c is a recognised ceiling.
func (c UCTMAuthorityCeiling) Valid() bool {
	_, ok := uctmCeilingRank[c]
	return ok
}

// PermittedBy reports whether mode may consume a response claiming ceiling c.
// An unknown ceiling is never permitted: a value AO cannot bound is treated as
// wider than AO's authority, not narrower.
func (c UCTMAuthorityCeiling) PermittedBy(mode UCTMMode) bool {
	rank, ok := uctmCeilingRank[c]
	if !ok {
		return false
	}
	return rank <= uctmCeilingForMode(mode)
}

// uctmCeilingForMode is the widest ceiling each mode is allowed to display.
// Proposal modes exist only to carry proposals back to UCTM, so their read
// ceiling stays read-only: reading is reading in every mode.
func uctmCeilingForMode(mode UCTMMode) int {
	if !mode.ReadsEnabled() {
		return -1
	}
	return uctmCeilingRank[UCTMCeilingReadOnly]
}

// UCTMWireMetadata is the required provenance block every UCTM response must
// carry. Absence of any field is a protocol violation and fails closed: an
// unprovenanced fact cannot be displayed as a UCTM fact at all.
type UCTMWireMetadata struct {
	SchemaVersion          string               `json:"schema_version"`
	SourceCommitOrFreezeID string               `json:"source_commit_or_freeze_id"`
	GeneratedAt            time.Time            `json:"generated_at"`
	HistoricalOrCurrent    UCTMHistoricality    `json:"historical_or_current"`
	AuthorityCeiling       UCTMAuthorityCeiling `json:"authority_ceiling"`
	ReceiptRef             string               `json:"receipt_ref"`
	ContentHashOrETag      string               `json:"content_hash_or_etag"`
}

// Validate reports the first missing or unrecognised required field.
func (m UCTMWireMetadata) Validate() error {
	switch {
	case strings.TrimSpace(m.SchemaVersion) == "":
		return fmt.Errorf("uctm response metadata: schema_version is required")
	case strings.TrimSpace(m.SourceCommitOrFreezeID) == "":
		return fmt.Errorf("uctm response metadata: source_commit_or_freeze_id is required")
	case m.GeneratedAt.IsZero():
		return fmt.Errorf("uctm response metadata: generated_at is required")
	case !m.HistoricalOrCurrent.Valid():
		return fmt.Errorf("uctm response metadata: historical_or_current %q is not one of historical, current, mixed", m.HistoricalOrCurrent)
	case !m.AuthorityCeiling.Valid():
		return fmt.Errorf("uctm response metadata: authority_ceiling %q is not a recognised ceiling", m.AuthorityCeiling)
	case strings.TrimSpace(m.ReceiptRef) == "":
		return fmt.Errorf("uctm response metadata: receipt_ref is required")
	case strings.TrimSpace(m.ContentHashOrETag) == "":
		return fmt.Errorf("uctm response metadata: content_hash_or_etag is required")
	}
	return nil
}

// CheckAuthority refuses a response whose claimed ceiling exceeds what mode may
// display, and refuses unknown ceilings outright.
func (m UCTMWireMetadata) CheckAuthority(mode UCTMMode) error {
	if !m.AuthorityCeiling.PermittedBy(mode) {
		return fmt.Errorf("uctm response metadata: authority_ceiling %q exceeds the ceiling permitted by mode %q", m.AuthorityCeiling, mode)
	}
	return nil
}

// UCTMProjectionRecord is one durable projection row. It stores the response
// metadata beside the payload so a display can always show where a fact came
// from, and it stores expires_at so freshness stays derivable after a restart.
//
// AO projection rows are never canonical UCTM truth. Nothing here may be edited
// into truth by AO, and no raw conversation text is ever placed in PayloadJSON.
type UCTMProjectionRecord struct {
	// ProjectID is the projection namespace. Empty means the unmapped/global
	// namespace; AO does not require a registered project to display UCTM facts.
	ProjectID ProjectID
	Kind      UCTMProjectionKind
	// ExternalID identifies an item inside a kind. v0 projects whole documents,
	// so it is empty; the column exists so per-item projections do not need a
	// schema rebuild later.
	ExternalID string
	// SourceHash is the content address of PayloadJSON. Identical content written
	// again must not look like a change to any downstream reader.
	SourceHash string
	Metadata   UCTMWireMetadata
	// PayloadJSON is the verbatim UCTM payload, already validated as JSON.
	PayloadJSON []byte
	// ObservedAt is when AO received this projection; GeneratedAt is when UCTM
	// produced it. They answer different questions and are both kept.
	ObservedAt time.Time
	ExpiresAt  time.Time
}

// FreshnessAt derives the display freshness of the record at now. It never
// returns fresh for a zero or expired window.
func (r UCTMProjectionRecord) FreshnessAt(now time.Time) UCTMFreshness {
	if r.ObservedAt.IsZero() || r.ExpiresAt.IsZero() || !now.Before(r.ExpiresAt) {
		return UCTMFreshnessStale
	}
	return UCTMFreshnessFresh
}

// UCTMProjectionRead is the service result the controller renders. Exactly one
// of Projection and Reason explains the state: a fresh/stale read carries the
// projection, and every non-fresh state carries a stable machine reason so the
// UI can say why rather than showing a blank.
type UCTMProjectionRead struct {
	Mode       UCTMMode
	Kind       UCTMProjectionKind
	ProjectID  ProjectID
	Freshness  UCTMFreshness
	Reason     UCTMReadReason
	Projection *UCTMProjectionRecord
}

// UCTMReadReason is a stable, non-secret explanation code.
type UCTMReadReason string

const (
	UCTMReasonModeOff                UCTMReadReason = "mode_off"
	UCTMReasonTransportNotConfigured UCTMReadReason = "transport_not_configured"
	UCTMReasonServiceUnavailable     UCTMReadReason = "service_unavailable"
	UCTMReasonServiceRejected        UCTMReadReason = "service_rejected"
	UCTMReasonNoFacts                UCTMReadReason = "no_facts"
	UCTMReasonProjectionExpired      UCTMReadReason = "projection_expired"
	UCTMReasonFreshProjection        UCTMReadReason = "fresh_projection"
	// UCTMReasonProjectionUnpersisted means AO holds a fact it could not durably
	// record. The payload is still shown; the durability gap is named so a caller
	// can tell a cache hit from a fresh, unpersisted read.
	UCTMReasonProjectionUnpersisted UCTMReadReason = "projection_not_persisted"
	UCTMReasonNoProjection          UCTMReadReason = "no_projection"
)

// UCTMSourceResponse is one validated answer from the UCTM service: the required
// metadata, the verbatim payload, and the cache window the service granted.
//
// NoFacts is how a service abstains. An abstention is not an empty projection:
// callers must not overwrite a surviving projection with it, because "I have
// nothing to say" and "the answer is nothing" are different claims.
type UCTMSourceResponse struct {
	Metadata UCTMWireMetadata
	Payload  []byte
	// MaxAge is the service-granted lifetime of this payload, taken from
	// Cache-Control. Zero means the caller applies its own default.
	MaxAge  time.Duration
	NoFacts bool
}

// ContentAddress is the content address of one validated projection payload:
// the sha256 of the compact JSON bytes, hex-encoded.
//
// It lives in the domain because it is a rule about what makes two projections
// the same fact, not a property of any one transport. Two spellings of the same
// document must produce the same address, and two different documents must not.
func ContentAddress(payload []byte) string {
	sum := sha256.Sum256(payload)
	return hex.EncodeToString(sum[:])
}

// ValidContentAddress reports whether raw is a well-formed content address.
func ValidContentAddress(raw string) bool {
	if len(raw) != 64 {
		return false
	}
	_, err := hex.DecodeString(raw)
	return err == nil
}
