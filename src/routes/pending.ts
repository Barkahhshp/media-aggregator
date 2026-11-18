import { Hono } from "hono";
import type { Context } from "hono";
import type { Env } from "../env";
import { decodePendingCursor, InvalidOpsCursorError, listPending, PENDING_DEFAULT_LIMIT, PENDING_MAX_LIMIT, PENDING_STATUSES } from "../ops/errors-repository";

export const pending = new Hono<{ Bindings: Env }>();
function badRequest(context: Context<{ Bindings: Env }>, message: string) { return context.json({ error: { code: "invalid_request", message, request_id: context.req.header("X-Request-Id") ?? crypto.randomUUID() } }, 400); }
function parseLimit(context: Context<{ Bindings: Env }>): number | Response { const raw = context.req.query("limit"); if (raw === undefined) return PENDING_DEFAULT_LIMIT; if (!/^\d+$/u.test(raw)) return badRequest(context, "Invalid limit"); const value = Number(raw); return Number.isSafeInteger(value) && value >= 1 && value <= PENDING_MAX_LIMIT ? value : badRequest(context, "Invalid limit"); }
pending.get("/v1/pending", async (context) => {
  const limit = parseLimit(context); if (limit instanceof Response) return limit;
  const status = context.req.query("status");
  if (status !== undefined && !(PENDING_STATUSES as readonly string[]).includes(status)) return badRequest(context, "Invalid status");
  let cursor; const token = context.req.query("cursor");
  if (token !== undefined) { try { cursor = decodePendingCursor(token); } catch (error) { if (error instanceof InvalidOpsCursorError) return badRequest(context, "Invalid cursor"); throw error; } }
  const result = await listPending(context.env.DB, limit, status as typeof PENDING_STATUSES[number] | undefined, context.req.query("source_id"), cursor);
  return context.json({ pending: result.pending, next_cursor: result.nextCursor });
});
