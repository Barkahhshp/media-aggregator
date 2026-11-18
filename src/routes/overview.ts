import { Hono } from "hono";
import type { Env } from "../env";
import { getOverview } from "../ops/overview-repository";

export const overview = new Hono<{ Bindings: Env }>();

overview.get("/v1/overview", async (context) => {
  const now = Math.floor(Date.now() / 1000);
  return context.json(await getOverview(context.env.DB, now));
});
