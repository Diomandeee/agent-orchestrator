-- name: GetUCTMProjection :one
SELECT *
FROM uctm_projection_records
WHERE project_id = sqlc.arg(project_id)
  AND projection_kind = sqlc.arg(projection_kind)
  AND external_id = sqlc.arg(external_id);

-- name: ListUCTMProjections :many
SELECT *
FROM uctm_projection_records
WHERE project_id = sqlc.arg(project_id)
ORDER BY projection_kind, external_id;

-- name: UpsertUCTMProjection :exec
INSERT INTO uctm_projection_records (
    project_id, projection_kind, external_id, source_hash, schema_version,
    source_commit_or_freeze_id, historical_or_current, authority_ceiling,
    receipt_ref, content_hash_or_etag, generated_at, payload_json,
    observed_at, expires_at
) VALUES (
    sqlc.arg(project_id), sqlc.arg(projection_kind), sqlc.arg(external_id),
    sqlc.arg(source_hash), sqlc.arg(schema_version),
    sqlc.arg(source_commit_or_freeze_id), sqlc.arg(historical_or_current),
    sqlc.arg(authority_ceiling), sqlc.arg(receipt_ref),
    sqlc.arg(content_hash_or_etag), sqlc.arg(generated_at),
    sqlc.arg(payload_json), sqlc.arg(observed_at), sqlc.arg(expires_at)
)
ON CONFLICT (project_id, projection_kind, external_id) DO UPDATE SET
    source_hash = excluded.source_hash,
    schema_version = excluded.schema_version,
    source_commit_or_freeze_id = excluded.source_commit_or_freeze_id,
    historical_or_current = excluded.historical_or_current,
    authority_ceiling = excluded.authority_ceiling,
    receipt_ref = excluded.receipt_ref,
    content_hash_or_etag = excluded.content_hash_or_etag,
    generated_at = excluded.generated_at,
    payload_json = excluded.payload_json,
    observed_at = excluded.observed_at,
    expires_at = excluded.expires_at;

-- name: DeleteUCTMProjection :execrows
DELETE FROM uctm_projection_records
WHERE project_id = sqlc.arg(project_id)
  AND projection_kind = sqlc.arg(projection_kind);
