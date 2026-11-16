import type { ArticleSelectors, Source, SourceInput, SourceKind } from "./types";
import { MAX_ACTIVE_SOURCES } from "./validation";

interface SourceRow {
  id: string;
  url: string;
  kind: SourceKind;
  host: string;
  poll_interval_sec: number;
  selectors_json: string | null;
  enabled: number;
  next_fetch_at: number;
  etag: string | null;
  last_modified: string | null;
  feed_watermark: string | null;
  sitemap_last_loc: string | null;
  consecutive_errors: number;
  last_status: string | null;
  last_fetched_at: number | null;
  created_at: number;
  updated_at: number;
}

export class SourceRepositoryError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "SourceRepositoryError";
  }
}

function toSource(row: SourceRow): Source {
  let selectors: ArticleSelectors | null = null;
  if (row.selectors_json !== null) selectors = JSON.parse(row.selectors_json) as ArticleSelectors;
  return {
    id: row.id,
    url: row.url,
    kind: row.kind,
    host: row.host,
    poll_interval_sec: row.poll_interval_sec,
    selectors,
    enabled: row.enabled === 1,
    next_fetch_at: row.next_fetch_at,
    etag: row.etag,
    last_modified: row.last_modified,
    feed_watermark: row.feed_watermark,
    sitemap_last_loc: row.sitemap_last_loc,
    consecutive_errors: row.consecutive_errors,
    last_status: row.last_status,
    last_fetched_at: row.last_fetched_at,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export async function getSource(db: D1Database, id: string): Promise<Source | null> {
  const row = await db.prepare("SELECT * FROM sources WHERE id = ?").bind(id).first<SourceRow>();
  return row === null ? null : toSource(row);
}

export async function createSource(db: D1Database, input: SourceInput): Promise<Source> {
  const url = new URL(input.url);
  const row = await db
    .prepare(
      `INSERT INTO sources (id, url, kind, host, poll_interval_sec, selectors_json)
       SELECT ?, ?, ?, ?, ?, ?
       WHERE (SELECT COUNT(*) FROM sources WHERE enabled = 1) < ?
         AND NOT EXISTS (
           SELECT 1 FROM system_state
           WHERE singleton_id = 'global' AND export_lock = 1 AND export_lock_expires_at > unixepoch()
         )
       RETURNING *`,
    )
    .bind(
      crypto.randomUUID(),
      url.toString(),
      input.kind,
      url.hostname.toLowerCase(),
      input.poll_interval_sec,
      input.selectors === undefined ? null : JSON.stringify(input.selectors),
      MAX_ACTIVE_SOURCES,
    )
    .first<SourceRow>();

  if (row === null) {
    const lock = await db.prepare("SELECT export_lock, export_lock_expires_at FROM system_state WHERE singleton_id = 'global'")
      .first<{ export_lock: number; export_lock_expires_at: number | null }>();
    if (lock?.export_lock === 1 && (lock.export_lock_expires_at ?? 0) > Math.floor(Date.now() / 1000)) {
      throw new SourceRepositoryError(423, "export_in_progress", "Source changes are paused during export");
    }
    throw new SourceRepositoryError(409, "source_limit_reached", "Maximum of 100 active sources reached");
  }
  return toSource(row);
}

export interface SourceWithBacklog extends Source {
  pending_count: number;
  oldest_pending_at: number | null;
}

export async function listSources(db: D1Database): Promise<SourceWithBacklog[]> {
  const result = await db.prepare(`
    SELECT source.*,
      (SELECT COUNT(*) FROM pending_items AS pending
       WHERE pending.source_id = source.id AND pending.status IN ('pending', 'leased', 'retry_wait')) AS pending_count,
      (SELECT MIN(pending.discovered_at) FROM pending_items AS pending
       WHERE pending.source_id = source.id AND pending.status IN ('pending', 'leased', 'retry_wait')) AS oldest_pending_at
    FROM sources AS source
    ORDER BY source.created_at ASC, source.id ASC
  `).all<SourceRow & { pending_count: number; oldest_pending_at: number | null }>();
  return result.results.map((row) => ({
    ...toSource(row),
    pending_count: row.pending_count,
    oldest_pending_at: row.oldest_pending_at,
  }));
}

export async function updateSource(
  db: D1Database,
  id: string,
  input: SourceInput,
  enabled?: boolean,
): Promise<Source | null> {
  const url = new URL(input.url);
  const nextEnabled = enabled === undefined ? null : Number(enabled);
  const row = await db
    .prepare(
      `UPDATE sources
       SET url = ?, kind = ?, host = ?, poll_interval_sec = ?, selectors_json = ?, enabled = COALESCE(?, enabled),
           last_status = CASE
             WHEN COALESCE(?, enabled) = 0 THEN 'disabled_source'
             WHEN COALESCE(?, enabled) = 1 AND last_status = 'disabled_source' THEN NULL
             ELSE last_status
           END,
           updated_at = unixepoch()
       WHERE id = ?
         AND (COALESCE(?, enabled) = 0 OR enabled = 1 OR (SELECT COUNT(*) FROM sources WHERE enabled = 1) < ?)
         AND NOT EXISTS (
           SELECT 1 FROM system_state
           WHERE singleton_id = 'global' AND export_lock = 1 AND export_lock_expires_at > unixepoch()
         )
       RETURNING *`,
    )
    .bind(
      url.toString(),
      input.kind,
      url.hostname.toLowerCase(),
      input.poll_interval_sec,
      input.selectors === undefined ? null : JSON.stringify(input.selectors),
      nextEnabled,
      nextEnabled,
      nextEnabled,
      id,
      nextEnabled,
      MAX_ACTIVE_SOURCES,
    )
    .first<SourceRow>();

  if (row !== null) return toSource(row);
  const lock = await db.prepare("SELECT export_lock, export_lock_expires_at FROM system_state WHERE singleton_id = 'global'")
    .first<{ export_lock: number; export_lock_expires_at: number | null }>();
  if (lock?.export_lock === 1 && (lock.export_lock_expires_at ?? 0) > Math.floor(Date.now() / 1000)) {
    throw new SourceRepositoryError(423, "export_in_progress", "Source changes are paused during export");
  }
  const existing = await getSource(db, id);
  if (existing === null) return null;
  throw new SourceRepositoryError(409, "source_limit_reached", "Maximum of 100 active sources reached");
}

export async function disableSource(db: D1Database, id: string): Promise<Source | null> {
  const row = await db
    .prepare(`
      UPDATE sources SET enabled = 0, last_status = 'disabled_source', updated_at = unixepoch()
      WHERE id = ? AND NOT EXISTS (
        SELECT 1 FROM system_state
        WHERE singleton_id = 'global' AND export_lock = 1 AND export_lock_expires_at > unixepoch()
      )
      RETURNING *
    `)
    .bind(id)
    .first<SourceRow>();
  if (row === null) {
    const lock = await db.prepare("SELECT export_lock, export_lock_expires_at FROM system_state WHERE singleton_id = 'global'")
      .first<{ export_lock: number; export_lock_expires_at: number | null }>();
    if (lock?.export_lock === 1 && (lock.export_lock_expires_at ?? 0) > Math.floor(Date.now() / 1000)) {
      throw new SourceRepositoryError(423, "export_in_progress", "Source changes are paused during export");
    }
  }
  return row === null ? null : toSource(row);
}
