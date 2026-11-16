import { applyD1Migrations, reset } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import type { D1Migration } from "@cloudflare/vitest-plugin";

interface TestEnvironment {
  DB: D1Database;
  APP_ENV: "test";
  API_TOKEN: string;
  TEST_MIGRATIONS: D1Migration[];
}

interface ExportsAppModule {
  createApp(): {
    request(input: string, init: RequestInit, env: TestEnvironment): Promise<Response> | Response;
  };
}

interface ExportSession {
  id: string;
}

interface RestoreResult {
  counts: { sources: number; pending_items: number; articles: number };
  verified_article_hashes: number;
}

interface RestoreModule {
  restoreExport(db: D1Database, ndjson: string): Promise<RestoreResult>;
}

const runtimeEnv = env as unknown as Omit<TestEnvironment, "API_TOKEN">;
const testEnv: TestEnvironment = { ...runtimeEnv, API_TOKEN: "local-test-token" };
const appModules = import.meta.glob<ExportsAppModule>("../src/app.ts");
const restoreModules = import.meta.glob<RestoreModule>("../src/exports/restore.ts");

async function loadApp() {
  const moduleLoader = appModules["../src/app.ts"];
  expect(moduleLoader).toBeDefined();
  if (!moduleLoader) return undefined;
  const module = await moduleLoader();
  return module.createApp();
}

async function loadRestore() {
  const moduleLoader = restoreModules["../src/exports/restore.ts"];
  expect(moduleLoader).toBeDefined();
  if (!moduleLoader) return undefined;
  return await moduleLoader();
}

