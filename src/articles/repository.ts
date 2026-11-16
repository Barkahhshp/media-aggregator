import type { Article } from "./types";
import { decodeArticleCursor, encodeArticleCursor, type ArticleCursorValue } from "./cursor";

export interface ArticleQuery {
  source_id?: string;
  from?: string;
  to?: string;
  q?: string;
  cursor?: string;
  limit?: number;
}

export type ArticleListItem = Omit<Article, "content_text">;

export interface ArticlePage {
  articles: ArticleListItem[];
  next_cursor: string | null;
}

interface ArticleListRow extends ArticleListItem {}

function ftsTerms(query: string): string[] {
  return query.match(/[\p{L}\p{N}]+/gu) ?? [];
}

export async function listArticles(db: D1Database, query: ArticleQuery): Promise<ArticlePage> {
  const limit = query.limit ?? 20;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new RangeError("Article limit must be between 1 and 100");

  const conditions: string[] = [];
  const bindings: Array<string | number | null> = [];
  if (query.source_id !== undefined) {
    conditions.push("article.source_id = ?");
    bindings.push(query.source_id);
  }
  if (query.from !== undefined) {
    conditions.push("article.published_at >= ?");
    bindings.push(query.from);
  }
  if (query.to !== undefined) {
    conditions.push("article.published_at < ?");
    bindings.push(query.to);
  }
  if (query.q !== undefined && query.q.trim().length > 0) {
    const terms = ftsTerms(query.q);
    if (terms.length === 0) {
      conditions.push("0 = 1");
    } else {
      conditions.push("article.id IN (SELECT article_id FROM articles_fts WHERE articles_fts MATCH ?)");
      bindings.push(terms.map((term) => `"${term}"`).join(" AND "));
    }
  }

  if (query.cursor !== undefined) {
    const cursor: ArticleCursorValue = decodeArticleCursor(query.cursor);
    if (cursor.published_at === null) {
      conditions.push(`article.published_at IS NULL
        AND (article.fetched_at < ? OR (article.fetched_at = ? AND article.id < ?))`);
      bindings.push(cursor.fetched_at, cursor.fetched_at, cursor.id);
    } else {
      conditions.push(`(
        article.published_at < ?
        OR (article.published_at = ? AND (
          article.fetched_at < ? OR (article.fetched_at = ? AND article.id < ?)
        ))
        OR article.published_at IS NULL
      )`);
      bindings.push(cursor.published_at, cursor.published_at, cursor.fetched_at, cursor.fetched_at, cursor.id);
    }
  }

  const where = conditions.length === 0 ? "" : `WHERE ${conditions.join(" AND ")}`;
  const rows = await db.prepare(`
    SELECT
      article.id,
      article.source_id,
      article.external_id,
      article.canonical_url,
      article.title,
      article.summary,
      article.author,
      article.published_at,
      article.fetched_at,
      article.content_hash,
      article.status,
      article.created_at,
      article.updated_at
    FROM articles AS article
    ${where}
    ORDER BY article.published_at DESC NULLS LAST, article.fetched_at DESC, article.id DESC
    LIMIT ?
  `).bind(...bindings, limit + 1).all<ArticleListRow>();

  const hasMore = rows.results.length > limit;
  const pageArticles = rows.results.slice(0, limit);
  const lastArticle = pageArticles[pageArticles.length - 1];
  return {
    articles: pageArticles,
    next_cursor: hasMore && lastArticle !== undefined
      ? encodeArticleCursor({
        published_at: lastArticle.published_at,
        fetched_at: lastArticle.fetched_at,
        id: lastArticle.id,
      })
      : null,
  };
}

export async function getArticle(db: D1Database, id: string): Promise<Article | null> {
  return db.prepare("SELECT * FROM articles WHERE id = ? LIMIT 1").bind(id).first<Article>();
}
