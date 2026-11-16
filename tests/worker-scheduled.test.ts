import { applyD1Migrations, reset } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { D1Migration } from "@cloudflare/vitest-plugin";

interface TestEnvironment {
  DB: D1Database;
  APP_ENV: "test";
  TEST_MIGRATIONS: D1Migration[];
}

interface WorkerModule {
  default: {
    scheduled(event: { scheduledTime: number }, env: TestEnvironment, context: { waitUntil(promise: Promise<unknown>): void }): void;
  };
}

const testEnv = env as unknown as TestEnvironment;
const modules = import.meta.glob<WorkerModule>("../src/index.ts");

beforeEach(async () => {
  vi.restoreAllMocks();
  await reset();
  await applyD1Migrations(testEnv.DB, testEnv.TEST_MIGRATIONS);
});

describe("Worker scheduled entrypoint", () => {
  it("hands_the_Cron_run_to_execution_context_waitUntil", async () => {
    const load = modules["../src/index.ts"];
    expect(load).toBeDefined();
    if (!load) return;
    const worker = await load();
    const promises: Promise<unknown>[] = [];
    const scheduledTime = Date.now();
    vi.stubGlobal("fetch", vi.fn(async () => new Response("<rss><channel></channel></rss>", {
      status: 200,
      headers: { "Content-Type": "application/rss+xml" },
    })));

    worker.default.scheduled({ scheduledTime }, testEnv, { waitUntil: (promise) => { promises.push(promise); } });
    await Promise.all(promises);

    expect(promises).toHaveLength(1);
    expect(await testEnv.DB.prepare("SELECT started_at FROM fetch_runs").first())
      .toMatchObject({ started_at: Math.floor(scheduledTime / 1000) });
  });
});
