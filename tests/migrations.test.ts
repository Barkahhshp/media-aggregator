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
  "fetch_runs",
  "pending_items",
  "sources",
  "system_state",
];

const requiredIndexes = [
  "idx_articles_published",
  "idx_articles_source_published",
  "idx_export_sessions_expires",
  "idx_fetch_runs_source_started",
  "idx_fetch_runs_started",
  "idx_pending_source_status",
  "idx_pending_status_retry",
  "idx_pending_terminal_expiry",
  "idx_sources_due",
];

describe("initial D1 migration", () => {
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
    await testEnv.DB
      .prepare("INSERT INTO sources (id, url, kind, host) VALUES (?, ?, ?, ?)")
      .bind(sourceId, "https://example.com/feed", "feed", "example.com")
      .run();

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
});
