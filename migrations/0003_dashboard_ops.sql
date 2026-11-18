ALTER TABLE pending_items
  ADD COLUMN last_error_code TEXT
  CHECK (last_error_code IS NULL OR length(CAST(last_error_code AS BLOB)) <= 128);

UPDATE pending_items
SET last_error_code = CASE
  WHEN instr(last_error, ': ') > 1
    AND substr(last_error, 1, instr(last_error, ': ') - 1) IN (
      'blocked_unsafe_url', 'subrequest_limit', 'fetch_error',
      'storage_limit', 'pending_limit', 'metadata_limit', 'invalid_cursor',
      'unsupported_source', 'blocked_external_host', 'sitemap_page_remaining',
      'lease_lost', 'parse_error', 'unsupported_dynamic_page',
      'metadata_too_large', 'row_too_large', 'content_too_large', 'source_missing'
    )
    THEN substr(last_error, 1, instr(last_error, ': ') - 1)
  WHEN instr(last_error, ': ') > 1
    AND length(substr(last_error, 1, instr(last_error, ': ') - 1)) = 8
    AND substr(last_error, 1, instr(last_error, ': ') - 1) GLOB 'http_[1-5][0-9][0-9]'
    THEN substr(last_error, 1, instr(last_error, ': ') - 1)
  ELSE NULL
END
WHERE last_error IS NOT NULL;

CREATE INDEX idx_pending_error_group
  ON pending_items (source_id, last_error_code, status, discovered_at DESC);

CREATE TABLE fetch_run_sources (
  run_id TEXT NOT NULL REFERENCES fetch_runs(id) ON DELETE CASCADE,
  source_id_snapshot TEXT NOT NULL CHECK (length(CAST(source_id_snapshot AS BLOB)) BETWEEN 1 AND 128),
  source_id TEXT REFERENCES sources(id) ON DELETE SET NULL,
  status TEXT NOT NULL CHECK (status IN (
    'succeeded', 'partial', 'failed', 'blocked', 'storage_limit',
    'not_modified', 'disabled_source'
  )),
  http_status INTEGER CHECK (http_status IS NULL OR http_status BETWEEN 100 AND 599),
  discovered_count INTEGER NOT NULL DEFAULT 0 CHECK (discovered_count >= 0),
  stored_count INTEGER NOT NULL DEFAULT 0 CHECK (stored_count >= 0),
  error_code TEXT CHECK (error_code IS NULL OR length(CAST(error_code AS BLOB)) <= 128),
  error_message TEXT CHECK (error_message IS NULL OR length(CAST(error_message AS BLOB)) <= 1024),
  PRIMARY KEY (run_id, source_id_snapshot)
) STRICT;

CREATE INDEX idx_fetch_run_sources_source_run
  ON fetch_run_sources (source_id_snapshot, run_id);

CREATE TABLE operator_actions (
  id TEXT PRIMARY KEY NOT NULL DEFAULT (lower(hex(randomblob(16))))
    CHECK (length(CAST(id AS BLOB)) BETWEEN 1 AND 128),
  created_at INTEGER NOT NULL DEFAULT (unixepoch()) CHECK (created_at > 0),
  actor TEXT NOT NULL DEFAULT 'owner' CHECK (actor = 'owner'),
  action TEXT NOT NULL CHECK (action IN (
    'source.created', 'source.updated', 'source.disabled',
    'export.started', 'export.ended'
  )),
  target_type TEXT NOT NULL CHECK (target_type IN ('source', 'export')),
  target_id TEXT NOT NULL CHECK (length(CAST(target_id AS BLOB)) BETWEEN 1 AND 128),
  changed_fields_json TEXT NOT NULL DEFAULT '[]'
    CHECK (
      length(CAST(changed_fields_json AS BLOB)) <= 2048
      AND json_valid(changed_fields_json)
      AND json_type(changed_fields_json) = 'array'
    ),
  CHECK (
    (action IN ('source.created', 'source.updated', 'source.disabled') AND target_type = 'source')
    OR (action IN ('export.started', 'export.ended') AND target_type = 'export')
  )
) STRICT;

CREATE INDEX idx_operator_actions_created_id
  ON operator_actions (created_at DESC, id DESC);

CREATE TRIGGER operator_actions_field_names_only
BEFORE INSERT ON operator_actions
WHEN EXISTS (
  SELECT 1
  FROM json_each(NEW.changed_fields_json)
  WHERE type <> 'text'
    OR value NOT IN (
      'kind', 'url', 'poll_interval_sec', 'selectors', 'enabled',
      'state', 'snapshot_id', 'cursor', 'expires_at',
      'snapshot_sources_count', 'snapshot_pending_items_count', 'snapshot_articles_count'
    )
)
BEGIN
  SELECT RAISE(ABORT, 'operator_actions accepts field names only');
END;

CREATE TRIGGER operator_actions_no_replace
BEFORE INSERT ON operator_actions
WHEN EXISTS (SELECT 1 FROM operator_actions WHERE id = NEW.id)
BEGIN
  SELECT RAISE(ABORT, 'operator_actions is append-only');
END;

CREATE TRIGGER operator_actions_no_update
BEFORE UPDATE ON operator_actions
BEGIN
  SELECT RAISE(ABORT, 'operator_actions is append-only');
END;

-- Retention cleanup may remove only rows older than 90 days; recent audit rows are immutable.
CREATE TRIGGER operator_actions_delete_after_retention
BEFORE DELETE ON operator_actions
WHEN OLD.created_at >= unixepoch() - 7776000
BEGIN
  SELECT RAISE(ABORT, 'operator_actions retention period has not elapsed');
END;
