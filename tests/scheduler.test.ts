import { applyD1Migrations, reset } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { D1Migration } from "@cloudflare/vitest-plugin";
import { enqueueCandidates } from "../src/ingest/pending-repository";
import type { Candidate } from "../src/ingest/types";
import type { Source, SourceKind } from "../src/sources/types";
import { disableSource, getSource } from "../src/sources/repository";

interface TestBindings {
  DB: D1Database;
  APP_ENV: "test";
  TEST_MIGRATIONS: D1Migration[];
}

interface ScheduleResult {
  status: "succeeded" | "partial" | "failed" | "blocked" | "storage_limit" | "export_locked" | "lease_busy";
  sourcesProcessed: number;
  sourceFetches: number;
  articleFetches: number;
  sitemapFetches: number;
  discovered: number;
  stored: number;
  d1Queries: number;
  errorCode: string | null;
  httpStatus: number | null;
}

interface SchedulerModule {
  runScheduled(env: TestBindings, scheduledTime: number): Promise<ScheduleResult>;
}

interface SourceState {
  id: string;
  kind: SourceKind;
  url: string;
  enabled: number;
  next_fetch_at: number;
  etag: string | null;
  last_modified: string | null;
  consecutive_errors: number;
  last_status: string | null;
  last_fetched_at: number | null;
}

interface RunRow {
  status: string;
  http_status: number | null;
  discovered_count: number;
  stored_count: number;
  error_code: string | null;
  error_message: string | null;
}

const testEnv = env as unknown as TestBindings;
const modules = import.meta.glob<SchedulerModule>("../src/ingest/scheduler.ts");

async function loadScheduler() {
  const load = modules["../src/ingest/scheduler.ts"];
  expect(load).toBeDefined();
  if (!load) return undefined;
  const module = await load();
  expect(module.runScheduled).toBeTypeOf("function");
  return module;
}

async function makeSource(kind: SourceKind = "feed", suffix = "one", nextFetchAt = 1): Promise<Source> {
  const id = `source-${suffix}`;
  const url = kind === "sitemap"
    ? `https://example.com/sitemap-${suffix}`
    : kind === "html_list"
      ? `https://example.com/news/listing-${suffix}/`
      : `https://example.com/feed-${suffix}`;
  await testEnv.DB.prepare(`
    INSERT INTO sources (id, url, kind, host, next_fetch_at, poll_interval_sec, selectors_json)
    VALUES (?, ?, ?, 'example.com', ?, 900, ?)
  `).bind(id, url, kind, nextFetchAt, kind === "article" || kind === "html_list"
    ? JSON.stringify({ title: "h1", summary: ".summary", body: "article", ...(kind === "html_list" ? { itemLink: "a.story-link" } : {}) })
    : null).run();
  const source = await getSource(testEnv.DB, id);
  if (!source) throw new Error("Expected test source");
  return source;
}

function feed(items: Array<{ id: string; url: string; title?: string }>): string {
  return `<rss><channel>${items.map((item) => `<item><guid isPermaLink="false">${item.id}</guid><link>${item.url}</link><title>${item.title ?? item.id}</title></item>`).join("")}</channel></rss>`;
}

function candidate(index: number, sourceId?: string): Candidate {
  const id = `pending-${index}`;
  return {
    sourceId,
    dedupeKey: id,
    canonicalUrl: `https://example.com/article-${index}`,
    externalId: id,
    title: `Provisional ${index}`,
    summary: null,
    author: null,
    publishedAt: null,
    sourceCursor: { kind: "feed", value: id },
  };
}

async function seedPending(source: Source, count: number): Promise<void> {
  const result = await enqueueCandidates(testEnv.DB, source, Array.from({ length: count }, (_, index) => candidate(index, source.id)), {});
  expect(result.inserted).toBe(count);
}

async function sourceState(id: string): Promise<SourceState | null> {
  return await testEnv.DB.prepare("SELECT id, kind, url, enabled, next_fetch_at, etag, last_modified, consecutive_errors, last_status, last_fetched_at FROM sources WHERE id = ?")
    .bind(id).first<SourceState>();
}

async function runs(): Promise<RunRow[]> {
  return (await testEnv.DB.prepare("SELECT status, http_status, discovered_count, stored_count, error_code, error_message FROM fetch_runs ORDER BY started_at, id").all<RunRow>()).results;
}

