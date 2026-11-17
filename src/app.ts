import { Hono } from "hono";
import type { Env } from "./env";
import { authenticateLocal, rateLimitKey } from "./auth/local-token";
import { health } from "./routes/health";
import { sources } from "./routes/sources";
import { articles } from "./routes/articles";
import { exports } from "./routes/exports";
import { status } from "./routes/status";

export function createApp(): Hono<{ Bindings: Env }> {
  const app = new Hono<{ Bindings: Env }>();
  app.use("/v1/*", async (context, next) => {
    let access: CloudflareAccessContext | undefined;
    try {
      access = (context.executionCtx as ExecutionContext & { access?: CloudflareAccessContext }).access;
    } catch {
      access = undefined;
    }
    const rejection = await authenticateLocal(context.req.raw, context.env, access);
    if (rejection !== null) return rejection;
    const key = await rateLimitKey(context.req.raw, context.env, access);
    if (key === null) {
      return context.json({
        error: { code: "unauthorized", message: "Authentication required", request_id: context.req.header("X-Request-Id") ?? crypto.randomUUID() },
      }, 401);
    }
    try {
      const { success } = await context.env.RATE_LIMITER.limit({ key });
      if (!success) {
        return context.json({
          error: { code: "rate_limit_exceeded", message: "Request rate limit exceeded", request_id: context.req.header("X-Request-Id") ?? crypto.randomUUID() },
        }, 429);
      }
    } catch {
      return context.json({
        error: { code: "rate_limiter_unavailable", message: "Request could not be processed", request_id: context.req.header("X-Request-Id") ?? crypto.randomUUID() },
      }, 503);
    }
    await next();
  });
  app.route("/", health);
  app.route("/", sources);
  app.route("/", articles);
  app.route("/", exports);
  app.route("/", status);
  app.onError((_error, context) => {
    return context.json(
      {
        error: {
          code: "internal_error",
          message: "Internal server error",
          request_id: context.req.header("X-Request-Id") ?? crypto.randomUUID(),
        },
      },
      500,
    );
  });
  return app;
}
