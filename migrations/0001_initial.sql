CREATE TABLE sources (
  id TEXT PRIMARY KEY NOT NULL CHECK (length(id) BETWEEN 1 AND 128),
  url TEXT NOT NULL CHECK (length(CAST(url AS BLOB)) BETWEEN 1 AND 4096),
  kind TEXT NOT NULL CHECK (kind IN ('feed', 'sitemap', 'article', 'html_list')),
  host TEXT NOT NULL CHECK (length(CAST(host AS BLOB)) BETWEEN 1 AND 255),
  poll_interval_sec INTEGER NOT NULL DEFAULT 7200 CHECK (poll_interval_sec >= 900),
  selectors_json TEXT CHECK (selectors_json IS NULL OR length(CAST(selectors_json AS BLOB)) <= 32768),
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  next_fetch_at INTEGER NOT NULL DEFAULT (unixepoch()),
  etag TEXT,
  last_modified TEXT,
  feed_watermark TEXT CHECK (feed_watermark IS NULL OR length(CAST(feed_watermark AS BLOB)) <= 4096),
  sitemap_last_loc TEXT CHECK (sitemap_last_loc IS NULL OR length(CAST(sitemap_last_loc AS BLOB)) <= 4096),
  consecutive_errors INTEGER NOT NULL DEFAULT 0 CHECK (consecutive_errors >= 0),
  last_status TEXT CHECK (last_status IS NULL OR length(CAST(last_status AS BLOB)) <= 1024),
  last_fetched_at INTEGER,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
) STRICT;

CREATE TABLE pending_items (
  id TEXT PRIMARY KEY NOT NULL CHECK (length(id) BETWEEN 1 AND 128),
  source_id TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  item_type TEXT NOT NULL CHECK (item_type IN ('article', 'sitemap')),
  dedupe_key TEXT NOT NULL CHECK (length(CAST(dedupe_key AS BLOB)) BETWEEN 1 AND 4096),
  external_id TEXT CHECK (external_id IS NULL OR length(CAST(external_id AS BLOB)) <= 1024),
  canonical_url TEXT NOT NULL CHECK (length(CAST(canonical_url AS BLOB)) BETWEEN 1 AND 4096),
  title TEXT CHECK (title IS NULL OR length(CAST(title AS BLOB)) <= 4096),
  summary TEXT CHECK (summary IS NULL OR length(CAST(summary AS BLOB)) <= 1024),
  published_at TEXT CHECK (published_at IS NULL OR length(CAST(published_at AS BLOB)) <= 64),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'leased', 'retry_wait', 'blocked', 'failed')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at INTEGER NOT NULL DEFAULT (unixepoch()),
  lease_token TEXT,
  lease_expires_at INTEGER,
  last_error TEXT CHECK (last_error IS NULL OR length(CAST(last_error AS BLOB)) <= 1024),
  terminal_expires_at INTEGER,
  discovered_at INTEGER NOT NULL DEFAULT (unixepoch()),
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  UNIQUE (source_id, dedupe_key),
  CHECK ((status = 'leased' AND lease_token IS NOT NULL AND lease_expires_at IS NOT NULL)
      OR (status <> 'leased' AND lease_token IS NULL AND lease_expires_at IS NULL)),
  CHECK ((status IN ('blocked', 'failed') AND terminal_expires_at IS NOT NULL)
      OR (status NOT IN ('blocked', 'failed') AND terminal_expires_at IS NULL))
) STRICT;

CREATE TABLE articles (
  id TEXT PRIMARY KEY NOT NULL CHECK (length(id) BETWEEN 1 AND 128),
  source_id TEXT NOT NULL REFERENCES sources(id) ON DELETE RESTRICT,
  external_id TEXT CHECK (external_id IS NULL OR length(CAST(external_id AS BLOB)) <= 1024),
  canonical_url TEXT NOT NULL CHECK (length(CAST(canonical_url AS BLOB)) BETWEEN 1 AND 4096),
  title TEXT NOT NULL CHECK (length(CAST(title AS BLOB)) BETWEEN 1 AND 4096),
  summary TEXT CHECK (summary IS NULL OR length(CAST(summary AS BLOB)) <= 16384),
  author TEXT CHECK (author IS NULL OR length(CAST(author AS BLOB)) <= 1024),
  published_at TEXT CHECK (published_at IS NULL OR length(CAST(published_at AS BLOB)) <= 64),
  fetched_at INTEGER NOT NULL DEFAULT (unixepoch()),
  content_text TEXT NOT NULL CHECK (length(CAST(content_text AS BLOB)) <= 512000),
  content_hash TEXT NOT NULL CHECK (length(CAST(content_hash AS BLOB)) BETWEEN 1 AND 128),
  status TEXT NOT NULL DEFAULT 'stored' CHECK (status IN ('stored', 'content_too_large', 'blocked', 'failed')),
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  UNIQUE (source_id, external_id),
  UNIQUE (source_id, canonical_url)
) STRICT;