function countingDatabase(db: D1Database, maxQueries = 50): { db: D1Database; queries: () => number } {
  let queries = 0;
  const originals = new WeakMap<object, D1PreparedStatement>();
  const count = () => {
    if (queries >= maxQueries) throw new Error(`D1 invocation query limit ${maxQueries} exceeded`);
    queries += 1;
  };
  const wrapStatement = (statement: D1PreparedStatement): D1PreparedStatement => {
    const proxy = new Proxy(statement, {
      get(target, property) {
        if (property === "bind") {
          return (...values: unknown[]) => wrapStatement(target.bind(...values));
        }
        if (["run", "first", "all", "raw"].includes(String(property))) {
          const method = Reflect.get(target, property, target) as (...args: unknown[]) => unknown;
          return (...args: unknown[]) => {
            count();
            return method.apply(target, args);
          };
        }
        const value = Reflect.get(target, property, target) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    originals.set(proxy, statement);
    return proxy;
  };
  const wrapped = new Proxy(db, {
    get(target, property) {
      if (property === "prepare") return (sql: string) => wrapStatement(target.prepare(sql));
      if (property === "batch") {
        return (statements: D1PreparedStatement[]) => {
          count();
          return target.batch(statements.map((statement) => originals.get(statement as object) ?? statement));
        };
      }
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as D1Database;
  return { db: wrapped, queries: () => queries };
}

const htmlArticle = (title: string) => `<html><head><title>${title}</title></head><body><h1>${title}</h1><article>${"Article body. ".repeat(12)}</article><p class="summary">A short summary.</p></body></html>`;

beforeEach(async () => {
  await reset();
  await applyD1Migrations(testEnv.DB, testEnv.TEST_MIGRATIONS);
});

afterEach(() => vi.unstubAllGlobals());

describe("scheduled ingestion", () => {
  it("processes_pending_articles_before_one_due_feed_and_fetches_at_most_two_articles", async () => {
    const scheduler = await loadScheduler();
    if (!scheduler) return;
    const source = await makeSource("feed", "priority", 1);
    await seedPending(source, 1);
    const requests: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      requests.push(url);
      if (url.endsWith("feed-priority")) {
        return new Response(feed([{ id: "new-1", url: "https://example.com/new-1" }]), { status: 200, headers: { "Content-Type": "application/rss+xml" } });
      }
      return new Response(htmlArticle(`Fetched ${url}`), { status: 200, headers: { "Content-Type": "text/html" } });
    }));
    const counted = countingDatabase(testEnv.DB);

    const now = Math.floor(Date.now() / 1000);
    const result = await scheduler.runScheduled({ ...testEnv, DB: counted.db }, now * 1000);

    expect(result, JSON.stringify(result)).toMatchObject({ status: "succeeded", sourcesProcessed: 1, sourceFetches: 1, articleFetches: 2 });
    expect(counted.queries()).toBeLessThanOrEqual(50);
    expect(counted.queries() + requests.length).toBeLessThanOrEqual(50);
    expect(result.d1Queries).toBe(counted.queries());
    expect(requests).toHaveLength(3);
    expect(requests[0]).toContain("article-0");
    expect(requests[1]).toContain("feed-priority");
    expect(requests[2]).toContain("new-1");
    expect(await testEnv.DB.prepare("SELECT COUNT(*) AS count FROM articles").first()).toMatchObject({ count: 2 });
    expect(await testEnv.DB.prepare("SELECT COUNT(*) AS count FROM pending_items WHERE status IN ('pending', 'leased', 'retry_wait')").first()).toMatchObject({ count: 0 });
  });

  it("defers_due_source_discovery_when_two_or_more_pending_items_are_already_eligible", async () => {
    const scheduler = await loadScheduler();
    if (!scheduler) return;
    const source = await makeSource("feed", "backlog", 1);
    await seedPending(source, 3);
    const requests: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      requests.push(String(input));
      return new Response(htmlArticle("Fetched pending"), { status: 200, headers: { "Content-Type": "text/html" } });
    }));

    const result = await scheduler.runScheduled(testEnv, Date.now());

    expect(result).toMatchObject({ status: "partial", sourcesProcessed: 0, sourceFetches: 0, articleFetches: 2 });
    expect(requests).toHaveLength(2);
    expect(requests.every((url) => url.includes("article-"))).toBe(true);
    expect(await sourceState(source.id)).toMatchObject({ next_fetch_at: 1 });
  });

  it("keeps_disabled_source_backlog_without_claiming_or_fetching_it", async () => {
    const scheduler = await loadScheduler();
    if (!scheduler) return;
    const source = await makeSource("feed", "disabled-backlog", Math.floor(Date.now() / 1000) + 999_999);
    await seedPending(source, 1);
    await testEnv.DB.prepare("UPDATE pending_items SET status = 'retry_wait', next_attempt_at = ? WHERE source_id = ?")
      .bind(Math.floor(Date.now() / 1000) + 999_999, source.id).run();
    await disableSource(testEnv.DB, source.id);
    const fetchStub = vi.fn(async () => new Response("must not fetch"));
    vi.stubGlobal("fetch", fetchStub);

    const result = await scheduler.runScheduled(testEnv, Date.now());

    expect(fetchStub).not.toHaveBeenCalled();
    expect(result).toMatchObject({ status: "partial", errorCode: "disabled_source" });
    expect(await testEnv.DB.prepare("SELECT status, attempts, lease_token FROM pending_items WHERE source_id = ?")
      .bind(source.id).first()).toEqual({ status: "retry_wait", attempts: 0, lease_token: null });
    expect(await sourceState(source.id)).toMatchObject({ enabled: 0, last_status: "disabled_source" });
    expect(await runs()).toMatchObject([{ status: "partial", error_code: "disabled_source" }]);
  });

  it("never_fetches_more_than_one_due_source_per_invocation", async () => {
    const scheduler = await loadScheduler();
    if (!scheduler) return;
    await makeSource("feed", "first", 1);
    await makeSource("sitemap", "second", 1);
    const requests: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      requests.push(String(input));
      return new Response(feed([]), { status: 200, headers: { "Content-Type": "application/rss+xml" } });
    }));

    const now = Math.floor(Date.now() / 1000);
    const result = await scheduler.runScheduled(testEnv, now * 1000);

    expect(result.sourcesProcessed).toBe(1);
    expect(result.sourceFetches).toBe(1);
    expect(requests).toHaveLength(1);
    const after = await Promise.all([sourceState("source-first"), sourceState("source-second")]);
    expect(after.filter((source) => (source?.next_fetch_at ?? 0) > now).length).toBe(1);
  });

  it("discards_oversized_conditional_headers_before_writing_source_state", async () => {
    const scheduler = await loadScheduler();
    if (!scheduler) return;
    const source = await makeSource("feed", "large-header", 1);
    vi.stubGlobal("fetch", vi.fn(async () => new Response("<rss><channel></channel></rss>", {
      status: 200,
      headers: {
        "Content-Type": "application/rss+xml",
        ETag: `"${"x".repeat(2048)}"`,
        "Last-Modified": "x".repeat(2048),
      },
    })));
    const now = Math.floor(Date.now() / 1000);

    await scheduler.runScheduled(testEnv, now * 1000);

    expect(await sourceState(source.id)).toMatchObject({ etag: null, last_modified: null });
  });

  it("does_not_write_or_fetch_when_an_export_lock_is_active", async () => {
    const scheduler = await loadScheduler();
    if (!scheduler) return;
    await makeSource("feed", "export", 1);
    await testEnv.DB.prepare("UPDATE system_state SET export_lock = 1, export_lock_id = 'export-1', export_lock_expires_at = ? WHERE singleton_id = 'global'")
      .bind(Math.floor(Date.now() / 1000) + 600).run();
    const fetchStub = vi.fn(async () => new Response("unused"));
    vi.stubGlobal("fetch", fetchStub);

    const result = await scheduler.runScheduled(testEnv, 100_000);

    expect(result.status).toBe("export_locked");
    expect(fetchStub).not.toHaveBeenCalled();
    expect((await runs())).toHaveLength(0);
    expect(await testEnv.DB.prepare("SELECT global_lease_token FROM system_state WHERE singleton_id = 'global'").first())
      .toMatchObject({ global_lease_token: null });
  });

  it("reclaims_an_expired_export_lock_before_acquiring_the_global_run_lease", async () => {
    const scheduler = await loadScheduler();
    if (!scheduler) return;
    await makeSource("feed", "expired-export", 1);
    const now = Math.floor(Date.now() / 1000);
    await testEnv.DB.prepare("UPDATE system_state SET export_lock = 1, export_lock_id = 'expired', export_lock_expires_at = ? WHERE singleton_id = 'global'")
      .bind(now - 1).run();
    vi.stubGlobal("fetch", vi.fn(async () => new Response("<rss><channel></channel></rss>", {
      status: 200,
      headers: { "Content-Type": "application/rss+xml" },
    })));

    const result = await scheduler.runScheduled(testEnv, now * 1000);

    expect(result.sourcesProcessed).toBe(1);
    expect(result.sourceFetches).toBe(1);
    expect(await testEnv.DB.prepare("SELECT export_lock, export_lock_id, export_lock_expires_at FROM system_state WHERE singleton_id = 'global'").first())
      .toMatchObject({ export_lock: 0, export_lock_id: null, export_lock_expires_at: null });
  });

  it("uses_execution_wall_clock_for_due_sources_and_global_lease_when_scheduled_delivery_is_delayed", async () => {
    const scheduler = await loadScheduler();
    if (!scheduler) return;
    const executionMs = 2_000_000_000_000;
    const executionSeconds = executionMs / 1000;
    vi.spyOn(Date, "now").mockReturnValue(executionMs);
    const source = await makeSource("feed", "delayed-event", executionSeconds - 10);
    let releaseFetch: ((response: Response) => void) | undefined;
    const fetchGate = new Promise<Response>((resolve) => { releaseFetch = resolve; });
    vi.stubGlobal("fetch", vi.fn(async () => fetchGate));

    const delayedScheduledTime = executionMs - 10 * 60 * 1000;
    const run = scheduler.runScheduled(testEnv, delayedScheduledTime);
    for (let attempt = 0; attempt < 100 && vi.mocked(fetch).mock.calls.length === 0; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    const lease = await testEnv.DB.prepare("SELECT global_lease_expires_at FROM system_state WHERE singleton_id = 'global'").first<{ global_lease_expires_at: number | null }>();
    releaseFetch?.(new Response("<rss><channel></channel></rss>", { status: 200, headers: { "Content-Type": "application/rss+xml" } }));
    const result = await run;

    expect(result.sourcesProcessed).toBe(1);
    expect(lease?.global_lease_expires_at).toBe(executionSeconds + 60);
    expect(await sourceState(source.id)).toMatchObject({ last_fetched_at: executionSeconds });
  });

  it("purges_expired_terminal_pending_records_during_scheduled_runs", async () => {
    const scheduler = await loadScheduler();
    if (!scheduler) return;
    const source = await makeSource("feed", "cleanup", Math.floor(Date.now() / 1000) + 999_999);
    await testEnv.DB.prepare(`
      INSERT INTO pending_items (id, source_id, item_type, dedupe_key, canonical_url, status, terminal_expires_at)
      VALUES ('expired-terminal', ?, 'article', 'expired-terminal', 'https://example.com/expired', 'blocked', 99)
    `).bind(source.id).run();
    vi.stubGlobal("fetch", vi.fn(async () => new Response("unused")));

    await scheduler.runScheduled(testEnv, 100_000);

    expect(await testEnv.DB.prepare("SELECT id FROM pending_items WHERE id = 'expired-terminal'").first()).toBeNull();
  });

  it("purges_fetch_runs_older_than_30_days_during_scheduled_runs", async () => {
    const scheduler = await loadScheduler();
    if (!scheduler) return;
    const now = Math.floor(Date.now() / 1000);
    await testEnv.DB.prepare("INSERT INTO fetch_runs (id, started_at, finished_at, status) VALUES ('old-run', ?, ?, 'succeeded')")
      .bind(now - 31 * 24 * 60 * 60, now - 31 * 24 * 60 * 60 + 10).run();
    vi.stubGlobal("fetch", vi.fn(async () => new Response("unused")));

    await scheduler.runScheduled(testEnv, now * 1000);

    expect(await testEnv.DB.prepare("SELECT id FROM fetch_runs WHERE id = 'old-run'").first()).toBeNull();
  });

  it("keeps_a_sitemap_index_pending_when_more_child_sitemaps_remain_than_this_run_can_enqueue", async () => {
    const scheduler = await loadScheduler();
    if (!scheduler) return;
    const now = Math.floor(Date.now() / 1000);
    const source = await makeSource("sitemap", "index", now + 999_999);
    await testEnv.DB.prepare(`
      INSERT INTO pending_items (id, source_id, item_type, dedupe_key, canonical_url, status, next_attempt_at)
      VALUES ('pending-sitemap-index', ?, 'sitemap', 'https://example.com/sitemap-index.xml', 'https://example.com/sitemap-index.xml', 'pending', ?)
    `).bind(source.id, now).run();
    const sitemapIndex = `<sitemapindex>${Array.from({ length: 11 }, (_, index) => `<sitemap><loc>https://example.com/child-${index}.xml</loc></sitemap>`).join("")}</sitemapindex>`;
    vi.stubGlobal("fetch", vi.fn(async () => new Response(sitemapIndex, { status: 200, headers: { "Content-Type": "application/xml" } })));

    const result = await scheduler.runScheduled(testEnv, now * 1000);
    const parent = await testEnv.DB.prepare("SELECT status, next_attempt_at FROM pending_items WHERE id = 'pending-sitemap-index'").first<{ status: string; next_attempt_at: number }>();
    const childCount = await testEnv.DB.prepare("SELECT COUNT(*) AS count FROM pending_items WHERE source_id = ? AND item_type = 'sitemap' AND id <> 'pending-sitemap-index'").bind(source.id).first<{ count: number }>();

    expect(result.sitemapFetches).toBe(1);
    expect(parent).toMatchObject({ status: "retry_wait" });
    expect(childCount?.count).toBe(10);
  });

  it("drains_more_than_ten_urls_from_each_sitemap_child_without_cursor_starvation", async () => {
    const scheduler = await loadScheduler();
    if (!scheduler) return;
    let now = Math.floor(Date.now() / 1000);
    vi.spyOn(Date, "now").mockImplementation(() => now * 1000);
    const source = await makeSource("sitemap", "multi-child", now);
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.href === source.url) {
        return new Response('<sitemapindex><sitemap><loc>https://example.com/child-a.xml</loc></sitemap><sitemap><loc>https://example.com/child-b.xml</loc></sitemap></sitemapindex>', {
          status: 200,
          headers: { "Content-Type": "application/xml" },
        });
      }
      if (url.pathname.endsWith("child-a.xml") || url.pathname.endsWith("child-b.xml")) {
        const prefix = url.pathname.includes("child-a") ? "a" : "b";
        const entries = Array.from({ length: 12 }, (_, index) =>
          `<url><loc>https://example.com/story-${prefix}-${index}</loc></url>`).join("");
        return new Response(`<urlset>${entries}</urlset>`, { status: 200, headers: { "Content-Type": "application/xml" } });
      }
      return new Response(htmlArticle(`Fetched ${url.pathname}`), { status: 200, headers: { "Content-Type": "text/html" } });
    }));

    const startedAt = now;
    await scheduler.runScheduled(testEnv, startedAt * 1000);
    expect(await testEnv.DB.prepare("SELECT sitemap_last_loc FROM sources WHERE id = ?").bind(source.id).first())
      .toMatchObject({ sitemap_last_loc: "https://example.com/child-b.xml" });
    await testEnv.DB.prepare(`UPDATE pending_items SET discovered_at = CASE canonical_url
      WHEN 'https://example.com/child-a.xml' THEN 1 ELSE 2 END WHERE source_id = ? AND item_type = 'sitemap'`)
      .bind(source.id).run();

    now = startedAt + 1;
    await scheduler.runScheduled(testEnv, now * 1000);
    let childCursors = await testEnv.DB.prepare("SELECT canonical_url, sitemap_cursor FROM pending_items WHERE source_id = ? AND item_type = 'sitemap' ORDER BY canonical_url")
      .bind(source.id).all<{ canonical_url: string; sitemap_cursor: string | null }>();
    expect(childCursors.results).toEqual([
      { canonical_url: "https://example.com/child-a.xml", sitemap_cursor: "https://example.com/story-a-9" },
      { canonical_url: "https://example.com/child-b.xml", sitemap_cursor: null },
    ]);
    expect(await testEnv.DB.prepare("SELECT sitemap_last_loc FROM sources WHERE id = ?").bind(source.id).first())
      .toMatchObject({ sitemap_last_loc: "https://example.com/child-b.xml" });

    now = startedAt + 2;
    await scheduler.runScheduled(testEnv, now * 1000);
    childCursors = await testEnv.DB.prepare("SELECT canonical_url, sitemap_cursor FROM pending_items WHERE source_id = ? AND item_type = 'sitemap' ORDER BY canonical_url")
      .bind(source.id).all<{ canonical_url: string; sitemap_cursor: string | null }>();
    expect(childCursors.results).toEqual([
      { canonical_url: "https://example.com/child-a.xml", sitemap_cursor: "https://example.com/story-a-9" },
      { canonical_url: "https://example.com/child-b.xml", sitemap_cursor: "https://example.com/story-b-9" },
    ]);
    expect(await testEnv.DB.prepare("SELECT sitemap_last_loc FROM sources WHERE id = ?").bind(source.id).first())
      .toMatchObject({ sitemap_last_loc: "https://example.com/child-b.xml" });

    for (const offset of [901, 902]) {
      now = startedAt + offset;
      await scheduler.runScheduled(testEnv, now * 1000);
    }

    const total = await testEnv.DB.prepare(`
      SELECT
        (SELECT COUNT(*) FROM articles WHERE source_id = ?) +
        (SELECT COUNT(*) FROM pending_items WHERE source_id = ? AND item_type = 'article') AS count
    `).bind(source.id, source.id).first<{ count: number }>();
    const discoveredUrls = await testEnv.DB.prepare(`
      SELECT canonical_url FROM articles WHERE source_id = ?
      UNION ALL SELECT canonical_url FROM pending_items WHERE source_id = ? AND item_type = 'article'
      ORDER BY canonical_url
    `).bind(source.id, source.id).all<{ canonical_url: string }>();
    expect(total?.count).toBe(24);
    expect(discoveredUrls.results.map((row) => row.canonical_url)).toEqual(
      Array.from(["a", "b"].flatMap((prefix) => Array.from({ length: 12 }, (_, index) => `https://example.com/story-${prefix}-${index}`))).sort(),
    );
  });

  it("discovers_html_list_links_then_applies_article_content_selectors", async () => {
    const scheduler = await loadScheduler();
    if (!scheduler) return;
    const source = await makeSource("html_list", "listing", 1);
    const requests: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      requests.push(url);
      if (url === source.url) {
        return new Response('<a class="story-link" href="story/one">Story one</a><a class="story-link" href="https://elsewhere.com/story">External</a><a class="story-link" href="javascript:alert(1)">Unsafe</a>', {
          status: 200,
          headers: { "Content-Type": "text/html", ETag: '"list-v1"' },
        });
      }
      return new Response(htmlArticle("Fetched listing article"), { status: 200, headers: { "Content-Type": "text/html" } });
    }));

    const result = await scheduler.runScheduled(testEnv, 1_000);
    const article = await testEnv.DB.prepare("SELECT canonical_url, title, content_text FROM articles WHERE source_id = ?").bind(source.id)
      .first<{ canonical_url: string; title: string; content_text: string }>();

    expect(requests).toEqual([source.url, "https://example.com/news/listing-listing/story/one"]);
    expect(result.discovered).toBe(3);
    expect(article).toMatchObject({
      canonical_url: "https://example.com/news/listing-listing/story/one",
      title: "Fetched listing article",
      content_text: expect.stringContaining("Article body."),
    });
    const terminalRows = await testEnv.DB.prepare("SELECT canonical_url, dedupe_key, last_error FROM pending_items WHERE source_id = ? AND status = 'blocked'")
      .bind(source.id).all<{ canonical_url: string; dedupe_key: string; last_error: string }>();
    expect(terminalRows.results).toHaveLength(2);
    expect(JSON.stringify(terminalRows.results)).not.toContain("elsewhere.com");
    expect(JSON.stringify(terminalRows.results)).not.toContain("javascript:");
  });

  it("respects_Retry_After_and_surfaces_article_HTTP_failures_in_source_and_run_status", async () => {
    const scheduler = await loadScheduler();
    if (!scheduler) return;
    const source = await makeSource("feed", "retry", Math.floor(Date.now() / 1000) + 999_999);
    await seedPending(source, 1);
    vi.stubGlobal("fetch", vi.fn(async () => new Response("slow down", { status: 429, headers: { "Retry-After": "120" } })));

    const now = Math.floor(Date.now() / 1000);
    const result = await scheduler.runScheduled(testEnv, now * 1000);

    const pending = await testEnv.DB.prepare("SELECT status, attempts, next_attempt_at, last_error FROM pending_items").first<{ status: string; attempts: number; next_attempt_at: number; last_error: string | null }>();
    expect(result.status).toBe("partial");
    expect(pending).toMatchObject({ status: "retry_wait", attempts: 1, next_attempt_at: now + 120 });
    expect(pending?.last_error).toContain("http_429");
    expect(await sourceState(source.id)).toMatchObject({ last_status: "http_429", consecutive_errors: 1, last_fetched_at: now });
    expect(await runs()).toMatchObject([{ status: "partial", http_status: 429, error_code: "http_429" }]);
  });

  it("marks_definitive_article_403_as_blocked_in_pending_source_and_fetch_run", async () => {
    const scheduler = await loadScheduler();
    if (!scheduler) return;
    const source = await makeSource("feed", "forbidden", Math.floor(Date.now() / 1000) + 999_999);
    await seedPending(source, 1);
    vi.stubGlobal("fetch", vi.fn(async () => new Response("forbidden", { status: 403 })));
    const now = Math.floor(Date.now() / 1000);

    const result = await scheduler.runScheduled(testEnv, now * 1000);
    const pending = await testEnv.DB.prepare("SELECT status, last_error FROM pending_items WHERE source_id = ?").bind(source.id).first<{ status: string; last_error: string }>();

    expect(result.status).toBe("blocked");
    expect(result.httpStatus).toBe(403);
    expect(pending).toMatchObject({ status: "blocked" });
    expect(await sourceState(source.id)).toMatchObject({ last_status: "http_403" });
    expect(await runs()).toMatchObject([{ status: "blocked", http_status: 403, error_code: "http_403" }]);
  });

  it("records_parse_errors_in_both_source_and_fetch_run_status", async () => {
    const scheduler = await loadScheduler();
    if (!scheduler) return;
    const source = await makeSource("feed", "parse", 1);
    vi.stubGlobal("fetch", vi.fn(async () => new Response("not JSON", { status: 200, headers: { "Content-Type": "application/feed+json" } })));

    const now = Math.floor(Date.now() / 1000);
    const result = await scheduler.runScheduled(testEnv, now * 1000);

    expect(result.status).toBe("failed");
    expect(result.errorCode).toBe("parse_error");
    expect(await sourceState(source.id)).toMatchObject({ last_status: "parse_error", consecutive_errors: 1, last_fetched_at: now });
    expect(await runs()).toMatchObject([{ status: "failed", http_status: 200, error_code: "parse_error" }]);
  });

  it("stops_ingestion_at_the_physical_storage_gate_before_a_source_or_article_fetch", async () => {
    const scheduler = await loadScheduler();
    if (!scheduler) return;
    await makeSource("feed", "full", 1);
    await testEnv.DB.prepare("UPDATE system_state SET observed_db_size = ?, storage_state = 'storage_limit' WHERE singleton_id = 'global'")
      .bind(280 * 1024 * 1024).run();
    const fetchStub = vi.fn(async () => new Response("unused"));
    vi.stubGlobal("fetch", fetchStub);

    const result = await scheduler.runScheduled(testEnv, Date.now());

    expect(result.status).toBe("storage_limit");
    expect(fetchStub).not.toHaveBeenCalled();
    expect(await runs()).toHaveLength(0);
    expect(await testEnv.DB.prepare("SELECT global_lease_token FROM system_state WHERE singleton_id = 'global'").first())
      .toMatchObject({ global_lease_token: null });
  });

  it("allows_only_one_concurrent_cron_invocation_to_hold_the_global_lease", async () => {
    const scheduler = await loadScheduler();
    if (!scheduler) return;
    await makeSource("feed", "concurrent", 1);
    let resolveFetch: ((response: Response) => void) | undefined;
    const fetchGate = new Promise<Response>((resolve) => { resolveFetch = resolve; });
    const fetchStub = vi.fn(async () => fetchGate);
    vi.stubGlobal("fetch", fetchStub);

    const first = scheduler.runScheduled(testEnv, 100_000);
    for (let attempt = 0; attempt < 100 && fetchStub.mock.calls.length === 0; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    expect(fetchStub).toHaveBeenCalledTimes(1);
    const second = await scheduler.runScheduled(testEnv, 100_001);
    resolveFetch?.(new Response(feed([]), { status: 200, headers: { "Content-Type": "application/rss+xml" } }));
    const firstResult = await first;

    expect(second.status).toBe("lease_busy");
    expect(firstResult.status).toBe("succeeded");
    expect(fetchStub).toHaveBeenCalledTimes(1);
  });
});
