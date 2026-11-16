import { applyD1Migrations, reset } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import type { D1Migration } from "@cloudflare/vitest-plugin";
import { checkWriteGate } from "../src/ingest/storage-guard";

interface TestBindings {
  DB: D1Database;
  TEST_MIGRATIONS: D1Migration[];
}

interface StorageStateRow {
  observed_db_size: number;
  reserved_db_bytes: number;
  storage_state: "normal" | "storage_limit" | "read_only";
}

const testEnv = env as unknown as TestBindings;

beforeEach(async () => {
  await reset();
  await applyD1Migrations(testEnv.DB, testEnv.TEST_MIGRATIONS);
});

describe("physical local D1 storage threshold", () => {
  it("fills real local D1 through the 280 MiB stop and checks the measured gate", async () => {
    const sourceId = crypto.randomUUID();
    await testEnv.DB.prepare("INSERT INTO sources (id, url, kind, host) VALUES (?, ?, 'feed', 'example.com')")
      .bind(sourceId, "https://example.com/physical-fill-feed").run();

    const totalRows = 575;
    const batchRows = 50;
    for (let start = 0; start < totalRows; start += batchRows) {
      const end = Math.min(start + batchRows - 1, totalRows - 1);
      await testEnv.DB.prepare(`
        WITH RECURSIVE n(i) AS (SELECT ? UNION ALL SELECT i + 1 FROM n WHERE i < ?)
        INSERT INTO articles (id, source_id, external_id, canonical_url, title, content_text, content_hash)
        SELECT lower(hex(randomblob(16))), ?, 'probe-' || i,
               'https://example.com/physical/' || i, 'Probe', CAST(zeroblob(512000) AS TEXT), 'hash-' || i
        FROM n
      `).bind(start, end, sourceId).run();
    }
    const ftsResult = await testEnv.DB.prepare(`
      INSERT INTO articles_fts (article_id, title, snippet)
      SELECT id, title, 'Physical local D1 fill' FROM articles WHERE source_id = ?
    `).bind(sourceId).run();
    const sizeAfter = ftsResult.meta.size_after;

    console.log(`LOCAL_D1_PHYSICAL_SIZE_AFTER=${sizeAfter}; STOP_BYTES=${280 * 1024 * 1024}`);
    expect(sizeAfter).toBeGreaterThanOrEqual(280 * 1024 * 1024);
    expect(sizeAfter).toBeLessThan(300 * 1024 * 1024);
    expect(await checkWriteGate(testEnv.DB, "pending", 1024)).toBe("storage_limit");
    const state = await testEnv.DB.prepare("SELECT observed_db_size, reserved_db_bytes, storage_state FROM system_state WHERE singleton_id = 'global'")
      .first<StorageStateRow>();
    expect(state?.observed_db_size).toBeGreaterThanOrEqual(sizeAfter);
    expect(state).toMatchObject({ reserved_db_bytes: 0, storage_state: "storage_limit" });
  }, 120_000);
});
