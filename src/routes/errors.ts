import { Hono } from "hono";
import type { Context } from "hono";
import type { Env } from "../env";
import { decodeErrorCursor, ERROR_DEFAULT_LIMIT, ERROR_MAX_LIMIT, InvalidOpsCursorError, listErrorGroups } from "../ops/errors-repository";

export const errors = new Hono<{ Bindings: Env }>();
function badRequest(context: Context<{ Bindings: Env }>, message: string) { return context.json({ error: { code: "invalid_request", message, request_id: context.req.header("X-Request-Id") ?? crypto.randomUUID() } }, 400); }
function parseLimit(context: Context<{ Bindings: Env }>): number | Response { const raw = context.req.query("limit"); if (raw === undefined) return ERROR_DEFAULT_LIMIT; if (!/^\d+$/u.test(raw)) return badRequest(context, "Invalid limit"); const value = Number(raw); return Number.isSafeInteger(value) && value >= 1 && value <= ERROR_MAX_LIMIT ? value : badRequest(context, "Invalid limit"); }
errors.get("/v1/errors", async (context) => {
  const limit = parseLimit(context); if (limit instanceof Response) return limit;
  let cursor; const token = context.req.query("cursor");
  if (token !== undefined) { try { cursor = decodeErrorCursor(token); } catch (error) { if (error instanceof InvalidOpsCursorError) return badRequest(context, "Invalid cursor"); throw error; } }
  const result = await listErrorGroups(context.env.DB, limit, context.req.query("source_id"), cursor);
  return context.json({ errors: result.errors, next_cursor: result.nextCursor });
});
