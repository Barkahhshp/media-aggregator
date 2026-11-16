import { Hono } from "hono";
import type { Env } from "./env";
import { authenticateLocal } from "./auth/local-token";
import { health } from "./routes/health";
import { sources } from "./routes/sources";

export function createApp(): Hono<{ Bindings: Env }> {
  const app = new Hono<{ Bindings: Env }>();
  app.use("/v1/*", async (context, next) => {
    const rejection = authenticateLocal(context.req.raw, context.env);
    if (rejection !== null) return rejection;
    await next();
  });
  app.route("/", health);
  app.route("/", sources);
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
