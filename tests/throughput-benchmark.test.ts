import { applyD1Migrations, reset } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import type { D1Migration } from "@cloudflare/vitest-plugin";
import { parseFeed } from "../src/ingest/feed-parser";
import { enqueueCandidates } from "../src/ingest/pending-repository";
import type { Source } from "../src/sources/types";

interface TestBindings {
  DB: D1Database;
  TEST_MIGRATIONS: D1Migration[];
}

const testEnv = env as unknown as TestBindings;

beforeEach(async () => {
  await reset();
  await applyD1Migrations(testEnv.DB, testEnv.TEST_MIGRATIONS);
});

describe("local Worker ingestion throughput fixture", () => {
  it("parses_and_persists_a_representative_100_item_feed_in_bounded_batches", async () => {
    const now = Math.floor(Date.now() / 1000);
    const source: Source = {
      id: "throughput-source",
      kind: "feed",
      url: "https://example.com/feed.xml",
      host: "example.com",
      poll_interval_sec: 900,
      selectors: null,
      enabled: true,
      next_fetch_at: now,
      etag: null,
      last_modified: null,
      feed_watermark: null,
      sitemap_last_loc: null,
      consecutive_errors: 0,
      last_status: null,
      last_fetched_at: null,
      created_at: now,
      updated_at: now,
    };
    await testEnv.DB.prepare("INSERT INTO sources (id, url, kind, host, poll_interval_sec) VALUES (?, ?, ?, ?, ?)")
      .bind(source.id, source.url, source.kind, source.host, source.poll_interval_sec).run();
    const xml = `<rss><channel>${Array.from({ length: 100 }, (_, index) => `
      <item><guid>story-${index}</guid><link>https://example.com/story-${index}</link>
      <title>Story ${index}</title><description>Representative short summary.</description>
      </item>
    `).join("")}</channel></rss>`;

    parseFeed(xml, "application/rss+xml");
    const parseSamples: number[] = [];
    let parsed = parseFeed(xml, "application/rss+xml");
    for (let sample = 0; sample < 20; sample += 1) {
      const parseStartedAt = performance.now();
      parsed = parseFeed(xml, "application/rss+xml");
      parseSamples.push(performance.now() - parseStartedAt);
    }
    const sortedParseSamples = [...parseSamples].sort((left, right) => left - right);
    const parseMedianMs = ((sortedParseSamples[9] ?? 0) + (sortedParseSamples[10] ?? 0)) / 2;
    const parseMaxMs = sortedParseSamples[sortedParseSamples.length - 1] ?? 0;
    const persistStartedAt = performance.now();
    let persisted = 0;
    for (let offset = 0; offset < parsed.candidates.length; offset += 10) {
      const page = await enqueueCandidates(testEnv.DB, source, parsed.candidates.slice(offset, offset + 10), {
        now,
        maxCandidates: 10,
        maxChecks: 10,
      });
      persisted += page.inserted;
    }
    const persistElapsedMs = performance.now() - persistStartedAt;
    const elapsedMs = parseMedianMs + persistElapsedMs;

    console.info(`LOCAL_WORKER_INGEST_FIXTURE parse_median_ms=${parseMedianMs.toFixed(2)} parse_max_ms=${parseMaxMs.toFixed(2)} persist_elapsed_ms=${persistElapsedMs.toFixed(2)} median_plus_persist_ms=${elapsedMs.toFixed(2)} parsed=${parsed.candidates.length} persisted=${persisted} batch_size=10 batches=10`);
    expect(parsed.candidates).toHaveLength(100);
    expect(persisted).toBe(100);
    expect(await testEnv.DB.prepare("SELECT COUNT(*) AS count FROM pending_items WHERE source_id = ?")
      .bind(source.id).first()).toEqual({ count: 100 });
    expect(elapsedMs).toBeGreaterThan(0);
  }, 30_000);
});
