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
});
