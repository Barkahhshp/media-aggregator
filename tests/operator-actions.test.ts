import { applyD1Migrations, reset } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import type { D1Migration } from "@cloudflare/vitest-plugin";
import { prepareOperatorAction, purgeExpiredOperatorActions } from "../src/audit/repository";

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

  it("prepares_bounded_field_name_only_actions_for_a_database_batch", async () => {
    const statement = prepareOperatorAction(testEnv.DB, {
      action: "source.updated",
      targetId: "source-1",
      changedFields: ["poll_interval_sec", "selectors"],
    });

    await testEnv.DB.batch([statement]);

    const action = await testEnv.DB.prepare(`
      SELECT actor, action, target_type, target_id, changed_fields_json
      FROM operator_actions WHERE target_id = 'source-1'
    `).first<{ actor: string; action: string; target_type: string; target_id: string; changed_fields_json: string }>();
    expect(action).toEqual({
      actor: "owner",
      action: "source.updated",
      target_type: "source",
      target_id: "source-1",
      changed_fields_json: '["poll_interval_sec","selectors"]',
    });
  });

  it("rejects_invalid_or_oversized_audit_input_before_preparing_sql", () => {
    expect(() => prepareOperatorAction(testEnv.DB, {
      action: "source.updated",
      targetId: "source-1",
      changedFields: ["https://example.com/private?token=secret"] as never,
    })).toThrow();
    expect(() => prepareOperatorAction(testEnv.DB, {
      action: "source.updated",
      targetId: "x".repeat(129),
      changedFields: ["url"],
    })).toThrow();
  });

  it("prepares_export_lifecycle_audits_with_field_names_only", async () => {
    const start = prepareOperatorAction(testEnv.DB, {
      action: "export.started",
      targetId: "export-session-id",
      changedFields: ["state", "snapshot_id", "expires_at", "snapshot_articles_count"],
    });
    const end = prepareOperatorAction(testEnv.DB, {
      action: "export.ended",
      targetId: "export-session-id",
      changedFields: ["state", "expires_at"],
    });

    await testEnv.DB.batch([start, end]);

    const actions = await testEnv.DB.prepare(`
      SELECT actor, action, target_type, target_id, changed_fields_json
      FROM operator_actions ORDER BY rowid
    `).all<{ actor: string; action: string; target_type: string; target_id: string; changed_fields_json: string }>();
    expect(actions.results).toEqual([
      {
        actor: "owner",
        action: "export.started",
        target_type: "export",
        target_id: "export-session-id",
        changed_fields_json: '["state","snapshot_id","expires_at","snapshot_articles_count"]',
      },
      {
        actor: "owner",
        action: "export.ended",
        target_type: "export",
        target_id: "export-session-id",
        changed_fields_json: '["state","expires_at"]',
      },
    ]);
    expect(JSON.stringify(actions.results)).not.toContain("secret");
    expect(() => prepareOperatorAction(testEnv.DB, {
      action: "export.started",
      targetId: "export-session-id",
      changedFields: ["https://example.com/private?token=secret"] as never,
    })).toThrow();
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
