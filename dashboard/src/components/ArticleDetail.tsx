import { useCallback, useEffect, useState } from "react";
import type { TokenSession } from "../auth/AuthProvider";
import { apiRequest } from "../api/client";
import { LoadingError } from "./LoadingError";
import { StatusBadge } from "./StatusBadge";

interface ArticleRecord {
  id: string;
  source_id: string;
  title: string;
  summary: string | null;
  author: string | null;
  published_at: string | null;
  fetched_at: number;
  content_text: string;
  status: string;
}

interface ArticleDetailProps {
  articleId: string;
  session: Pick<TokenSession, "getToken" | "clear">;
  onClose?: () => void;
}

function apiMessage(payload: unknown, status: number): string {
  if (typeof payload === "object" && payload !== null && "error" in payload) {
    const error = (payload as { error?: unknown }).error;
    if (typeof error === "object" && error !== null && "message" in error) {
      const message = (error as { message?: unknown }).message;
      if (typeof message === "string" && message.length > 0) return message;
    }
  }
  return `Article request failed (HTTP ${status})`;
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json() as unknown;
  } catch {
    return null;
  }
}

function formatTimestamp(value: string | number | null): string {
  if (value === null) return "Date unavailable";
  const date = new Date(typeof value === "number" ? value * 1_000 : value);
  return Number.isNaN(date.getTime())
    ? "Date unavailable"
    : new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(date);
}

function isArticle(payload: unknown): payload is ArticleRecord {
  if (typeof payload !== "object" || payload === null) return false;
  const article = payload as Partial<ArticleRecord>;
  return typeof article.id === "string" && typeof article.source_id === "string" &&
    typeof article.title === "string" && typeof article.content_text === "string" &&
    typeof article.fetched_at === "number" && typeof article.status === "string";
}

export function ArticleDetail({ articleId, session, onClose }: ArticleDetailProps) {
  const [article, setArticle] = useState<ArticleRecord | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadArticle = useCallback(async (isActive: () => boolean) => {
    setLoading(true);
    setError(null);
    try {
      const response = await apiRequest(session, `/v1/articles/${encodeURIComponent(articleId)}`);
      const payload = await readJson(response);
      if (!response.ok) throw new Error(apiMessage(payload, response.status));
      if (typeof payload !== "object" || payload === null || !("article" in payload) || !isArticle(payload.article)) {
        throw new Error("The article detail response was not recognized");
      }
      if (isActive()) setArticle(payload.article);
    } catch (caught) {
      if (isActive()) setError(caught instanceof Error ? caught.message : "Article detail could not be loaded");
    } finally {
      if (isActive()) setLoading(false);
    }
  }, [articleId, session]);

  useEffect(() => {
    let active = true;
    void loadArticle(() => active);
    return () => { active = false; };
  }, [loadArticle]);

  return (
    <section className="article-detail-card" aria-label="Article details">
      <div className="article-detail-heading">
        <p className="eyebrow">Full article</p>
        {onClose !== undefined && (
          <button className="secondary-button" type="button" onClick={onClose} aria-label="Close article details">Close details</button>
        )}
      </div>
      <LoadingError loading={loading} error={error} onRetry={() => { void loadArticle(() => true); }}>
        {article !== null && (
          <article>
            <h3>{article.title}</h3>
            {article.summary !== null && article.summary !== "" && <p className="article-detail-summary">{article.summary}</p>}
            <dl className="article-detail-metadata">
              <div><dt>Article ID</dt><dd>{article.id}</dd></div>
              <div><dt>Source ID</dt><dd>{article.source_id}</dd></div>
              <div><dt>Author</dt><dd>{article.author ?? "Unknown"}</dd></div>
              <div><dt>Published</dt><dd>{formatTimestamp(article.published_at)}</dd></div>
              <div><dt>Fetched</dt><dd>{formatTimestamp(article.fetched_at)}</dd></div>
              <div><dt>Status</dt><dd><StatusBadge status={article.status} /></dd></div>
            </dl>
            <section className="article-detail-content" aria-label="Full article text">
              <h4>Article text</h4>
              {article.content_text === "" ? <p>No full article text was stored.</p> : <p className="article-body">{article.content_text}</p>}
            </section>
          </article>
        )}
      </LoadingError>
    </section>
  );
}
