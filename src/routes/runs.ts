import { Hono } from "hono";
import type { Context } from "hono";
import type { Env } from "../env";
import { decodeRunCursor, encodeRunCursor, InvalidRunCursorError, RUN_STATUSES, sanitizeErrorCode, sanitizeErrorMessage } from "../runs/repository";

interface RunRow {
  id: string;
  source_id: string | null;
  started_at: number;
  finished_at: number | null;
  status: string;
  http_status: number | null;
  discovered_count: number;
  stored_count: number;
  error_code: string | null;
  error_message: string | null;
}

interface SourceRow {
  source_id_snapshot: string;
  status: string;
  http_status: number | null;
  discovered_count: number;
  stored_count: number;
  error_code: string | null;
  error_message: string | null;
}

export const runs = new Hono<{ Bindings: Env }>();
const MAX_LIMIT = 100;
const DEFAULT_LIMIT = 50;
const RETENTION_SECONDS = 30 * 86400;

function badRequest(context: Context<{ Bindings: Env }>, message: string) {
  return context.json({ error: { code: "invalid_request", message, request_id: context.req.header("X-Request-Id") ?? crypto.randomUUID() } }, 400);
}

function parseLimit(context: Context<{ Bindings: Env }>): number | Response {
  const raw = context.req.query("limit");
  if (raw === undefined) return DEFAULT_LIMIT;
  if (!/^\d+$/u.test(raw)) return badRequest(context, "Invalid limit");
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_LIMIT) return badRequest(context, "Invalid limit");
  return value;
}

function durationSeconds(row: RunRow, now: number): number {
  return Math.max(0, (row.finished_at ?? now) - row.started_at);
}

function sanitizeErrorFields<T extends { error_code: string | null; error_message: string | null }>(row: T): T {
  return { ...row, error_code: sanitizeErrorCode(row.error_code), error_message: sanitizeErrorMessage(row.error_message) };
}

runs.get("/v1/runs", async (context) => {
  const limit = parseLimit(context);
  if (limit instanceof Response) return limit;
  const status = context.req.query("status");
  if (status !== undefined && !(RUN_STATUSES as readonly string[]).includes(status)) return badRequest(context, "Invalid status");
  const sourceId = context.req.query("source_id");
  let cursor: ReturnType<typeof decodeRunCursor> | undefined;
  const cursorToken = context.req.query("cursor");
  if (cursorToken !== undefined) {
    try { cursor = decodeRunCursor(cursorToken); } catch (error) {
      if (error instanceof InvalidRunCursorError) return badRequest(context, "Invalid cursor");
      throw error;
    }
  }
  const now = Math.floor(Date.now() / 1000);
  const bindings: unknown[] = [now - RETENTION_SECONDS];
  const predicates = ["started_at >= ?"];
  if (status !== undefined) { predicates.push("status = ?"); bindings.push(status); }
  if (sourceId !== undefined) {
    predicates.push("EXISTS (SELECT 1 FROM fetch_run_sources AS source_filter INDEXED BY idx_fetch_run_sources_source_run WHERE source_filter.run_id = fetch_runs.id AND source_filter.source_id_snapshot = ?)");
    bindings.push(sourceId);
  }
  if (cursor !== undefined) {
    predicates.push("(started_at < ? OR (started_at = ? AND id < ?))");
    bindings.push(cursor.startedAt, cursor.startedAt, cursor.id);
  }
  bindings.push(limit);
  const result = await context.env.DB.prepare(`SELECT id, source_id, started_at, finished_at, status, http_status, discovered_count, stored_count, error_code, error_message FROM fetch_runs WHERE ${predicates.join(" AND ")} ORDER BY started_at DESC, id DESC LIMIT ?`).bind(...bindings).all<RunRow>();
  const rows = result.results;
  const next = rows.length === limit ? rows[rows.length - 1] : undefined;
  return context.json({
    runs: rows.map((row) => ({ ...sanitizeErrorFields(row), duration_seconds: durationSeconds(row, now) })),
    next_cursor: next ? encodeRunCursor({ startedAt: Number(next.started_at), id: next.id }) : null,
  });
});

runs.get("/v1/runs/:id", async (context) => {
  const id = context.req.param("id");
  const row = await context.env.DB.prepare("SELECT id, source_id, started_at, finished_at, status, http_status, discovered_count, stored_count, error_code, error_message FROM fetch_runs WHERE id = ?").bind(id).first<RunRow>();
  if (row === null) return context.json({ error: { code: "run_not_found", message: "Run not found", request_id: context.req.header("X-Request-Id") ?? crypto.randomUUID() } }, 404);
  const sources = await context.env.DB.prepare("SELECT source_id_snapshot, status, http_status, discovered_count, stored_count, error_code, error_message FROM fetch_run_sources WHERE run_id = ? ORDER BY source_id_snapshot ASC").bind(id).all<SourceRow>();
  const now = Math.floor(Date.now() / 1000);
  return context.json({ run: { ...sanitizeErrorFields(row), duration_seconds: durationSeconds(row, now) }, sources: sources.results.map(sanitizeErrorFields) });
});
