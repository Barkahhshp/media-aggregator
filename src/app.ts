import { Hono } from "hono";
import type { Env } from "./env";
import { health } from "./routes/health";

export function createApp(): Hono<{ Bindings: Env }> {
  const app = new Hono<{ Bindings: Env }>();
  app.route("/", health);
  return app;
}
