import { Hono } from "hono";
import type { Env } from "./env";
import { authenticateWithRateLimitKey } from "./auth/local-token";
import { health } from "./routes/health";
import { sources } from "./routes/sources";
import { articles } from "./routes/articles";
import { exports } from "./routes/exports";
import { status } from "./routes/status";
import { runs } from "./routes/runs";
import { errors } from "./routes/errors";
import { pending } from "./routes/pending";

function withNoStore(response: Response): Response {
  response.headers.set("Cache-Control", "no-store");
  return response;
}

export function createApp(): Hono<{ Bindings: Env }> {
  const app = new Hono<{ Bindings: Env }>();
  app.use("/health", async (context, next) => {
    if (context.env.APP_ENV !== "production") return await next();
    const authenticated = await authenticateWithRateLimitKey(context.req.raw, context.env);
    if (typeof authenticated !== "string") return authenticated;
    await next();
  });
  app.use("/v1/*", async (context, next) => {
    context.header("Cache-Control", "no-store");
    const authenticated = await authenticateWithRateLimitKey(context.req.raw, context.env);
    if (typeof authenticated !== "string") return withNoStore(authenticated);
    try {
      const { success } = await context.env.RATE_LIMITER.limit({ key: authenticated });
      if (!success) {
        return withNoStore(context.json({
          error: { code: "rate_limit_exceeded", message: "Request rate limit exceeded", request_id: context.req.header("X-Request-Id") ?? crypto.randomUUID() },
        }, 429));
      }
    } catch {
      return withNoStore(context.json({
        error: { code: "rate_limiter_unavailable", message: "Request could not be processed", request_id: context.req.header("X-Request-Id") ?? crypto.randomUUID() },
      }, 503));
    }
    await next();
    return withNoStore(context.res);
  });
  app.route("/", health);
  app.route("/", sources);
  app.route("/", articles);
  app.route("/", exports);
  app.route("/", status);
  app.route("/", runs);
  app.route("/", errors);
  app.route("/", pending);
  app.onError((_error, context) => {
    const response = context.json(
      {
        error: {
          code: "internal_error",
          message: "Internal server error",
          request_id: context.req.header("X-Request-Id") ?? crypto.randomUUID(),
        },
      },
      500,
    );
    return /^\/v1(?:\/|$)/.test(context.req.path) ? withNoStore(response) : response;
  });
  return app;
}
