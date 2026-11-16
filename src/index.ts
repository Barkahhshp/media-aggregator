import { createApp } from "./app";
import type { Env } from "./env";
import { runScheduled } from "./ingest/scheduler";

const app = createApp();

export default {
  async fetch(request: Request, env: Env, context: ExecutionContext): Promise<Response> {
    return app.fetch(request, env, context);
  },
  scheduled(
    event: ScheduledController,
    env: Env,
    context: ExecutionContext,
  ): void {
    context.waitUntil(runScheduled(env, event.scheduledTime));
  },
} satisfies ExportedHandler<Env>;
