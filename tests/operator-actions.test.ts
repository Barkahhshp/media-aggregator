import { applyD1Migrations, reset } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import type { D1Migration } from "@cloudflare/vitest-plugin";
import { purgeExpiredOperatorActions } from "../src/audit/repository";

interface TestBindings {
  DB: D1Database;
  TEST_MIGRATIONS: D1Migration[];
}

const testEnv = env as unknown as TestBindings;
const NINETY_DAYS = 90 * 24 * 60 * 60;

beforeEach(async () => {
  await reset();
  await applyD1Migrations(testEnv.DB, testEnv.TEST_MIGRATIONS);
});

describe("operator action retention", () => {
  it("purges only audit rows older than 90 days", async () => {
    const now = Math.floor(Date.now() / 1000);
    await testEnv.DB.prepare(`
      INSERT INTO operator_actions (id, created_at, action, target_type, target_id)
      VALUES ('expired-action', ?, 'source.updated', 'source', 'source-old')
    `).bind(now - NINETY_DAYS - 1).run();
    await testEnv.DB.prepare(`
      INSERT INTO operator_actions (id, created_at, action, target_type, target_id)
      VALUES ('retained-action', ?, 'source.updated', 'source', 'source-recent')
    `).bind(now - NINETY_DAYS + 1).run();

    const deleted = await purgeExpiredOperatorActions(testEnv.DB, now);

    expect(deleted).toBe(1);
    const remaining = await testEnv.DB.prepare("SELECT id FROM operator_actions ORDER BY id")
      .all<{ id: string }>();
    expect(remaining.results).toEqual([{ id: "retained-action" }]);
  });

  it("safely retains_rows_when_execution_and_database_clocks_disagree", async () => {
    const databaseNow = Math.floor(Date.now() / 1000);
    await testEnv.DB.prepare(`
      INSERT INTO operator_actions (id, created_at, action, target_type, target_id)
      VALUES ('clock-skew-action', ?, 'source.updated', 'source', 'source-clock-skew')
    `).bind(databaseNow - 89 * 24 * 60 * 60).run();

    const deleted = await purgeExpiredOperatorActions(testEnv.DB, databaseNow + 365 * 24 * 60 * 60);

    expect(deleted).toBe(0);
    expect(await testEnv.DB.prepare("SELECT id FROM operator_actions WHERE id = 'clock-skew-action'").first())
      .toEqual({ id: "clock-skew-action" });
  });
});
