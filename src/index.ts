import { createApp } from "./app";
import type { Env } from "./env";

const app = createApp();

export default {
  async fetch(request: Request, env: Env, context: ExecutionContext): Promise<Response> {
    return app.fetch(request, env, context);
  },
  scheduled(
    _event: ScheduledController,
    _env: Env,
    _context: ExecutionContext,
  ): void {
    // Scheduled ingestion is added in Task 5.
  },
} satisfies ExportedHandler<Env>;
