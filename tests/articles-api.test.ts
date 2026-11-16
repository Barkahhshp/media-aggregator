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

interface ArticlesAppModule {
  createApp(): {
    request(input: string, init: RequestInit, env: TestEnvironment): Promise<Response> | Response;
  };
}

const runtimeEnv = env as unknown as Omit<TestEnvironment, "API_TOKEN">;
const testEnv: TestEnvironment = { ...runtimeEnv, API_TOKEN: "local-test-token" };
const appModules = import.meta.glob<ArticlesAppModule>("../src/app.ts");

async function loadApp() {
  const moduleLoader = appModules["../src/app.ts"];
  expect(moduleLoader).toBeDefined();
  if (!moduleLoader) return undefined;

  const module = await moduleLoader();
  expect(module.createApp).toBeTypeOf("function");
  if (!module.createApp) return undefined;
  return module.createApp();
}

async function articleRequest(
  app: NonNullable<Awaited<ReturnType<typeof loadApp>>>,
  path: string,
  headers = new Headers(),
): Promise<Response> {
  headers.set("Authorization", `Bearer ${testEnv.API_TOKEN}`);
  return await app.request(path, { method: "GET", headers }, testEnv);
}

async function seedArticle(id: string, overrides: { sourceId?: string; contentText?: string } = {}): Promise<void> {
  const sourceId = overrides.sourceId ?? "api-source";
  await testEnv.DB.prepare("INSERT OR IGNORE INTO sources (id, url, kind, host) VALUES (?, ?, 'feed', 'example.com')")
    .bind(sourceId, `https://example.com/${sourceId}`).run();
  await testEnv.DB.prepare(`
    INSERT INTO articles (
      id, source_id, canonical_url, title, summary, published_at, fetched_at,
      content_text, content_hash, status
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'stored')
  `).bind(
    id, sourceId, `https://example.com/${id}`, "Example headline", "Example snippet",
    "2026-11-16T12:00:00.000Z", 1_800_000_000, overrides.contentText ?? "Complete body text.", `hash-${id}`,
  ).run();
  await testEnv.DB.prepare("INSERT INTO articles_fts (article_id, title, snippet) VALUES (?, ?, ?)")
    .bind(id, "Example headline", "Example snippet").run();
}

beforeEach(async () => {
  await reset();
  await applyD1Migrations(testEnv.DB, testEnv.TEST_MIGRATIONS);
});

describe("article REST API", () => {
  it("lists_articles_without_exposing_the_stored_body", async () => {
    const app = await loadApp();
    if (!app) return;
    await seedArticle("api-article", { contentText: "Secret full article body." });

    const response = await articleRequest(app, "/v1/articles");
    expect(response.status).toBe(200);
    const payload = await response.json<{ articles: Array<Record<string, unknown>>; next_cursor: string | null }>();

    expect(payload.articles).toHaveLength(1);
    expect(payload.articles[0]).toMatchObject({ id: "api-article", title: "Example headline", source_id: "api-source" });
    expect(payload.articles[0]).not.toHaveProperty("content_text");
    expect(JSON.stringify(payload)).not.toContain("Secret full article body.");
    expect(payload.next_cursor).toBeNull();
  });

  it("returns_the_complete_Article_including_full_body_for_detail", async () => {
    const app = await loadApp();
    if (!app) return;
    await seedArticle("detail-article", { contentText: "Full article body with every stored paragraph." });

    const response = await articleRequest(app, "/v1/articles/detail-article");
    expect(response.status).toBe(200);
    const payload = await response.json<{ article: Record<string, unknown> }>();

    expect(payload.article).toMatchObject({
      id: "detail-article",
      source_id: "api-source",
      canonical_url: "https://example.com/detail-article",
      title: "Example headline",
      content_text: "Full article body with every stored paragraph.",
      status: "stored",
    });
    expect(payload.article).toHaveProperty("content_hash");
  });

  it("returns_a_canonical_JSON_not_found_error_with_the_request_id", async () => {
    const app = await loadApp();
    if (!app) return;
    const headers = new Headers({ "X-Request-Id": "article-not-found-request" });

    const response = await articleRequest(app, "/v1/articles/no-such-article", headers);

    expect(response.status).toBe(404);
    expect(response.headers.get("Content-Type")).toContain("application/json");
    expect(await response.json()).toEqual({
      error: {
        code: "article_not_found",
        message: "Article not found",
        request_id: "article-not-found-request",
      },
    });
  });

  it.each([
    ["zero limit", "/v1/articles?limit=0"],
    ["limit above maximum", "/v1/articles?limit=101"],
    ["non-UTC from date", "/v1/articles?from=2026-11-16T00:00:00%2B07:00"],
    ["invalid cursor", "/v1/articles?cursor=not-a-valid-cursor"],
  ])("returns_the_canonical_JSON_query_error_for_%s", async (_name, path) => {
    const app = await loadApp();
    if (!app) return;

    const response = await articleRequest(app, path);
    expect(response.status).toBe(400);
    expect(response.headers.get("Content-Type")).toContain("application/json");
    const payload = await response.json<{ error: { code: string; message: string; request_id: string } }>();

    expect(payload.error).toMatchObject({ code: "invalid_query" });
    expect(payload.error.message).toBeTypeOf("string");
    expect(payload.error.request_id).toBeTypeOf("string");
  });

  it("returns_a_generic_JSON_500_without_leaking_D1_details", async () => {
    const app = await loadApp();
    if (!app) return;
    const sensitiveD1Error = "D1 internal details: account-secret-987 and SQL trace";
    const statement: Record<string, unknown> = {};
    statement.bind = () => statement;
    statement.all = async () => { throw new Error(sensitiveD1Error); };
    statement.first = async () => { throw new Error(sensitiveD1Error); };
    const failingDb = { prepare: () => statement } as unknown as D1Database;
    const failureEnv = { ...testEnv, DB: failingDb };
    const response = await app.request(
      "/v1/articles",
      { headers: new Headers({ Authorization: `Bearer ${testEnv.API_TOKEN}` }) },
      failureEnv,
    );

    expect(response.status).toBe(500);
    expect(response.headers.get("Content-Type")).toContain("application/json");
    const payload = await response.json<{ error: { code: string; message: string; request_id: string } }>();
    expect(payload.error).toMatchObject({ code: "internal_error", message: "Internal server error" });
    expect(payload.error.request_id).toBeTypeOf("string");
    expect(JSON.stringify(payload)).not.toContain(sensitiveD1Error);
  });
});
