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
    throw new SourceRepositoryError(409, "source_limit_reached", "Maximum of 100 active sources reached");
  }
  return toSource(row);
}

export async function listSources(db: D1Database): Promise<Source[]> {
  const result = await db.prepare("SELECT * FROM sources ORDER BY created_at ASC, id ASC").all<SourceRow>();
  return result.results.map(toSource);
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
       SET url = ?, kind = ?, host = ?, poll_interval_sec = ?, selectors_json = ?, enabled = COALESCE(?, enabled), updated_at = unixepoch()
       WHERE id = ?
         AND (COALESCE(?, enabled) = 0 OR enabled = 1 OR (SELECT COUNT(*) FROM sources WHERE enabled = 1) < ?)
       RETURNING *`,
    )
    .bind(
      url.toString(),
      input.kind,
      url.hostname.toLowerCase(),
      input.poll_interval_sec,
      input.selectors === undefined ? null : JSON.stringify(input.selectors),
      nextEnabled,
      id,
      nextEnabled,
      MAX_ACTIVE_SOURCES,
    )
    .first<SourceRow>();

  if (row !== null) return toSource(row);
  const existing = await getSource(db, id);
  if (existing === null) return null;
  throw new SourceRepositoryError(409, "source_limit_reached", "Maximum of 100 active sources reached");
}

export async function disableSource(db: D1Database, id: string): Promise<Source | null> {
  const row = await db
    .prepare("UPDATE sources SET enabled = 0, updated_at = unixepoch() WHERE id = ? RETURNING *")
    .bind(id)
    .first<SourceRow>();
  return row === null ? null : toSource(row);
}
