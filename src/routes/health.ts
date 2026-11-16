import { Hono } from "hono";
import type { Env } from "../env";

export const health = new Hono<{ Bindings: Env }>();

health.get("/health", (context) =>
  context.json({ status: "ok", service: "media-aggregator" }),
);
