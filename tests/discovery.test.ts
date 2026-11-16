import { applyD1Migrations, reset } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import type { D1Migration } from "@cloudflare/vitest-plugin";
import { getSource } from "../src/sources/repository";
import { claimPending } from "../src/ingest/pending-repository";
import type { Source } from "../src/sources/types";
import type { Candidate, SourceCursor } from "../src/ingest/types";

interface DiscoveryResult {
  enqueued: number;
  deduplicated: number;
  failed: number;
  lastAccountedCursor: SourceCursor | null;
  hasMore: boolean;
  cursorFound: boolean;
  cursorReset: boolean;
  blocked: number;
}

interface DiscoveryModule {
  discoverSource(db: D1Database, source: Source, body: string, contentType: string, budget?: {
    maxCandidates?: number;
    maxTotalRows?: number;
    maxSerializedBytes?: number;
  }): Promise<DiscoveryResult>;
}

interface TestBindings {
  DB: D1Database;
  TEST_MIGRATIONS: D1Migration[];
}

interface PendingRow {
  source_id: string;
  item_type: "article" | "sitemap";
  dedupe_key: string;
  external_id: string | null;
  canonical_url: string;
  title: string | null;
  summary: string | null;
  published_at: string | null;
  status: string;
}

const testEnv = env as unknown as TestBindings;
const discoveryModules = import.meta.glob<DiscoveryModule>("../src/ingest/discovery.ts");

async function loadDiscovery() {
  const moduleLoader = discoveryModules["../src/ingest/discovery.ts"];
  expect(moduleLoader).toBeDefined();
  if (!moduleLoader) return undefined;
  const module = await moduleLoader();
  expect(module.discoverSource).toBeTypeOf("function");
  return module;
}