CREATE TABLE fetch_runs (
  id TEXT PRIMARY KEY NOT NULL CHECK (length(id) BETWEEN 1 AND 128),
  source_id TEXT REFERENCES sources(id) ON DELETE SET NULL,
  started_at INTEGER NOT NULL DEFAULT (unixepoch()),
  finished_at INTEGER,
  status TEXT NOT NULL CHECK (status IN ('running', 'succeeded', 'partial', 'failed', 'blocked', 'storage_limit')),
  http_status INTEGER CHECK (http_status IS NULL OR http_status BETWEEN 100 AND 599),
  discovered_count INTEGER NOT NULL DEFAULT 0 CHECK (discovered_count >= 0),
  stored_count INTEGER NOT NULL DEFAULT 0 CHECK (stored_count >= 0),
  error_code TEXT CHECK (error_code IS NULL OR length(CAST(error_code AS BLOB)) <= 128),
  error_message TEXT CHECK (error_message IS NULL OR length(CAST(error_message AS BLOB)) <= 1024),
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  CHECK (finished_at IS NULL OR finished_at >= started_at)
) STRICT;

CREATE TABLE system_state (
  singleton_id TEXT PRIMARY KEY NOT NULL CHECK (singleton_id = 'global'),
  global_lease_token TEXT,
  global_lease_expires_at INTEGER,
  observed_db_size INTEGER NOT NULL DEFAULT 0 CHECK (observed_db_size >= 0),
  reserved_db_bytes INTEGER NOT NULL DEFAULT 0 CHECK (reserved_db_bytes >= 0),
  storage_state TEXT NOT NULL DEFAULT 'normal' CHECK (storage_state IN ('normal', 'storage_limit', 'read_only')),
  export_lock INTEGER NOT NULL DEFAULT 0 CHECK (export_lock IN (0, 1)),
  export_lock_id TEXT,
  export_lock_expires_at INTEGER,
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  CHECK ((global_lease_token IS NULL AND global_lease_expires_at IS NULL)
      OR (global_lease_token IS NOT NULL AND global_lease_expires_at IS NOT NULL)),
  CHECK ((export_lock = 0 AND export_lock_id IS NULL AND export_lock_expires_at IS NULL)
      OR (export_lock = 1 AND export_lock_id IS NOT NULL AND export_lock_expires_at IS NOT NULL))
) STRICT;

CREATE TABLE storage_write_reservations (
  reservation_id TEXT PRIMARY KEY NOT NULL CHECK (length(reservation_id) BETWEEN 1 AND 128),
  write_kind TEXT NOT NULL CHECK (write_kind IN ('pending', 'article', 'source', 'run')),
  reserved_bytes INTEGER NOT NULL CHECK (reserved_bytes > 0),
  expires_at INTEGER NOT NULL CHECK (expires_at > 0),
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
) STRICT;

CREATE TABLE export_sessions (
  id TEXT PRIMARY KEY NOT NULL CHECK (length(id) BETWEEN 1 AND 128),
  snapshot_id TEXT NOT NULL CHECK (length(snapshot_id) BETWEEN 1 AND 128),
  export_watermark TEXT NOT NULL CHECK (length(export_watermark) BETWEEN 1 AND 128),
  cursor TEXT,
  expires_at INTEGER NOT NULL,
  state TEXT NOT NULL DEFAULT 'active' CHECK (state IN ('active', 'completed', 'expired', 'aborted')),
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
) STRICT;

INSERT INTO system_state (singleton_id) VALUES ('global');

CREATE INDEX idx_sources_due ON sources (enabled, next_fetch_at, id);
CREATE INDEX idx_pending_status_retry ON pending_items (status, next_attempt_at, discovered_at, id);
CREATE INDEX idx_pending_source_status ON pending_items (source_id, status, discovered_at, id);
CREATE INDEX idx_pending_terminal_expiry ON pending_items (terminal_expires_at)
  WHERE status IN ('blocked', 'failed');
CREATE INDEX idx_articles_published ON articles (published_at DESC, fetched_at DESC, id DESC);
CREATE INDEX idx_articles_source_published ON articles (source_id, published_at DESC, fetched_at DESC, id DESC);
CREATE INDEX idx_fetch_runs_started ON fetch_runs (started_at DESC, id DESC);
CREATE INDEX idx_fetch_runs_source_started ON fetch_runs (source_id, started_at DESC, id DESC);
CREATE INDEX idx_export_sessions_expires ON export_sessions (expires_at, state);
CREATE INDEX idx_storage_reservations_expiry ON storage_write_reservations (expires_at);

CREATE VIRTUAL TABLE articles_fts USING fts5 (
  article_id UNINDEXED,
  title,
  snippet,
  tokenize = 'unicode61'
);
