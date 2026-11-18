import { applyD1Migrations, reset } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import type { D1Migration } from "@cloudflare/vitest-plugin";

interface TestEnvironment {
  DB: D1Database;
  RATE_LIMITER: RateLimit;
  APP_ENV: "test";
  API_TOKEN: string;
  TEST_MIGRATIONS: D1Migration[];
}

interface AuditAction {
  created_at: number;
  actor: string;
  action: string;
  target_type: string;
  target_id: string;
  changed_fields: string[];
}

interface AuditAppModule {
  createApp(): {
    request(input: string, init: RequestInit, env: TestEnvironment): Promise<Response> | Response;
  };
}

const testEnv: TestEnvironment = {
  ...(env as unknown as Omit<TestEnvironment, "API_TOKEN">),
  API_TOKEN: "local-test-token",
  RATE_LIMITER: { limit: async () => ({ success: true }) },
};
const appModules = import.meta.glob<AuditAppModule>("../src/app.ts");

async function loadApp() {
  const moduleLoader = appModules["../src/app.ts"];
  expect(moduleLoader).toBeDefined();
  if (!moduleLoader) return undefined;
  return (await moduleLoader()).createApp();
}

async function request(
  app: NonNullable<Awaited<ReturnType<typeof loadApp>>>,
  path: string,
  options: { token?: string | null } = {},
): Promise<Response> {
  const headers = new Headers();
  if (options.token !== null) headers.set("Authorization", `Bearer ${options.token ?? testEnv.API_TOKEN}`);
  return await app.request(path, { method: "GET", headers }, testEnv);
}

async function seedAction(
  id: string,
  createdAt: number,
  changedFields = ["url"],
  action = "source.updated",
  targetType = "source",
  targetId = "source-id",
): Promise<void> {
  await testEnv.DB.prepare(`
    INSERT INTO operator_actions (id, created_at, action, target_type, target_id, changed_fields_json)
    VALUES (?, ?, ?, ?, ?, ?)
  `).bind(id, createdAt, action, targetType, targetId, JSON.stringify(changedFields)).run();
}

beforeEach(async () => {
  await reset();
  await applyD1Migrations(testEnv.DB, testEnv.TEST_MIGRATIONS);
});

describe("audit actions API", () => {
  it("keyset_paginates_by_time_then_id_and_keeps_only_the_90_day_window", async () => {
    const app = await loadApp();
    if (!app) return;
    const now = Math.floor(Date.now() / 1000);
    const cutoff = now - 90 * 24 * 60 * 60;
    await seedAction("action-a", now, ["url"]);
    await seedAction("action-b", now, ["state", "snapshot_id"], "export.started", "export", "export-id");
    await seedAction("action-cutoff", cutoff, ["kind"]);
    await seedAction("action-old", cutoff - 1, ["poll_interval_sec"]);
    await seedAction("action-future", now + 1, ["selectors"]);

    const firstResponse = await request(app, "/v1/audit-actions?limit=1");
    expect(firstResponse.status).toBe(200);
    expect(firstResponse.headers.get("Cache-Control")).toBe("no-store");
    const first = await firstResponse.json<{ actions: AuditAction[]; next_cursor: string | null }>();
    expect(first.actions).toEqual([{
      created_at: now,
      actor: "owner",
      action: "export.started",
      target_type: "export",
      target_id: "export-id",
      changed_fields: ["state", "snapshot_id"],
    }]);
    expect(first.next_cursor).toBeTypeOf("string");

    const secondResponse = await request(app, `/v1/audit-actions?limit=1&cursor=${encodeURIComponent(first.next_cursor ?? "")}`);
    const second = await secondResponse.json<{ actions: AuditAction[]; next_cursor: string | null }>();
    expect(second.actions[0]).toMatchObject({ created_at: now, changed_fields: ["url"] });
    expect(second.next_cursor).toBeTypeOf("string");

    const thirdResponse = await request(app, `/v1/audit-actions?limit=1&cursor=${encodeURIComponent(second.next_cursor ?? "")}`);
    const third = await thirdResponse.json<{ actions: AuditAction[]; next_cursor: string | null }>();
    expect(third.actions).toEqual([{
      created_at: cutoff,
      actor: "owner",
      action: "source.updated",
      target_type: "source",
      target_id: "source-id",
      changed_fields: ["kind"],
    }]);
    expect(third.next_cursor).toBeTypeOf("string");
    const finalResponse = await request(app, `/v1/audit-actions?limit=1&cursor=${encodeURIComponent(third.next_cursor ?? "")}`);
    const final = await finalResponse.json<{ actions: AuditAction[]; next_cursor: string | null }>();
    expect(final.actions).toEqual([]);
    expect(final.next_cursor).toBeNull();
    expect(JSON.stringify([first, second, third, final])).not.toContain("action-old");
    expect(JSON.stringify([first, second, third, final])).not.toContain("action-future");
    expect(JSON.stringify([first, second, third, final])).not.toContain("changed_fields_json");
  });

  it("uses_a_default_limit_of_50_and_accepts_the_maximum_limit_of_100", async () => {
    const app = await loadApp();
    if (!app) return;
    const now = Math.floor(Date.now() / 1000);
    await testEnv.DB.batch(Array.from({ length: 55 }, (_, index) => {
      const id = `default-limit-${String(index).padStart(3, "0")}`;
      return testEnv.DB.prepare(`
        INSERT INTO operator_actions (id, created_at, action, target_type, target_id)
        VALUES (?, ?, 'source.updated', 'source', 'source-id')
      `).bind(id, now);
    }));

    const defaultResponse = await request(app, "/v1/audit-actions");
    const defaultPage = await defaultResponse.json<{ actions: AuditAction[]; next_cursor: string | null }>();
    expect(defaultResponse.status).toBe(200);
    expect(defaultPage.actions).toHaveLength(50);
    expect(defaultPage.next_cursor).toBeTypeOf("string");

    const maximumResponse = await request(app, "/v1/audit-actions?limit=100");
    const maximumPage = await maximumResponse.json<{ actions: AuditAction[]; next_cursor: string | null }>();
    expect(maximumResponse.status).toBe(200);
    expect(maximumPage.actions).toHaveLength(55);
    expect(maximumPage.next_cursor).toBeNull();
  });

  it("rejects_missing_or_wrong_auth_and_invalid_pagination_without_caching", async () => {
    const app = await loadApp();
    if (!app) return;

    for (const options of [{ token: null }, { token: "wrong-token" }]) {
      const response = await request(app, "/v1/audit-actions", options);
      expect(response.status).toBe(401);
      expect(response.headers.get("Cache-Control")).toBe("no-store");
      const body = await response.text();
      expect(body).not.toContain(testEnv.API_TOKEN);
      if (options.token !== null) expect(body).not.toContain(options.token ?? "");
    }

    for (const path of ["/v1/audit-actions?limit=0", "/v1/audit-actions?limit=101", "/v1/audit-actions?cursor=not-a-cursor"]) {
      const response = await request(app, path);
      expect(response.status).toBe(400);
      expect(response.headers.get("Cache-Control")).toBe("no-store");
    }
  });
});
