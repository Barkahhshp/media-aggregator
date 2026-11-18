import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { D1Migration } from "@cloudflare/vitest-plugin";

interface TestBindings {
  DB: D1Database;
  TEST_MIGRATIONS: D1Migration[];
}

const testEnv = env as unknown as TestBindings;

const requiredTables = [
  "articles",
  "articles_fts",
  "export_sessions",
  "fetch_run_sources",
  "fetch_runs",
  "operator_actions",
  "pending_items",
  "sources",
  "system_state",
];

const requiredIndexes = [
  "idx_articles_published",
  "idx_articles_source_published",
  "idx_export_sessions_expires",
  "idx_fetch_run_sources_source_run",
  "idx_fetch_runs_source_started",
  "idx_fetch_runs_started",
  "idx_operator_actions_created_id",
  "idx_pending_error_group",
  "idx_pending_source_status",
  "idx_pending_status_retry",
  "idx_pending_terminal_expiry",
  "idx_sources_due",
];

async function insertSource(id: string): Promise<void> {
  await testEnv.DB
    .prepare("INSERT INTO sources (id, url, kind, host) VALUES (?, ?, 'feed', 'example.com')")
    .bind(id, `https://example.com/${id}/feed`)
    .run();
}

describe("D1 migrations", () => {
  it("backfills_recognized_legacy_error_codes_and_preserves_unknown_messages", async () => {
    const priorMigrations = testEnv.TEST_MIGRATIONS.slice(0, 2);
    const telemetryMigration = testEnv.TEST_MIGRATIONS.slice(2);
    await applyD1Migrations(testEnv.DB, priorMigrations);

    const sourceId = `legacy-source-${crypto.randomUUID()}`;
    await insertSource(sourceId);
    const rows = [
      { id: "known", lastError: "parse_error: Legacy parse failure" },
      { id: "unknown", lastError: "private-detail: Leave this message unchanged" },
      { id: "malformed", lastError: "legacy error without a code separator" },
    ];
    for (const row of rows) {
      await testEnv.DB.prepare(`
        INSERT INTO pending_items (id, source_id, item_type, dedupe_key, canonical_url, last_error)
        VALUES (?, ?, 'article', ?, ?, ?)
      `).bind(
        `${sourceId}-${row.id}`,
        sourceId,
        `https://example.com/${row.id}`,
        `https://example.com/${row.id}`,
        row.lastError,
      ).run();
    }

    await applyD1Migrations(testEnv.DB, telemetryMigration);

    const migrated = await testEnv.DB.prepare(`
      SELECT id, last_error, last_error_code FROM pending_items
      WHERE source_id = ? ORDER BY id
    `).bind(sourceId).all<{ id: string; last_error: string; last_error_code: string | null }>();
    expect(migrated.results).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: `${sourceId}-known`, last_error: "parse_error: Legacy parse failure", last_error_code: "parse_error" }),
      expect.objectContaining({ id: `${sourceId}-unknown`, last_error: "private-detail: Leave this message unchanged", last_error_code: null }),
      expect.objectContaining({ id: `${sourceId}-malformed`, last_error: "legacy error without a code separator", last_error_code: null }),
    ]));
  });

  it("migration_creates_required_tables_and_indexes", async () => {
    await applyD1Migrations(testEnv.DB, testEnv.TEST_MIGRATIONS);

    const result = await testEnv.DB
      .prepare("SELECT type, name FROM sqlite_master WHERE type IN ('table', 'index') AND name NOT LIKE 'sqlite_%'")
      .all<{ type: string; name: string }>();
    const tables = result.results.filter((row) => row.type === "table").map((row) => row.name);
    const indexes = result.results.filter((row) => row.type === "index").map((row) => row.name);

    expect(tables).toEqual(expect.arrayContaining(requiredTables));
    expect(indexes).toEqual(expect.arrayContaining(requiredIndexes));
  });

  it("published_at_rejects_values_over_64_utf8_bytes", async () => {
    await applyD1Migrations(testEnv.DB, testEnv.TEST_MIGRATIONS);

    const sourceId = crypto.randomUUID();
    await insertSource(sourceId);

    const tooLong = "x".repeat(65);
    await expect(
      testEnv.DB
        .prepare("INSERT INTO pending_items (id, source_id, item_type, dedupe_key, canonical_url, published_at) VALUES (?, ?, ?, ?, ?, ?)")
        .bind(crypto.randomUUID(), sourceId, "article", crypto.randomUUID(), "https://example.com/pending", tooLong)
        .run(),
    ).rejects.toThrow(/CHECK constraint failed/);

    await expect(
      testEnv.DB
        .prepare("INSERT INTO articles (id, source_id, canonical_url, title, content_text, content_hash, published_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
        .bind(crypto.randomUUID(), sourceId, "https://example.com/article", "Test", "", "hash", tooLong)
        .run(),
    ).rejects.toThrow(/CHECK constraint failed/);
  });

  it("creates_the_shared_storage_write_reservation_state", async () => {
    await applyD1Migrations(testEnv.DB, testEnv.TEST_MIGRATIONS);

    const columns = await testEnv.DB.prepare("PRAGMA table_info(system_state)").all<{ name: string }>();
    const reservationTable = await testEnv.DB.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'storage_write_reservations'")
      .first<{ name: string }>();
    const reservationIndex = await testEnv.DB.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_storage_reservations_expiry'")
      .first<{ name: string }>();

    expect(columns.results.map((column) => column.name)).toContain("reserved_db_bytes");
    expect(reservationTable?.name).toBe("storage_write_reservations");
    expect(reservationIndex?.name).toBe("idx_storage_reservations_expiry");
  });

  it("stores_a_bounded_cursor_on_each_pending_sitemap_item", async () => {
    await applyD1Migrations(testEnv.DB, testEnv.TEST_MIGRATIONS);

    const columns = await testEnv.DB.prepare("PRAGMA table_info(pending_items)").all<{ name: string }>();
    expect(columns.results.map((column) => column.name)).toContain("sitemap_cursor");

    await testEnv.DB.prepare("INSERT INTO sources (id, url, kind, host) VALUES ('sitemap-source', 'https://example.com/sitemap.xml', 'sitemap', 'example.com')").run();
    await expect(testEnv.DB.prepare(`
      INSERT INTO pending_items (id, source_id, item_type, dedupe_key, canonical_url, sitemap_cursor)
      VALUES ('oversized-child-cursor', 'sitemap-source', 'sitemap', 'https://example.com/child.xml', 'https://example.com/child.xml', ?)
    `).bind("x".repeat(4097)).run()).rejects.toThrow(/CHECK constraint failed/);
  });

  it("adds_a_nullable_utf8_byte_bounded_pending_error_code", async () => {
    await applyD1Migrations(testEnv.DB, testEnv.TEST_MIGRATIONS);

    const columns = await testEnv.DB.prepare("PRAGMA table_info(pending_items)").all<{ name: string; notnull: number }>();
    const errorCode = columns.results.find((column) => column.name === "last_error_code");
    expect(errorCode).toBeDefined();
    expect(errorCode?.notnull).toBe(0);

    const sourceId = `error-code-source-${crypto.randomUUID()}`;
    await insertSource(sourceId);
    await expect(testEnv.DB.prepare(`
      INSERT INTO pending_items (id, source_id, item_type, dedupe_key, canonical_url, last_error_code)
      VALUES (?, ?, 'article', ?, ?, ?)
    `).bind("oversized-error-code", sourceId, "https://example.com/x", "https://example.com/x", "é".repeat(65)).run())
      .rejects.toThrow(/CHECK constraint failed/);
  });

  it("enforces_fetch_run_source_uniqueness_and_foreign_key_retention", async () => {
    await applyD1Migrations(testEnv.DB, testEnv.TEST_MIGRATIONS);

    const sourceId = `summary-source-${crypto.randomUUID()}`;
    const runId = `summary-run-${crypto.randomUUID()}`;
    await insertSource(sourceId);
    await testEnv.DB.prepare("INSERT INTO fetch_runs (id, status) VALUES (?, 'succeeded')").bind(runId).run();

    const insertSummary = testEnv.DB.prepare(`
      INSERT INTO fetch_run_sources (
        run_id, source_id_snapshot, source_id, status, http_status,
        discovered_count, stored_count, error_code, error_message
      ) VALUES (?, ?, ?, 'partial', 503, 2, 1, 'http_503', 'Upstream returned HTTP 503')
    `).bind(runId, sourceId, sourceId);
    await insertSummary.run();
    await expect(insertSummary.run()).rejects.toThrow(/UNIQUE constraint failed/);
    await expect(testEnv.DB.prepare(`
      INSERT INTO fetch_run_sources (run_id, source_id_snapshot, status, http_status)
      VALUES (?, 'invalid-http-source', 'succeeded', 99)
    `).bind(runId).run()).rejects.toThrow(/CHECK constraint failed/);
    await expect(testEnv.DB.prepare(`
      INSERT INTO fetch_run_sources (run_id, source_id_snapshot, status, http_status)
      VALUES (?, 'high-http-source', 'succeeded', 600)
    `).bind(runId).run()).rejects.toThrow(/CHECK constraint failed/);
    await expect(testEnv.DB.prepare(`
      INSERT INTO fetch_run_sources (run_id, source_id_snapshot, status)
      VALUES (?, '', 'succeeded')
    `).bind(runId).run()).rejects.toThrow(/CHECK constraint failed/);
    await expect(testEnv.DB.prepare(`
      INSERT INTO fetch_run_sources (run_id, source_id_snapshot, status)
      VALUES (?, 'invalid-status-source', 'unknown')
    `).bind(runId).run()).rejects.toThrow(/CHECK constraint failed/);
    await expect(testEnv.DB.prepare(`
      INSERT INTO fetch_run_sources (run_id, source_id_snapshot, status)
      VALUES (?, ?, 'succeeded')
    `).bind(runId, "x".repeat(129)).run()).rejects.toThrow(/CHECK constraint failed/);
    await expect(testEnv.DB.prepare(`
      INSERT INTO fetch_run_sources (run_id, source_id_snapshot, status, discovered_count)
      VALUES (?, 'negative-count-source', 'succeeded', -1)
    `).bind(runId).run()).rejects.toThrow(/CHECK constraint failed/);
    await expect(testEnv.DB.prepare(`
      INSERT INTO fetch_run_sources (run_id, source_id_snapshot, status, stored_count)
      VALUES (?, 'negative-stored-count-source', 'succeeded', -1)
    `).bind(runId).run()).rejects.toThrow(/CHECK constraint failed/);
    await expect(testEnv.DB.prepare(`
      INSERT INTO fetch_run_sources (run_id, source_id_snapshot, status, error_code)
      VALUES (?, 'oversized-code-source', 'failed', ?)
    `).bind(runId, "x".repeat(129)).run()).rejects.toThrow(/CHECK constraint failed/);
    await expect(testEnv.DB.prepare(`
      INSERT INTO fetch_run_sources (run_id, source_id_snapshot, status, error_message)
      VALUES (?, 'oversized-message-source', 'failed', ?)
    `).bind(runId, "x".repeat(1025)).run()).rejects.toThrow(/CHECK constraint failed/);

    await testEnv.DB.prepare("DELETE FROM sources WHERE id = ?").bind(sourceId).run();
    const retained = await testEnv.DB.prepare(`
      SELECT source_id_snapshot, source_id FROM fetch_run_sources WHERE run_id = ?
    `).bind(runId).first<{ source_id_snapshot: string; source_id: string | null }>();
    expect(retained).toEqual({ source_id_snapshot: sourceId, source_id: null });

    await testEnv.DB.prepare("DELETE FROM fetch_runs WHERE id = ?").bind(runId).run();
    const afterRunDelete = await testEnv.DB.prepare("SELECT COUNT(*) AS count FROM fetch_run_sources WHERE run_id = ?")
      .bind(runId).first<{ count: number }>();
    expect(afterRunDelete?.count).toBe(0);
  });

  it("rejects_invalid_oversized_or_value_bearing_operator_action_payloads", async () => {
    await applyD1Migrations(testEnv.DB, testEnv.TEST_MIGRATIONS);

    const insertAction = (id: string, fields: string) => testEnv.DB.prepare(`
      INSERT INTO operator_actions (id, action, target_type, target_id, changed_fields_json)
      VALUES (?, 'source.updated', 'source', 'source-1', ?)
    `).bind(id, fields).run();

    await insertAction("valid-action", '["kind","url"]');
    const generatedAction = await testEnv.DB.prepare(`
      INSERT INTO operator_actions (action, target_type, target_id)
      VALUES ('export.started', 'export', 'export-1')
      RETURNING id, created_at, actor
    `).first<{ id: string; created_at: number; actor: string }>();
    expect(generatedAction?.id).toMatch(/^[0-9a-f]{32}$/u);
    expect(generatedAction?.created_at).toBeGreaterThan(0);
    expect(generatedAction?.actor).toBe("owner");
    const secondGeneratedAction = await testEnv.DB.prepare(`
      INSERT INTO operator_actions (action, target_type, target_id)
      VALUES ('export.ended', 'export', 'export-1')
      RETURNING id
    `).first<{ id: string }>();
    expect(secondGeneratedAction?.id).toMatch(/^[0-9a-f]{32}$/u);
    expect(secondGeneratedAction?.id).not.toBe(generatedAction?.id);
    await expect(insertAction("invalid-json-action", "not-json")).rejects.toThrow();
    await expect(insertAction("oversized-action", JSON.stringify(Array(300).fill("kind")))).rejects.toThrow(/CHECK constraint failed/);
    await expect(insertAction("value-bearing-action", '["https://secret.example/path"]')).rejects.toThrow(/field name/i);
    await expect(insertAction("non-string-field-action", '["kind",7]')).rejects.toThrow(/field name/i);
    await expect(insertAction("unknown-field-action", '["private_data"]')).rejects.toThrow(/field name/i);
    await expect(insertAction("x".repeat(129), "[]")).rejects.toThrow(/CHECK constraint failed/);
    await expect(testEnv.DB.prepare(`
      INSERT INTO operator_actions (id, action, target_type, target_id)
      VALUES ('invalid-action-name', 'source.deleted', 'source', 'source-1')
    `).run()).rejects.toThrow(/CHECK constraint failed/);
    await expect(testEnv.DB.prepare(`
      INSERT INTO operator_actions (id, action, target_type, target_id)
      VALUES ('mismatched-target-action', 'source.updated', 'export', 'export-1')
    `).run()).rejects.toThrow(/CHECK constraint failed/);
    await expect(testEnv.DB.prepare(`
      INSERT INTO operator_actions (id, action, target_type, target_id)
      VALUES ('oversized-target-action', 'source.updated', 'source', ?)
    `).bind("x".repeat(129)).run()).rejects.toThrow(/CHECK constraint failed/);
    await expect(testEnv.DB.prepare(`
      INSERT INTO operator_actions (id, actor, action, target_type, target_id, changed_fields_json)
      VALUES ('invalid-actor-action', 'someone-else', 'source.updated', 'source', 'source-1', '[]')
    `).run()).rejects.toThrow(/CHECK constraint failed/);
    await expect(testEnv.DB.prepare(`
      INSERT OR REPLACE INTO operator_actions (id, action, target_type, target_id, changed_fields_json)
      VALUES ('valid-action', 'source.updated', 'source', 'replacement', '[]')
    `).run()).rejects.toThrow(/append-only/i);
    await expect(testEnv.DB.prepare("UPDATE operator_actions SET target_id = 'changed' WHERE id = 'valid-action'").run())
      .rejects.toThrow(/append-only/i);
    await expect(testEnv.DB.prepare("DELETE FROM operator_actions WHERE id = 'valid-action'").run())
      .rejects.toThrow(/retention period/i);

    const expiredAt = Math.floor(Date.now() / 1000) - 7_776_001;
    await testEnv.DB.prepare(`
      INSERT INTO operator_actions (id, created_at, action, target_type, target_id)
      VALUES ('expired-action', ?, 'source.updated', 'source', 'source-1')
    `).bind(expiredAt).run();
    await testEnv.DB.prepare("DELETE FROM operator_actions WHERE id = 'expired-action'").run();
  });
});
