-- +goose Up
-- +goose StatementBegin
-- UCTM read-only projection cache (AO-F2).
--
-- This table is a display cache of facts a UCTM service published, never a
-- source of truth. Nothing here may be promoted into truth by AO: a read is
-- served only from a record that still carries the provenance metadata the
-- service attached to it, which is why the metadata columns are NOT NULL and
-- CHECK-constrained rather than free text.
--
-- project_id carries no foreign key on purpose. The empty string is the
-- unmapped/global namespace, and AO must be able to display UCTM facts without
-- a registered AO project existing for them. A future project mapping adds
-- rows; it does not make an unmapped read illegal.
CREATE TABLE uctm_projection_records (
    project_id                 TEXT NOT NULL DEFAULT '',
    projection_kind            TEXT NOT NULL
        CHECK (projection_kind IN (
            'status', 'program', 'lanes', 'gates',
            'receipts', 'families', 'adjudication_queue', 'evaluations'
        )),
    external_id                TEXT NOT NULL DEFAULT '',
    -- Content address of payload_json (sha256 hex). Identical content written
    -- twice keeps the same address, which is what makes a refresh idempotent
    -- rather than a change.
    source_hash                TEXT NOT NULL CHECK (length(source_hash) = 64),
    schema_version             TEXT NOT NULL CHECK (trim(schema_version) <> ''),
    source_commit_or_freeze_id TEXT NOT NULL CHECK (trim(source_commit_or_freeze_id) <> ''),
    historical_or_current      TEXT NOT NULL
        CHECK (historical_or_current IN ('historical', 'current', 'mixed')),
    authority_ceiling          TEXT NOT NULL
        CHECK (authority_ceiling IN (
            'interface_read_only', 'proposal_only', 'human_adjudication',
            'training', 'downstream_effect'
        )),
    receipt_ref                TEXT NOT NULL CHECK (trim(receipt_ref) <> ''),
    content_hash_or_etag       TEXT NOT NULL CHECK (trim(content_hash_or_etag) <> ''),
    generated_at               TIMESTAMP NOT NULL,
    -- Verbatim UCTM payload. Raw conversation text must never be written here;
    -- the UCTM service is responsible for what it projects.
    payload_json               TEXT NOT NULL CHECK (json_valid(payload_json)),
    observed_at                TIMESTAMP NOT NULL,
    expires_at                 TIMESTAMP NOT NULL,
    PRIMARY KEY (project_id, projection_kind, external_id)
);
-- +goose StatementEnd

-- +goose StatementBegin
-- Freshest-first scans per kind, which is how every read route looks a
-- projection up before deciding between a cache hit and a refetch.
CREATE INDEX idx_uctm_projection_records_observed
    ON uctm_projection_records (project_id, projection_kind, observed_at DESC);
-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
DROP INDEX IF EXISTS idx_uctm_projection_records_observed;
DROP TABLE IF EXISTS uctm_projection_records;
-- +goose StatementEnd
