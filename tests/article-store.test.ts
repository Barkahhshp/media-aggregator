import { applyD1Migrations, reset } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import type { D1Migration } from "@cloudflare/vitest-plugin";
import type { Candidate } from "../src/ingest/types";
import type { Source } from "../src/sources/types";
import { enqueueCandidates, claimPending } from "../src/ingest/pending-repository";

interface TestBindings {
  DB: D1Database;
  TEST_MIGRATIONS: D1Migration[];
}

interface PendingItem {
  id: string;
  source_id: string;
  item_type: "article" | "sitemap";
  dedupe_key: string;
  external_id: string | null;
  canonical_url: string;
  title: string | null;
  summary: string | null;
  published_at: string | null;
  status: "pending" | "leased" | "retry_wait" | "blocked" | "failed";
  attempts: number;
  next_attempt_at: number;
  lease_token: string | null;
  lease_expires_at: number | null;
  last_error: string | null;
  terminal_expires_at: number | null;
  discovered_at: number;
  created_at: number;
  updated_at: number;
}

interface ArticleInput {
  title: string;
  summary: string | null;
  author: string | null;
  publishedAt: string | null;
  contentText: string;
}

interface SaveArticleResult {
  status: "saved" | "content_too_large" | "metadata_too_large" | "row_too_large" | "lease_lost" | "storage_limit";
  articleId: string | null;
}

interface ArticleStoreModule {
  saveArticleAndCompletePending(db: D1Database, item: PendingItem, article: ArticleInput): Promise<SaveArticleResult>;
}

interface ArticleRow {
  id: string;
  source_id: string;
  external_id: string | null;
  canonical_url: string;
  title: string;
  summary: string | null;
  author: string | null;
  published_at: string | null;
  content_text: string;
  status: string;
}

const testEnv = env as unknown as TestBindings;
const modules = import.meta.glob<ArticleStoreModule>("../src/ingest/article-store.ts");

async function loadStore() {
  const load = modules["../src/ingest/article-store.ts"];
  expect(load).toBeDefined();
  if (!load) return undefined;
  const module = await load();
  expect(module.saveArticleAndCompletePending).toBeTypeOf("function");
  return module;
}

async function makeSource(): Promise<Source> {
  const now = Math.floor(Date.now() / 1000);
  const source: Source = {
    id: crypto.randomUUID(), kind: "feed", url: "https://example.com/feed", host: "example.com",
    poll_interval_sec: 7200, selectors: null, enabled: true, next_fetch_at: now,
    etag: null, last_modified: null, feed_watermark: null, sitemap_last_loc: null,
    consecutive_errors: 0, last_status: null, last_fetched_at: null, created_at: now, updated_at: now,
  };
  await testEnv.DB.prepare("INSERT INTO sources (id, url, kind, host) VALUES (?, ?, ?, ?)")
    .bind(source.id, source.url, source.kind, source.host).run();
  return source;
}

async function makeLeasedItem(source: Source, token = "article-lease", candidateOverrides: Partial<Candidate> = {}): Promise<PendingItem> {
  const candidate: Candidate = {
    sourceId: source.id, dedupeKey: "story-1", canonicalUrl: "https://example.com/story-1",
    externalId: "story-1", title: "Feed title", summary: "Feed summary", author: "Feed author",
    publishedAt: "2026-11-16T00:00:00Z", sourceCursor: { kind: "feed", value: "story-1" },
    ...candidateOverrides,
  };
  const queued = await enqueueCandidates(testEnv.DB, source, [candidate], {});
  expect(queued.inserted).toBe(1);
  const item = await claimPending(testEnv.DB, Math.floor(Date.now() / 1000) + 10, token);
  if (!item) throw new Error("Expected the queued item to be leased");
  return item as PendingItem;
}

async function articleRows(): Promise<ArticleRow[]> {
  return (await testEnv.DB.prepare("SELECT * FROM articles ORDER BY id").all<ArticleRow>()).results;
}

beforeEach(async () => {
  await reset();
  await applyD1Migrations(testEnv.DB, testEnv.TEST_MIGRATIONS);
});

