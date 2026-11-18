import { applyD1Migrations, reset } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import type { D1Migration } from "@cloudflare/vitest-plugin";
import {
  MAX_RUN_SOURCE_SUMMARIES_PER_RUN,
  mergeRunSourceSummaries,
  saveRunSourceSummaries,
} from "../src/runs/repository";
import type { RunSourceSummary } from "../src/runs/repository";

interface TestBindings {
  DB: D1Database;
  TEST_MIGRATIONS: D1Migration[];
}

const testEnv = env as unknown as TestBindings;

function summary(
  sourceIdSnapshot: string,
  status: RunSourceSummary["status"],
  fields: Partial<RunSourceSummary> = {},
): RunSourceSummary {
  return {
    sourceIdSnapshot,
    status,
    httpStatus: null,
    discoveredCount: 0,
    storedCount: 0,
    errorCode: null,
    errorMessage: null,
    ...fields,
  };
}

beforeEach(async () => {
  await reset();
  await applyD1Migrations(testEnv.DB, testEnv.TEST_MIGRATIONS);
});

describe("per-source fetch-run summaries", () => {
  it("merges repeated outcomes deterministically and adds only actual counts", () => {
    const notModified = summary("source-a", "not_modified", {
      httpStatus: 304,
      discoveredCount: 2,
    });
    const partial = summary("source-a", "partial", {
      httpStatus: 503,
      discoveredCount: 1,
      storedCount: 1,
      errorCode: "http_503",
      errorMessage: "Upstream returned HTTP 503",
    });
    const blocked = summary("source-a", "blocked", {
      httpStatus: 403,
      storedCount: 1,
      errorCode: "http_403",
      errorMessage: "Upstream returned HTTP 403",
    });

    const leftToRight = mergeRunSourceSummaries(
      mergeRunSourceSummaries(notModified, partial),
      blocked,
    );
    const rightToLeft = mergeRunSourceSummaries(
      mergeRunSourceSummaries(blocked, partial),
      notModified,
    );

    expect(leftToRight).toEqual(rightToLeft);
    expect(leftToRight).toMatchObject({
      sourceIdSnapshot: "source-a",
      status: "blocked",
      httpStatus: 503,
      discoveredCount: 3,
      storedCount: 2,
      errorCode: "http_403",
      errorMessage: "Upstream returned HTTP 403",
    });
    expect(mergeRunSourceSummaries(leftToRight, summary("source-a", "storage_limit", {
      errorCode: "storage_limit",
      errorMessage: "D1 storage limit reached",
    }))).toMatchObject({ status: "storage_limit", errorCode: "storage_limit" });
  });

  it("writes a bounded set once and sanitizes error metadata before persistence", async () => {
    const sourceIds = ["source-one", "source-two", "source-three"];
    for (const id of sourceIds) {
      await testEnv.DB.prepare("INSERT INTO sources (id, url, kind, host) VALUES (?, ?, 'feed', 'example.com')")
        .bind(id, `https://example.com/${id}`).run();
    }
    await testEnv.DB.prepare("INSERT INTO fetch_runs (id, status) VALUES ('run-sanitized', 'running')").run();

    const rows = [
      summary("source-one", "not_modified", { httpStatus: 304 }),
      summary("source-two", "failed", {
        httpStatus: 503,
        errorCode: "http_503\nBearer abc123",
        errorMessage: "Failed at https://private.example/path with Bearer abc123 and api_key=secret-value",
      }),
      summary("source-three", "storage_limit", {
        errorCode: "storage_limit",
        errorMessage: `D1 storage limit reached ${"é".repeat(700)}`,
      }),
    ];
    await saveRunSourceSummaries(testEnv.DB, "run-sanitized", rows);

    const stored = await testEnv.DB.prepare(`
      SELECT source_id_snapshot, status, http_status, discovered_count, stored_count, error_code, error_message
      FROM fetch_run_sources ORDER BY source_id_snapshot
    `).all<{
      source_id_snapshot: string;
      status: string;
      http_status: number | null;
      discovered_count: number;
      stored_count: number;
      error_code: string | null;
      error_message: string | null;
    }>();
    expect(stored.results).toHaveLength(3);
    expect(stored.results[0]).toMatchObject({ source_id_snapshot: "source-one", status: "not_modified", http_status: 304 });
    expect(stored.results[1]).toMatchObject({ source_id_snapshot: "source-three", status: "storage_limit", error_code: "storage_limit" });
    expect(new TextEncoder().encode(stored.results[1]?.error_message ?? "").byteLength).toBeLessThanOrEqual(1024);
    const unsafeMessage = stored.results.find((row) => row.source_id_snapshot === "source-two")?.error_message ?? "";
    expect(stored.results.find((row) => row.source_id_snapshot === "source-two")?.error_code).toBe("unknown_error");
    expect(unsafeMessage).not.toContain("https://private.example/path");
    expect(unsafeMessage).not.toContain("Bearer abc123");
    expect(unsafeMessage).not.toContain("secret-value");
    expect(new TextEncoder().encode(unsafeMessage).byteLength).toBeLessThanOrEqual(1024);

    expect(MAX_RUN_SOURCE_SUMMARIES_PER_RUN).toBe(3);
    await expect(saveRunSourceSummaries(testEnv.DB, "run-sanitized", [
      ...rows,
      summary("source-four", "succeeded"),
    ])).rejects.toThrow(/at most 3/u);
    const count = await testEnv.DB.prepare("SELECT COUNT(*) AS count FROM fetch_run_sources WHERE run_id = 'run-sanitized'")
      .first<{ count: number }>();
    expect(count?.count).toBe(3);
  });
});
