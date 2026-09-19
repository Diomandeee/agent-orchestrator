package store

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/storage/sqlite/gen"
)

// UpsertUCTMProjection writes one UCTM projection row and reports whether the
// payload content address changed.
//
// The row is a cache of a fact a UCTM service published, so the write validates
// what makes it a fact at all: a well-formed content address that matches the
// bytes, a kind AO serves, and complete provenance metadata. Refusing an
// unsound row here means no later read has to re-check it.
func (s *Store) UpsertUCTMProjection(
	ctx context.Context,
	record domain.UCTMProjectionRecord,
) (bool, error) {
	if err := validateUCTMProjectionRecord(record); err != nil {
		return false, err
	}
	s.writeMu.Lock()
	defer s.writeMu.Unlock()

	changed := true
	existing, err := s.qr.GetUCTMProjection(ctx, gen.GetUCTMProjectionParams{
		ProjectID:      record.ProjectID,
		ProjectionKind: record.Kind,
		ExternalID:     record.ExternalID,
	})
	switch {
	case err == nil:
		changed = existing.SourceHash != record.SourceHash
	case errors.Is(err, sql.ErrNoRows):
		// First observation of this projection.
	default:
		return false, fmt.Errorf("read uctm projection for upsert: %w", err)
	}

	if err := s.qw.UpsertUCTMProjection(ctx, gen.UpsertUCTMProjectionParams{
		ProjectID:              record.ProjectID,
		ProjectionKind:         record.Kind,
		ExternalID:             record.ExternalID,
		SourceHash:             record.SourceHash,
		SchemaVersion:          record.Metadata.SchemaVersion,
		SourceCommitOrFreezeID: record.Metadata.SourceCommitOrFreezeID,
		HistoricalOrCurrent:    record.Metadata.HistoricalOrCurrent,
		AuthorityCeiling:       record.Metadata.AuthorityCeiling,
		ReceiptRef:             record.Metadata.ReceiptRef,
		ContentHashOrEtag:      record.Metadata.ContentHashOrETag,
		GeneratedAt:            record.Metadata.GeneratedAt,
		PayloadJson:            string(record.PayloadJSON),
		ObservedAt:             record.ObservedAt,
		ExpiresAt:              record.ExpiresAt,
	}); err != nil {
		return false, fmt.Errorf("upsert uctm projection: %w", err)
	}
	return changed, nil
}

// GetUCTMProjection reads one projection. found is false when AO has never
// observed it; the caller decides whether that is unknown or stale.
func (s *Store) GetUCTMProjection(
	ctx context.Context,
	projectID domain.ProjectID,
	kind domain.UCTMProjectionKind,
	externalID string,
) (domain.UCTMProjectionRecord, bool, error) {
	row, err := s.qr.GetUCTMProjection(ctx, gen.GetUCTMProjectionParams{
		ProjectID:      projectID,
		ProjectionKind: kind,
		ExternalID:     externalID,
	})
	if errors.Is(err, sql.ErrNoRows) {
		return domain.UCTMProjectionRecord{}, false, nil
	}
	if err != nil {
		return domain.UCTMProjectionRecord{}, false, fmt.Errorf("get uctm projection: %w", err)
	}
	return uctmProjectionFromGen(row), true, nil
}

// ListUCTMProjections returns every projection AO holds for a namespace. It
// backs diagnostics and tests; no v0 read route needs more than one kind.
func (s *Store) ListUCTMProjections(ctx context.Context, projectID domain.ProjectID) ([]domain.UCTMProjectionRecord, error) {
	rows, err := s.qr.ListUCTMProjections(ctx, projectID)
	if err != nil {
		return nil, fmt.Errorf("list uctm projections: %w", err)
	}
	out := make([]domain.UCTMProjectionRecord, 0, len(rows))
	for _, row := range rows {
		out = append(out, uctmProjectionFromGen(row))
	}
	return out, nil
}

// DeleteUCTMProjections drops one kind's projections for a namespace and
// reports how many rows went away.
func (s *Store) DeleteUCTMProjections(
	ctx context.Context,
	projectID domain.ProjectID,
	kind domain.UCTMProjectionKind,
) (int64, error) {
	s.writeMu.Lock()
	defer s.writeMu.Unlock()
	deleted, err := s.qw.DeleteUCTMProjection(ctx, gen.DeleteUCTMProjectionParams{
		ProjectID:      projectID,
		ProjectionKind: kind,
	})
	if err != nil {
		return 0, fmt.Errorf("delete uctm projection: %w", err)
	}
	return deleted, nil
}

func uctmProjectionFromGen(row gen.UctmProjectionRecord) domain.UCTMProjectionRecord {
	return domain.UCTMProjectionRecord{
		ProjectID:  row.ProjectID,
		Kind:       row.ProjectionKind,
		ExternalID: row.ExternalID,
		SourceHash: row.SourceHash,
		Metadata: domain.UCTMWireMetadata{
			SchemaVersion:          row.SchemaVersion,
			SourceCommitOrFreezeID: row.SourceCommitOrFreezeID,
			GeneratedAt:            row.GeneratedAt,
			HistoricalOrCurrent:    row.HistoricalOrCurrent,
			AuthorityCeiling:       row.AuthorityCeiling,
			ReceiptRef:             row.ReceiptRef,
			ContentHashOrETag:      row.ContentHashOrEtag,
		},
		PayloadJSON: []byte(row.PayloadJson),
		ObservedAt:  row.ObservedAt,
		ExpiresAt:   row.ExpiresAt,
	}
}

// validateUCTMProjectionRecord enforces the invariants that make a projection
// row worth reading back: a servable kind, a content address that matches the
// bytes it addresses, valid JSON, and complete provenance.
func validateUCTMProjectionRecord(record domain.UCTMProjectionRecord) error {
	if !record.Kind.Valid() {
		return fmt.Errorf("uctm projection: unknown kind %q", record.Kind)
	}
	if !domain.ValidContentAddress(record.SourceHash) {
		return fmt.Errorf("uctm projection: source_hash %q is not a sha256 content address", record.SourceHash)
	}
	if address := domain.ContentAddress(record.PayloadJSON); address != record.SourceHash {
		return fmt.Errorf("uctm projection: source_hash does not match the payload")
	}
	if !json.Valid(record.PayloadJSON) {
		return fmt.Errorf("uctm projection: payload is not valid JSON")
	}
	if err := record.Metadata.Validate(); err != nil {
		return fmt.Errorf("uctm projection: %w", err)
	}
	if record.ObservedAt.IsZero() || record.ExpiresAt.IsZero() {
		return fmt.Errorf("uctm projection: observed_at and expires_at are required")
	}
	if !record.ExpiresAt.After(record.ObservedAt) {
		return fmt.Errorf("uctm projection: expires_at must be after observed_at")
	}
	return nil
}
