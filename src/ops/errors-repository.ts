import { sanitizeErrorCode, sanitizeErrorMessage } from "../runs/repository";

export const ERROR_MAX_LIMIT = 100;
export const ERROR_DEFAULT_LIMIT = 50;
export const PENDING_MAX_LIMIT = 100;
export const PENDING_DEFAULT_LIMIT = 50;
export const PENDING_STATUSES = ["pending", "retry_wait", "blocked", "failed"] as const;
export type PendingStatus = typeof PENDING_STATUSES[number];

export interface ErrorCursor { origin: string; sourceId: string; code: string; status: string }
export interface PendingCursor { discoveredAt: number; id: string }
export class InvalidOpsCursorError extends Error { constructor() { super("Invalid cursor"); this.name = "InvalidOpsCursorError"; } }

function encode(value: unknown): string { return btoa(JSON.stringify(value)).replace(/\+/gu, "-").replace(/\//gu, "_").replace(/=+$/u, ""); }
function decode(token: string): unknown {
  if (token.length === 0 || token.length > 1024 || !/^[A-Za-z0-9_-]+$/u.test(token)) throw new InvalidOpsCursorError();
  try { return JSON.parse(atob(token.replace(/-/gu, "+").replace(/_/gu, "/") + "=".repeat((4 - token.length % 4) % 4))) as unknown; } catch { throw new InvalidOpsCursorError(); }
}
export function encodeErrorCursor(value: ErrorCursor): string { return encode({ v: 1, ...value }); }
export function decodeErrorCursor(token: string): ErrorCursor {
  const value = decode(token);
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new InvalidOpsCursorError();
  const row = value as Record<string, unknown>;
  if (row.v !== 1 || typeof row.origin !== "string" || typeof row.sourceId !== "string" || typeof row.code !== "string" || typeof row.status !== "string") throw new InvalidOpsCursorError();
  return { origin: row.origin, sourceId: row.sourceId, code: row.code, status: row.status };
}
export function encodePendingCursor(value: PendingCursor): string { return encode({ v: 1, discovered_at: value.discoveredAt, id: value.id }); }
export function decodePendingCursor(token: string): PendingCursor {
  const value = decode(token);
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new InvalidOpsCursorError();
  const row = value as Record<string, unknown>;
  if (row.v !== 1 || typeof row.discovered_at !== "number" || typeof row.id !== "string" || !Number.isSafeInteger(row.discovered_at) || row.discovered_at < 0 || row.id.length < 1 || row.id.length > 128) throw new InvalidOpsCursorError();
  return { discoveredAt: row.discovered_at, id: row.id };
}

interface ErrorRow { origin: string; source_id: string; code: string | null; status: string; event_time: number; message: string | null; }
interface GroupRow { origin: string; source_id: string; code: string; status: string; count: number; first_time: number; last_time: number; samples: string; }
export interface ErrorGroup { origin: string; source_id: string; code: string; status: string; count: number; first_time: number; last_time: number; samples: Array<{ time: number; message: string | null }> }

export async function listErrorGroups(db: D1Database, limit: number, sourceId?: string, cursor?: ErrorCursor): Promise<{ errors: ErrorGroup[]; nextCursor: string | null }> {
  const bindings: unknown[] = [];
  const sourcePredicate = sourceId === undefined ? "" : "WHERE source_id = ?";
  if (sourceId !== undefined) bindings.push(sourceId);
  const cursorPredicate = cursor === undefined ? "" : "WHERE (origin > ? OR (origin = ? AND source_id > ?) OR (origin = ? AND source_id = ? AND code > ?) OR (origin = ? AND source_id = ? AND code = ? AND status > ?))";
  if (cursor !== undefined) bindings.push(cursor.origin, cursor.origin, cursor.sourceId, cursor.origin, cursor.sourceId, cursor.code, cursor.origin, cursor.sourceId, cursor.code, cursor.status);
  bindings.push(limit);
  const result = await db.prepare(`WITH events AS (
    SELECT 'run' AS origin, fetch_run_sources.source_id_snapshot AS source_id, fetch_run_sources.error_code AS raw_code, fetch_run_sources.status, fetch_runs.started_at AS event_time, fetch_run_sources.error_message AS message
    FROM fetch_run_sources JOIN fetch_runs ON fetch_runs.id = fetch_run_sources.run_id
    WHERE (fetch_run_sources.error_code IS NOT NULL OR fetch_run_sources.error_message IS NOT NULL) AND fetch_runs.started_at >= unixepoch() - (30 * 24 * 60 * 60) AND (? IS NULL OR fetch_run_sources.source_id_snapshot = ?)
    UNION ALL
    SELECT 'pending' AS origin, source_id, last_error_code AS raw_code, status, discovered_at AS event_time, last_error AS message
    FROM pending_items WHERE (last_error_code IS NOT NULL OR last_error IS NOT NULL) AND (? IS NULL OR source_id = ?)
  ), normalized AS (
    SELECT origin, source_id,
      CASE
        WHEN lower(trim(COALESCE(raw_code, ''))) GLOB '[a-z]*'
          AND lower(trim(COALESCE(raw_code, ''))) NOT GLOB '*[^a-z0-9_.-]*'
          AND length(lower(trim(COALESCE(raw_code, '')))) BETWEEN 1 AND 128
        THEN lower(trim(raw_code))
        ELSE 'unknown_error'
      END AS code,
      status, event_time, message
    FROM events
  ), filtered AS (SELECT * FROM normalized ${sourcePredicate ? "WHERE source_id = ?" : ""}), ranked AS (
    SELECT *, ROW_NUMBER() OVER (PARTITION BY origin, source_id, code, status ORDER BY event_time DESC) AS sample_rank
    FROM filtered
  ), grouped AS (
    SELECT origin, source_id, code, status, COUNT(*) AS count, MIN(event_time) AS first_time, MAX(event_time) AS last_time,
      json_group_array(json_object('time', event_time, 'message', message)) FILTER (WHERE sample_rank <= 3) AS samples
    FROM ranked GROUP BY origin, source_id, code, status
  ) SELECT origin, source_id, code, status, count, first_time, last_time, samples FROM grouped ${cursorPredicate} ORDER BY origin ASC, source_id ASC, code ASC, status ASC LIMIT ?`).bind(sourceId ?? null, sourceId ?? null, sourceId ?? null, sourceId ?? null, ...bindings).all<GroupRow>();
  const groups = result.results.map((row) => ({ ...row, count: Number(row.count), first_time: Number(row.first_time), last_time: Number(row.last_time), samples: (JSON.parse(row.samples) as Array<{ time: number; message: string | null }>).map((sample) => ({ time: Number(sample.time), message: sanitizeErrorMessage(sample.message) })) }));
  const last = groups.length === limit ? groups[groups.length - 1] : undefined;
  return { errors: groups, nextCursor: last ? encodeErrorCursor({ origin: last.origin, sourceId: last.source_id, code: last.code, status: last.status }) : null };
}

export interface PendingRow { id: string; source_id: string; item_type: string; title: string | null; status: PendingStatus; attempts: number; next_attempt_at: number; terminal_expires_at: number | null; error_code: string | null; error_message: string | null; discovered_at: number; }
export async function listPending(db: D1Database, limit: number, status?: PendingStatus, sourceId?: string, cursor?: PendingCursor): Promise<{ pending: Array<Omit<PendingRow, "discovered_at">>; nextCursor: string | null }> {
  const predicates = ["status IN ('pending', 'retry_wait', 'blocked', 'failed')"];
  const bindings: unknown[] = [];
  if (status !== undefined) { predicates.push("status = ?"); bindings.push(status); }
  if (sourceId !== undefined) { predicates.push("source_id = ?"); bindings.push(sourceId); }
  if (cursor !== undefined) { predicates.push("(discovered_at < ? OR (discovered_at = ? AND id < ?))"); bindings.push(cursor.discoveredAt, cursor.discoveredAt, cursor.id); }
  bindings.push(limit);
  const result = await db.prepare(`SELECT id, source_id, item_type, title, status, attempts, next_attempt_at, terminal_expires_at, last_error_code AS error_code, last_error AS error_message, discovered_at FROM pending_items WHERE ${predicates.join(" AND ")} ORDER BY discovered_at DESC, id DESC LIMIT ?`).bind(...bindings).all<PendingRow>();
  const rows = result.results.map((row) => ({ id: row.id, source_id: row.source_id, item_type: row.item_type, title: row.title, status: row.status, attempts: Number(row.attempts), next_attempt_at: Number(row.next_attempt_at), terminal_expires_at: row.terminal_expires_at === null ? null : Number(row.terminal_expires_at), error_code: row.error_code === null && row.error_message !== null ? "unknown_error" : sanitizeErrorCode(row.error_code), error_message: sanitizeErrorMessage(row.error_message), discovered_at: Number(row.discovered_at) }));
  const last = rows.length === limit ? rows[rows.length - 1] : undefined;
  return { pending: rows.map(({ discovered_at: _discoveredAt, ...safe }) => safe), nextCursor: last ? encodePendingCursor({ discoveredAt: last.discovered_at, id: last.id }) : null };
}
