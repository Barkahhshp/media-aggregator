import { applyD1Migrations, reset } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import type { D1Migration } from "@cloudflare/vitest-plugin";

interface TestEnvironment {
  DB: D1Database;
  TEST_MIGRATIONS: D1Migration[];
}

interface ArticleQuery {
  source_id?: string;
  from?: string;
  to?: string;
  q?: string;
  cursor?: string;
  limit?: number;
}

interface ArticlePage {
  articles: Array<Record<string, unknown>>;
  next_cursor: string | null;
}

interface ArticlesRepositoryModule {
  listArticles(db: D1Database, query: ArticleQuery): Promise<ArticlePage>;
}

const testEnv = env as unknown as TestEnvironment;
const modules = import.meta.glob<ArticlesRepositoryModule>("../src/articles/repository.ts");

async function loadRepository() {
  const loader = modules["../src/articles/repository.ts"];
  expect(loader).toBeDefined();
  if (!loader) return undefined;
  const repository = await loader();
  expect(repository.listArticles).toBeTypeOf("function");
  return repository;
}

async function seedSource(id: string): Promise<void> {
  await testEnv.DB.prepare("INSERT INTO sources (id, url, kind, host) VALUES (?, ?, 'feed', 'example.com')")
    .bind(id, `https://example.com/${id}`).run();
}

async function seedArticle(article: {
  id: string;
  sourceId?: string;
  title?: string;
  summary?: string | null;
  publishedAt?: string | null;
  fetchedAt?: number;
  contentText?: string;
}): Promise<void> {
  const sourceId = article.sourceId ?? "repository-source";
  await testEnv.DB.prepare(`
    INSERT INTO articles (
      id, source_id, canonical_url, title, summary, published_at, fetched_at,
      content_text, content_hash, status
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'stored')
  `).bind(
    article.id,
    sourceId,
    `https://example.com/${article.id}`,
    article.title ?? article.id,
    article.summary ?? null,
    article.publishedAt ?? null,
    article.fetchedAt ?? 1,
    article.contentText ?? "Body not indexed for search.",
    `hash-${article.id}`,
  ).run();
  await testEnv.DB.prepare("INSERT INTO articles_fts (article_id, title, snippet) VALUES (?, ?, ?)")
    .bind(article.id, article.title ?? article.id, article.summary ?? "").run();
}

beforeEach(async () => {
  await reset();
  await applyD1Migrations(testEnv.DB, testEnv.TEST_MIGRATIONS);
  await seedSource("repository-source");
});

describe("article repository", () => {
  it("paginates_ties_without_skips_or_duplicates_in_the_complete_nulls_last_order", async () => {
    const repository = await loadRepository();
    if (!repository) return;
    await seedArticle({ id: "recent", publishedAt: "2026-11-03T00:00:00.000Z", fetchedAt: 10 });
    await seedArticle({ id: "tie-a", publishedAt: "2026-11-02T00:00:00.000Z", fetchedAt: 20 });
    await seedArticle({ id: "tie-z", publishedAt: "2026-11-02T00:00:00.000Z", fetchedAt: 20 });
    await seedArticle({ id: "same-published-older-fetch", publishedAt: "2026-11-02T00:00:00.000Z", fetchedAt: 19 });
    await seedArticle({ id: "older", publishedAt: "2026-11-01T00:00:00.000Z", fetchedAt: 99 });
    await seedArticle({ id: "undated-newer-fetch", publishedAt: null, fetchedAt: 30 });
    await seedArticle({ id: "undated-older-fetch", publishedAt: null, fetchedAt: 20 });

    const seenIds: string[] = [];
    let cursor: string | undefined;
    for (let pageNumber = 0; pageNumber < 10; pageNumber += 1) {
      const page = await repository.listArticles(testEnv.DB, { limit: 2, ...(cursor === undefined ? {} : { cursor }) });
      seenIds.push(...page.articles.map((article) => String(article.id)));
      cursor = page.next_cursor ?? undefined;
      if (cursor === undefined) break;
    }

    expect(seenIds).toEqual([
      "recent",
      "tie-z",
      "tie-a",
      "same-published-older-fetch",
      "older",
      "undated-newer-fetch",
      "undated-older-fetch",
    ]);
  });

  it("applies_source_filter_with_an_inclusive_from_and_exclusive_to_boundary", async () => {
    const repository = await loadRepository();
    if (!repository) return;
    await seedSource("other-source");
    await seedArticle({ id: "at-from", publishedAt: "2026-11-01T10:00:00.000Z", sourceId: "repository-source" });
    await seedArticle({ id: "inside-window", publishedAt: "2026-11-01T10:59:59.999Z", sourceId: "repository-source" });
    await seedArticle({ id: "at-to", publishedAt: "2026-11-01T11:00:00.000Z", sourceId: "repository-source" });
    await seedArticle({ id: "other-source-match", publishedAt: "2026-11-01T10:30:00.000Z", sourceId: "other-source" });
    await seedArticle({ id: "before-from", publishedAt: "2026-11-01T09:59:59.999Z", sourceId: "repository-source" });

    const page = await repository.listArticles(testEnv.DB, {
      source_id: "repository-source",
      from: "2026-11-01T10:00:00.000Z",
      to: "2026-11-01T11:00:00.000Z",
      limit: 100,
    });

    expect(page.articles.map((article) => article.id)).toEqual(["inside-window", "at-from"]);
  });

  it("searches_FTS_title_and_snippet_but_never_the_full_article_body", async () => {
    const repository = await loadRepository();
    if (!repository) return;
    await seedArticle({ id: "title-hit", title: "needle headline", summary: "ordinary summary" });
    await seedArticle({ id: "snippet-hit", title: "ordinary headline", summary: "needle snippet" });
    await seedArticle({ id: "body-only-hit", title: "ordinary headline", summary: "ordinary summary", contentText: "needle only in the body" });

    const hits = await repository.listArticles(testEnv.DB, { q: "needle", limit: 100 });
    const bodyOnly = await repository.listArticles(testEnv.DB, { q: "body", limit: 100 });

    expect(hits.articles.map((article) => article.id).sort()).toEqual(["snippet-hit", "title-hit"]);
    expect(bodyOnly.articles).toEqual([]);
  });
});