describe("article storage and pending completion", () => {
  it("upserts_article_and_FTS_and_deletes_the_matching_pending_lease_atomically", async () => {
    const store = await loadStore();
    if (!store) return;
    const source = await makeSource();
    const item = await makeLeasedItem(source);

    const result = await store.saveArticleAndCompletePending(testEnv.DB, item, {
      title: "Fetched title", summary: "Fetched summary", author: "Fetched author",
      publishedAt: "not a timestamp", contentText: "Full article text.",
    });

    const articles = await articleRows();
    const pending = await testEnv.DB.prepare("SELECT id FROM pending_items WHERE id = ?").bind(item.id).first();
    const fts = await testEnv.DB.prepare("SELECT article_id, title, snippet FROM articles_fts").all<{ article_id: string; title: string; snippet: string }>();
    expect(result.status).toBe("saved");
    expect(result.articleId).toBe(articles[0]?.id);
    expect(articles).toMatchObject([{ source_id: source.id, title: "Fetched title", published_at: null, content_text: "Full article text.", status: "stored" }]);
    expect(fts.results).toMatchObject([{ article_id: articles[0]?.id, title: "Fetched title", snippet: "Fetched summary" }]);
    expect(pending).toBeNull();
  });

  it("deduplicates_by_source_identity_and_keeps_FTS_in_sync_when_an_article_changes", async () => {
    const store = await loadStore();
    if (!store) return;
    const source = await makeSource();
    const first = await makeLeasedItem(source, "first-lease");
    const firstSaved = await store.saveArticleAndCompletePending(testEnv.DB, first, {
      title: "Original", summary: null, author: null, publishedAt: null, contentText: "Original body.",
    });
    expect(firstSaved.status).toBe("saved");

    await testEnv.DB.prepare(`
      INSERT INTO pending_items (id, source_id, item_type, dedupe_key, external_id, canonical_url, status)
      VALUES ('second-pending', ?, 'article', 'alternate-identity', 'story-1', 'https://example.com/alternate', 'pending')
    `).bind(source.id).run();
    const second = await claimPending(testEnv.DB, Math.floor(Date.now() / 1000) + 10, "second-lease");
    if (!second) throw new Error("Expected the updated item to be leased");
    const secondSaved = await store.saveArticleAndCompletePending(testEnv.DB, second, {
      title: "Updated title", summary: "Updated snippet", author: null, publishedAt: null, contentText: "Updated body.",
    });

    expect(secondSaved.status).toBe("saved");
    expect(await articleRows()).toMatchObject([{ title: "Updated title", content_text: "Updated body." }]);
    expect((await testEnv.DB.prepare("SELECT article_id, title, snippet FROM articles_fts").all()).results).toHaveLength(1);
    expect((await testEnv.DB.prepare("SELECT article_id, title, snippet FROM articles_fts").all())).toMatchObject({ results: [{ title: "Updated title", snippet: "Updated snippet" }] });
    expect(await testEnv.DB.prepare("SELECT id FROM pending_items").first()).toBeNull();
  });

  it("records_content_over_500_KiB_as_content_too_large_without_truncating_it_silently", async () => {
    const store = await loadStore();
    if (!store) return;
    const source = await makeSource();
    const item = await makeLeasedItem(source);

    const result = await store.saveArticleAndCompletePending(testEnv.DB, item, {
      title: "Fetched title", summary: null, author: null, publishedAt: null,
      contentText: "x".repeat(512_001),
    });

    expect(result.status).toBe("content_too_large");
    expect(await articleRows()).toMatchObject([{ status: "content_too_large", content_text: "" }]);
    expect(await testEnv.DB.prepare("SELECT id FROM pending_items WHERE id = ?").bind(item.id).first()).toBeNull();
  });

  it("returns_storage_limit_when_the_article_transaction_reports_280_MiB", async () => {
    const store = await loadStore();
    if (!store) return;
    const source = await makeSource();
    const item = await makeLeasedItem(source);
    let batchNumber = 0;
    const measuredDb = new Proxy(testEnv.DB, {
      get(target, property) {
        if (property === "batch") {
          return async (statements: D1PreparedStatement[]) => {
            batchNumber += 1;
            const results = await target.batch(statements);
            if (batchNumber !== 2) return results;
            return results.map((result, index) => ({
              ...result,
              meta: { ...result.meta, size_after: (index === results.length - 1 ? 279 : 280) * 1024 * 1024 },
            }));
          };
        }
        const value = Reflect.get(target, property) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as D1Database;

    const result = await store.saveArticleAndCompletePending(measuredDb, item, {
      title: "Fetched title", summary: null, author: null, publishedAt: null, contentText: "Full body.",
    });

    expect(result).toMatchObject({ status: "storage_limit", committed: true });
    expect(await articleRows()).toMatchObject([{ source_id: source.id, content_text: "Full body." }]);
    expect(await testEnv.DB.prepare("SELECT id FROM pending_items WHERE id = ?").bind(item.id).first()).toBeNull();
    expect(await testEnv.DB.prepare("SELECT storage_state, observed_db_size FROM system_state WHERE singleton_id = 'global'").first())
      .toMatchObject({ storage_state: "storage_limit", observed_db_size: 280 * 1024 * 1024 });
  });

  it("leaves_pending_claimed_and_rolls_back_prior_FTS_deletion_when_an_article_write_fails", async () => {
    const store = await loadStore();
    if (!store) return;
    const source = await makeSource();
    const item = await makeLeasedItem(source);
    await testEnv.DB.exec("CREATE TRIGGER fail_article_insert BEFORE INSERT ON articles BEGIN SELECT RAISE(ABORT, 'forced article failure'); END;");

    await expect(store.saveArticleAndCompletePending(testEnv.DB, item, {
      title: "Fetched title", summary: null, author: null, publishedAt: null, contentText: "Full body.",
    })).rejects.toThrow(/forced article failure/);

    expect(await articleRows()).toHaveLength(0);
    expect(await testEnv.DB.prepare("SELECT status, lease_token FROM pending_items WHERE id = ?").bind(item.id).first())
      .toMatchObject({ status: "leased", lease_token: item.lease_token });
  });

  it("does_not_save_or_complete_an_item_after_its_lease_token_has_changed", async () => {
    const store = await loadStore();
    if (!store) return;
    const source = await makeSource();
    const item = await makeLeasedItem(source);
    await testEnv.DB.prepare("UPDATE pending_items SET lease_token = 'new-owner' WHERE id = ?").bind(item.id).run();

    const result = await store.saveArticleAndCompletePending(testEnv.DB, item, {
      title: "Fetched title", summary: null, author: null, publishedAt: null, contentText: "Full body.",
    });

    expect(result.status).toBe("lease_lost");
    expect(await articleRows()).toHaveLength(0);
    expect(await testEnv.DB.prepare("SELECT status, lease_token FROM pending_items WHERE id = ?").bind(item.id).first())
      .toMatchObject({ status: "leased", lease_token: "new-owner" });
  });
});