async function request(
  app: NonNullable<Awaited<ReturnType<typeof loadApp>>>,
  path: string,
  method = "GET",
): Promise<Response> {
  return await app.request(path, {
    method,
    headers: new Headers({ Authorization: `Bearer ${testEnv.API_TOKEN}` }),
  }, testEnv);
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function seedExportFixture(): Promise<void> {
  await testEnv.DB.prepare(`
    INSERT INTO sources (
      id, url, kind, host, poll_interval_sec, enabled, next_fetch_at, feed_watermark,
      sitemap_last_loc, consecutive_errors, last_status, last_fetched_at, created_at, updated_at
    ) VALUES (?, ?, 'feed', 'example.com', 1800, 1, 1_800_000_100, ?, ?, 2, 'partial', 1_800_000_000, 1_700_000_000, 1_800_000_000)
  `).bind("restore-source", "https://example.com/feed.xml", "feed-watermark-A", "sitemap-watermark-B").run();
  await testEnv.DB.prepare(`
    INSERT INTO sources (id, url, kind, host, enabled, feed_watermark, last_status)
    VALUES ('restore-source-2', 'https://example.net/feed.xml', 'feed', 'example.net', 0, 'disabled-watermark', 'blocked')
  `).run();
  await testEnv.DB.prepare(`
    INSERT INTO pending_items (
      id, source_id, item_type, dedupe_key, external_id, canonical_url, title, summary,
      status, attempts, next_attempt_at, last_error, terminal_expires_at, discovered_at, created_at, updated_at
    ) VALUES ('pending-retry', 'restore-source', 'article', 'retry-key', 'retry-external',
      'https://example.com/retry', 'Retry title', 'Retry summary', 'retry_wait', 3, 1_800_000_200,
      'http_503: retry later', NULL, 1_800_000_000, 1_800_000_000, 1_800_000_000)
  `).run();
  await testEnv.DB.prepare(`
    INSERT INTO pending_items (
      id, source_id, item_type, dedupe_key, canonical_url, title, status, attempts,
      next_attempt_at, last_error, terminal_expires_at, discovered_at
    ) VALUES ('pending-terminal', 'restore-source-2', 'article', 'terminal-key',
      'https://example.net/blocked', 'Blocked title', 'blocked', 1, 1_800_000_000,
      'http_403: forbidden', 1_900_000_000, 1_800_000_000)
  `).run();

  const articles = [
    { id: "restore-article-1", sourceId: "restore-source", body: "Full text, with unicode: café, 東京, and newline.\nSecond paragraph." },
    { id: "restore-article-2", sourceId: "restore-source-2", body: "A second complete body, retained exactly." },
  ];
  for (const article of articles) {
    await testEnv.DB.prepare(`
      INSERT INTO articles (
        id, source_id, external_id, canonical_url, title, summary, author, published_at,
        fetched_at, content_text, content_hash, status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'stored', 1_800_000_000, 1_800_000_100)
    `).bind(
      article.id,
      article.sourceId,
      `external-${article.id}`,
      `https://example.com/${article.id}`,
      `Title ${article.id}`,
      `Summary ${article.id}`,
      "Reporter",
      "2026-11-16T12:00:00.000Z",
      1_800_000_000,
      article.body,
      await sha256(article.body),
    ).run();
    await testEnv.DB.prepare("INSERT INTO articles_fts (article_id, title, snippet) VALUES (?, ?, ?)")
      .bind(article.id, `Title ${article.id}`, `Summary ${article.id}`).run();
  }
}

async function exportAllPages(app: NonNullable<Awaited<ReturnType<typeof loadApp>>>): Promise<{ session: ExportSession; ndjson: string }> {
  const start = await request(app, "/v1/exports", "POST");
  expect(start.status).toBe(201);
  const { session } = await start.json<{ session: ExportSession }>();
  const pages: string[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < 100; page += 1) {
    const path = cursor === null ? `/v1/exports/${session.id}` : `/v1/exports/${session.id}?cursor=${encodeURIComponent(cursor)}`;
    const response = await request(app, path);
    expect(response.status).toBe(200);
    const text = new TextDecoder().decode(await response.arrayBuffer());
    pages.push(text);
    const header = JSON.parse(text.split("\n", 1)[0] ?? "{}") as { next_cursor?: string | null };
    if (header.next_cursor === null || header.next_cursor === undefined) break;
    cursor = header.next_cursor;
  }
  return { session, ndjson: `${pages.join("").replace(/\n*$/u, "")}\n` };
}

async function clearDataRows(): Promise<void> {
  await testEnv.DB.prepare("DELETE FROM articles_fts").run();
  await testEnv.DB.prepare("DELETE FROM articles").run();
  await testEnv.DB.prepare("DELETE FROM pending_items").run();
  await testEnv.DB.prepare("DELETE FROM sources").run();
  await testEnv.DB.prepare("DELETE FROM export_sessions").run();
  await testEnv.DB.prepare(`
    UPDATE system_state
    SET global_lease_token = NULL, global_lease_expires_at = NULL,
        export_lock = 0, export_lock_id = NULL, export_lock_expires_at = NULL
    WHERE singleton_id = 'global'
  `).run();
}

beforeEach(async () => {
  await reset();
  await applyD1Migrations(testEnv.DB, testEnv.TEST_MIGRATIONS);
});

describe("local export restore", () => {
  it("restores_source_state_pending_rows_article_text_and_content_hashes_round_trip", async () => {
    const app = await loadApp();
    const restore = await loadRestore();
    if (!app || !restore) return;
    await seedExportFixture();
    const { session, ndjson } = await exportAllPages(app);
    expect((await request(app, `/v1/exports/${session.id}`, "DELETE")).status).toBe(200);
    const originalArticles = await testEnv.DB.prepare("SELECT id, content_text, content_hash FROM articles ORDER BY id")
      .all<{ id: string; content_text: string; content_hash: string }>();
    await clearDataRows();

    const result = await restore.restoreExport(testEnv.DB, ndjson);

    expect(result).toEqual({
      counts: { sources: 2, pending_items: 2, articles: 2 },
      verified_article_hashes: 2,
    });
    expect(await testEnv.DB.prepare("SELECT id, feed_watermark, sitemap_last_loc, enabled, last_status FROM sources ORDER BY id")
      .all()).toMatchObject({ results: [
        { id: "restore-source", feed_watermark: "feed-watermark-A", sitemap_last_loc: "sitemap-watermark-B", enabled: 1, last_status: "partial" },
        { id: "restore-source-2", feed_watermark: "disabled-watermark", enabled: 0, last_status: "blocked" },
      ] });
    expect(await testEnv.DB.prepare("SELECT id, status, attempts, next_attempt_at, last_error FROM pending_items ORDER BY id")
      .all()).toMatchObject({ results: [
        { id: "pending-retry", status: "retry_wait", attempts: 3, next_attempt_at: 1_800_000_200, last_error: "http_503: retry later" },
        { id: "pending-terminal", status: "blocked", attempts: 1, last_error: "http_403: forbidden" },
      ] });
    const restoredArticles = await testEnv.DB.prepare("SELECT id, content_text, content_hash FROM articles ORDER BY id")
      .all<{ id: string; content_text: string; content_hash: string }>();
    expect(restoredArticles.results).toEqual(originalArticles.results);
    expect(await testEnv.DB.prepare("SELECT article_id, title, snippet FROM articles_fts ORDER BY article_id").all())
      .toMatchObject({ results: [
        { article_id: "restore-article-1", title: "Title restore-article-1", snippet: "Summary restore-article-1" },
        { article_id: "restore-article-2", title: "Title restore-article-2", snippet: "Summary restore-article-2" },
      ] });
  });

  it("refuses_to_restore_into_a_non_empty_target_without_mutating_it", async () => {
    const app = await loadApp();
    const restore = await loadRestore();
    if (!app || !restore) return;
    await seedExportFixture();
    const { ndjson } = await exportAllPages(app);

    await expect(restore.restoreExport(testEnv.DB, ndjson)).rejects.toThrow(/empty/i);
    expect(await testEnv.DB.prepare("SELECT COUNT(*) AS count FROM articles").first())
      .toEqual({ count: 2 });
  });

  it("rejects_an_article_whose_text_does_not_match_its_exported_content_hash_before_writing", async () => {
    const app = await loadApp();
    const restore = await loadRestore();
    if (!app || !restore) return;
    await seedExportFixture();
    const { session, ndjson } = await exportAllPages(app);
    await request(app, `/v1/exports/${session.id}`, "DELETE");
    const encodedText = ndjson.match(/"content_text_base64":"([^"]+)"/u)?.[1];
    expect(encodedText).toBeTypeOf("string");
    const replacement = encodedText?.startsWith("A") ? "B" : "A";
    const changed = ndjson.replace(/"content_text_base64":"([^"]+)"/u, `"content_text_base64":"${replacement}${encodedText?.slice(1)}"`);
    await clearDataRows();

    await expect(restore.restoreExport(testEnv.DB, changed)).rejects.toThrow(/hash/i);
    expect(await testEnv.DB.prepare("SELECT COUNT(*) AS count FROM sources").first())
      .toEqual({ count: 0 });
    expect(await testEnv.DB.prepare("SELECT COUNT(*) AS count FROM articles").first())
      .toEqual({ count: 0 });
  });
});