async function makeSource(kind: Source["kind"] = "feed"): Promise<Source> {
  const now = Math.floor(Date.now() / 1000);
  const url = kind === "sitemap" ? "https://example.com/sitemap.xml" : "https://example.com/rss.xml";
  const source: Source = {
    id: crypto.randomUUID(),
    kind,
    url,
    host: "example.com",
    poll_interval_sec: 7200,
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
  await testEnv.DB.prepare("INSERT INTO sources (id, url, kind, host) VALUES (?, ?, ?, ?)")
    .bind(source.id, source.url, source.kind, source.host)
    .run();
  return source;
}

function rss(items: Array<{ id: string; url: string; title?: string }>): string {
  return `<rss><channel>${items.map((item) => `<item><guid isPermaLink="false">${item.id}</guid><link>${item.url}</link><title>${item.title ?? item.id}</title></item>`).join("")}</channel></rss>`;
}

async function rowsForSource(sourceId: string): Promise<PendingRow[]> {
  const result = await testEnv.DB.prepare("SELECT source_id, item_type, dedupe_key, external_id, canonical_url, title, summary, published_at, status FROM pending_items WHERE source_id = ? ORDER BY discovered_at, id")
    .bind(sourceId)
    .all<PendingRow>();
  return result.results;
}

beforeEach(async () => {
  await reset();
  await applyD1Migrations(testEnv.DB, testEnv.TEST_MIGRATIONS);
});

describe("source discovery", () => {
  it("drains_a_205_item_feed_across_ten_item_storage_runs_without_skipping", async () => {
    const discovery = await loadDiscovery();
    if (!discovery) return;
    const source = await makeSource();
    const items = Array.from({ length: 205 }, (_, index) => ({
      id: `story-${index}`,
      url: `https://example.com/story-${index}`,
    }));
    const body = rss(items);
    let hasMore = true;
    let invocations = 0;

    while (hasMore) {
      const currentSource = await getSource(testEnv.DB, source.id);
      if (!currentSource) throw new Error("Expected source to exist");
      const result = await discovery.discoverSource(testEnv.DB, currentSource, body, "application/rss+xml", { maxCandidates: 10 });
      invocations += 1;
      expect(result.enqueued).toBeLessThanOrEqual(10);
      hasMore = result.hasMore;
      expect(invocations).toBeLessThanOrEqual(21);
    }

    const savedRows = await rowsForSource(source.id);
    expect(invocations).toBe(21);
    expect(savedRows).toHaveLength(205);
    expect(savedRows.map((row) => row.canonical_url).sort()).toEqual(items.map((item) => item.url).sort());
    expect(savedRows.every((row) => row.source_id === source.id && row.item_type === "article")).toBe(true);
    expect(await getSource(testEnv.DB, source.id)).toMatchObject({ feed_watermark: "story-204" });
  });

  it("records_an_oversized_ID_terminally_and_resumes_after_its_bounded_cursor", async () => {
    const discovery = await loadDiscovery();
    if (!discovery) return;
    const source = await makeSource();
    const longId = `oversized-${"x".repeat(5000)}`;
    const body = rss([
      ...Array.from({ length: 9 }, (_, index) => ({ id: `before-${index}`, url: `https://example.com/before-${index}` })),
      { id: longId, url: "https://example.com/long-id-first" },
      { id: longId, url: "https://example.com/long-id-duplicate" },
      { id: "after-0", url: "https://example.com/after-0" },
      { id: "after-1", url: "https://example.com/after-1" },
    ]);

    const firstSource = await getSource(testEnv.DB, source.id);
    if (!firstSource) throw new Error("Expected source to exist");
    const first = await discovery.discoverSource(testEnv.DB, firstSource, body, "application/rss+xml", { maxCandidates: 10 });
    const afterFirst = await getSource(testEnv.DB, source.id);
    if (!afterFirst) throw new Error("Expected source to exist");
    const terminal = (await rowsForSource(source.id)).find((row) => row.canonical_url === "https://example.com/long-id-first");
    const second = await discovery.discoverSource(testEnv.DB, afterFirst, body, "application/rss+xml", { maxCandidates: 10 });

    expect(first.enqueued).toBe(10);
    expect(first.hasMore).toBe(true);
    expect(afterFirst.feed_watermark).toMatch(/^__cue_cursor_sha256_v1__:[a-f0-9]{64}$/);
    expect(terminal).toMatchObject({ status: "failed", external_id: null, dedupe_key: expect.stringMatching(/^__cue_pending_sha256_v1__:[a-f0-9]{64}$/) });
    expect(JSON.stringify(terminal)).not.toContain(longId);
    expect(second.enqueued).toBe(2);
    expect(second.hasMore).toBe(false);
    expect((await rowsForSource(source.id)).map((row) => row.canonical_url)).not.toContain("https://example.com/long-id-duplicate");
    expect(await getSource(testEnv.DB, source.id)).toMatchObject({ feed_watermark: "after-1" });
  });

  it("records_an_oversized_no_ID_URL_with_a_safe_hash_cursor_and_resets_after_empty_page", async () => {
    const discovery = await loadDiscovery();
    if (!discovery) return;
    const source = await makeSource();
    const longUrl = `https://example.com/${"path".repeat(1300)}`;
    const body = rss([{ id: "", url: longUrl, title: "Oversized URL" }]);

    const first = await discovery.discoverSource(testEnv.DB, source, body, "application/rss+xml");
    const afterFirst = await getSource(testEnv.DB, source.id);
    if (!afterFirst) throw new Error("Expected source to exist");
    const terminal = (await rowsForSource(source.id))[0];
    const second = await discovery.discoverSource(testEnv.DB, afterFirst, body, "application/rss+xml");

    expect(first.failed).toBe(1);
    expect(afterFirst.feed_watermark).toMatch(/^__cue_cursor_sha256_v1__:[a-f0-9]{64}$/);
    expect(terminal).toMatchObject({ status: "failed", external_id: null, canonical_url: expect.stringMatching(/^https:\/\/metadata\.invalid\/sha256\/[a-f0-9]{64}$/) });
    expect(JSON.stringify(terminal)).not.toContain(longUrl);
    expect(second.cursorReset).toBe(true);
    expect(await getSource(testEnv.DB, source.id)).toMatchObject({ feed_watermark: null });
  });

  it("restarts_a_missing_feed_cursor_and_accounts_for_previously_seen_items_by_dedupe", async () => {
    const discovery = await loadDiscovery();
    if (!discovery) return;
    const source = await makeSource();
    await testEnv.DB.prepare("INSERT INTO pending_items (id, source_id, item_type, dedupe_key, canonical_url, status) VALUES (?, ?, 'article', 'seen', 'https://example.com/seen', 'pending')")
      .bind(crypto.randomUUID(), source.id)
      .run();
    await testEnv.DB.prepare("UPDATE sources SET feed_watermark = 'no-longer-in-feed' WHERE id = ?").bind(source.id).run();

    const currentSource = await getSource(testEnv.DB, source.id);
    if (!currentSource) throw new Error("Expected source to exist");
    const result = await discovery.discoverSource(testEnv.DB, currentSource, rss([
      { id: "first", url: "https://example.com/first" },
      { id: "seen", url: "https://example.com/seen" },
      { id: "last", url: "https://example.com/last" },
    ]), "application/rss+xml");

    expect(result.cursorFound).toBe(false);
    expect(result.deduplicated).toBe(1);
    expect((await rowsForSource(source.id)).map((row) => row.dedupe_key).sort()).toEqual(["first", "last", "seen"]);
    expect(await getSource(testEnv.DB, source.id)).toMatchObject({ feed_watermark: "last" });
  });

  it("resets_a_valid_feed_cursor_only_after_the_parser_returns_an_empty_page", async () => {
    const discovery = await loadDiscovery();
    if (!discovery) return;
    const source = await makeSource();
    await testEnv.DB.prepare("UPDATE sources SET feed_watermark = 'last' WHERE id = ?").bind(source.id).run();

    const currentSource = await getSource(testEnv.DB, source.id);
    if (!currentSource) throw new Error("Expected source to exist");
    const result = await discovery.discoverSource(testEnv.DB, currentSource, rss([
      { id: "first", url: "https://example.com/first" },
      { id: "last", url: "https://example.com/last" },
    ]), "application/rss+xml");

    expect(result.cursorFound).toBe(true);
    expect(result.cursorReset).toBe(true);
    expect(await rowsForSource(source.id)).toHaveLength(0);
    expect(await getSource(testEnv.DB, source.id)).toMatchObject({ feed_watermark: null });
  });

  it("persists_cross_host_candidates_as_blocked_without_fetching_and_advances_after_recording", async () => {
    const discovery = await loadDiscovery();
    if (!discovery) return;
    const source = await makeSource();

    const result = await discovery.discoverSource(testEnv.DB, source, rss([
      { id: "first", url: "https://example.com/first" },
      { id: "external", url: "https://attacker.com/private" },
      { id: "later", url: "https://example.com/later" },
    ]), "application/rss+xml");

    expect(result.blocked).toBe(1);
    expect((await rowsForSource(source.id)).map((row) => row.dedupe_key).sort()).toEqual(["external", "first", "later"]);
    expect((await rowsForSource(source.id)).find((row) => row.dedupe_key === "external"))
      .toMatchObject({ status: "blocked", canonical_url: "https://attacker.com/private" });
    expect(await getSource(testEnv.DB, source.id)).toMatchObject({ feed_watermark: "later" });
    const now = Math.floor(Date.now() / 1000) + 100;
    const firstClaim = await claimPending(testEnv.DB, now, "claim-first");
    const secondClaim = await claimPending(testEnv.DB, now, "claim-second");
    expect([firstClaim?.dedupe_key, secondClaim?.dedupe_key].sort()).toEqual(["first", "later"]);
  });

  it("creates_sitemap_index_children_as_sitemap_pending_items", async () => {
    const discovery = await loadDiscovery();
    if (!discovery) return;
    const source = await makeSource("sitemap");
    const body = `<sitemapindex><sitemap><loc>https://example.com/maps/one.xml</loc></sitemap><sitemap><loc>https://example.com/maps/two.xml</loc></sitemap></sitemapindex>`;

    const result = await discovery.discoverSource(testEnv.DB, source, body, "application/xml");

    expect(result.enqueued).toBe(2);
    expect((await rowsForSource(source.id)).map((row) => row.item_type)).toEqual(["sitemap", "sitemap"]);
    expect(await getSource(testEnv.DB, source.id)).toMatchObject({ sitemap_last_loc: "https://example.com/maps/two.xml" });
  });

  it("creates_sitemap_urlset_article_pending_items", async () => {
    const discovery = await loadDiscovery();
    if (!discovery) return;
    const source = await makeSource("sitemap");
    const body = `<urlset><url><loc>https://example.com/articles/a</loc><lastmod>2026-11-15T10:00:00+01:00</lastmod></url></urlset>`;

    await discovery.discoverSource(testEnv.DB, source, body, "application/xml");

    expect(await rowsForSource(source.id)).toMatchObject([
      { item_type: "article", canonical_url: "https://example.com/articles/a", published_at: "2026-11-15T09:00:00.000Z" },
    ]);
  });

  it("drains_more_than_ten_sitemap_locations_across_storage_runs", async () => {
    const discovery = await loadDiscovery();
    if (!discovery) return;
    const source = await makeSource("sitemap");
    const urls = Array.from({ length: 15 }, (_, index) => `https://example.com/sitemap-article-${index}`);
    const body = `<urlset>${urls.map((url) => `<url><loc>${url}</loc></url>`).join("")}</urlset>`;

    const firstSource = await getSource(testEnv.DB, source.id);
    if (!firstSource) throw new Error("Expected source to exist");
    const first = await discovery.discoverSource(testEnv.DB, firstSource, body, "application/xml");
    const secondSource = await getSource(testEnv.DB, source.id);
    if (!secondSource) throw new Error("Expected source to exist");
    const second = await discovery.discoverSource(testEnv.DB, secondSource, body, "application/xml");

    expect(first.enqueued).toBe(10);
    expect(first.hasMore).toBe(true);
    expect(second.enqueued).toBe(5);
    expect(second.hasMore).toBe(false);
    expect((await rowsForSource(source.id)).map((row) => row.canonical_url).sort()).toEqual(urls.slice().sort());
    expect(await getSource(testEnv.DB, source.id)).toMatchObject({ sitemap_last_loc: urls[14] });
  });
});
