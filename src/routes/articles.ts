import { Hono } from "hono";
import type { Env } from "../env";
import { decodeArticleCursor } from "../articles/cursor";
import { getArticle, listArticles, type ArticleQuery } from "../articles/repository";

interface ApiError {
  status: number;
  code: string;
  message: string;
}

export const articles = new Hono<{ Bindings: Env }>();

function errorResponse(error: ApiError, request: Request): Response {
  return Response.json(
    {
      error: {
        code: error.code,
        message: error.message,
        request_id: request.headers.get("X-Request-Id") ?? crypto.randomUUID(),
      },
    },
    { status: error.status },
  );
}

function invalidQuery(): ApiError {
  return { status: 400, code: "invalid_query", message: "Invalid article query parameter" };
}

function parseUtcDate(value: string): string | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?Z$/u.exec(value);
  if (match === null) return null;
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return null;
  const date = new Date(timestamp);
  const expectedSecond = `${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6]}`;
  if (date.toISOString().slice(0, 19) !== expectedSecond) return null;
  return date.toISOString();
}

function parseArticleQuery(url: string): ArticleQuery | ApiError {
  const params = new URL(url).searchParams;
  let limit = 20;
  const rawLimit = params.get("limit");
  if (rawLimit !== null) {
    if (!/^\d+$/u.test(rawLimit)) return invalidQuery();
    limit = Number(rawLimit);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) return invalidQuery();
  }

  const query: ArticleQuery = { limit };
  const sourceId = params.get("source_id");
  if (sourceId !== null) {
    if (sourceId.length === 0 || sourceId.length > 128) return invalidQuery();
    query.source_id = sourceId;
  }

  const fromValue = params.get("from");
  if (fromValue !== null) {
    const from = parseUtcDate(fromValue);
    if (from === null) return invalidQuery();
    query.from = from;
  }
  const toValue = params.get("to");
  if (toValue !== null) {
    const to = parseUtcDate(toValue);
    if (to === null) return invalidQuery();
    query.to = to;
  }
  if (query.from !== undefined && query.to !== undefined && query.from > query.to) return invalidQuery();

  const search = params.get("q");
  if (search !== null) query.q = search;

  const cursor = params.get("cursor");
  if (cursor !== null) {
    try {
      decodeArticleCursor(cursor);
    } catch {
      return invalidQuery();
    }
    query.cursor = cursor;
  }
  return query;
}

articles.get("/v1/articles", async (context) => {
  const query = parseArticleQuery(context.req.raw.url);
  if ("status" in query) return errorResponse(query, context.req.raw);

  const page = await listArticles(context.env.DB, query);
  return context.json({ articles: page.articles, next_cursor: page.next_cursor });
});

articles.get("/v1/articles/:id", async (context) => {
  const article = await getArticle(context.env.DB, context.req.param("id"));
  if (article === null) {
    return errorResponse({ status: 404, code: "article_not_found", message: "Article not found" }, context.req.raw);
  }
  return context.json({ article });
});
