import { Hono } from "hono";
import type { Context } from "hono";
import type { Env } from "../env";
import {
  decodeOperatorActionCursor,
  InvalidOperatorActionCursorError,
  listOperatorActions,
  OPERATOR_ACTION_DEFAULT_LIMIT,
  OPERATOR_ACTION_MAX_LIMIT,
} from "../audit/repository";

export const auditActions = new Hono<{ Bindings: Env }>();

function badRequest(context: Context<{ Bindings: Env }>, message: string): Response {
  return context.json({
    error: {
      code: "invalid_request",
      message,
      request_id: context.req.header("X-Request-Id") ?? crypto.randomUUID(),
    },
  }, 400);
}

function parseLimit(context: Context<{ Bindings: Env }>): number | Response {
  const raw = context.req.query("limit");
  if (raw === undefined) return OPERATOR_ACTION_DEFAULT_LIMIT;
  if (!/^\d+$/u.test(raw)) return badRequest(context, "Invalid limit");
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1 || value > OPERATOR_ACTION_MAX_LIMIT) {
    return badRequest(context, "Invalid limit");
  }
  return value;
}

auditActions.get("/v1/audit-actions", async (context) => {
  const limit = parseLimit(context);
  if (limit instanceof Response) return limit;
  let cursor: ReturnType<typeof decodeOperatorActionCursor> | undefined;
  const token = context.req.query("cursor");
  if (token !== undefined) {
    try {
      cursor = decodeOperatorActionCursor(token);
    } catch (error) {
      if (error instanceof InvalidOperatorActionCursorError) return badRequest(context, "Invalid cursor");
      throw error;
    }
  }
  const now = Math.floor(Date.now() / 1000);
  const result = await listOperatorActions(context.env.DB, limit, now, cursor);
  return context.json({ actions: result.actions, next_cursor: result.nextCursor });
});
