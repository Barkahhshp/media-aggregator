import { useCallback, useEffect, useState } from "react";
import type { FormEvent } from "react";
import type { TokenSession } from "../auth/AuthProvider";
import { apiRequest } from "../api/client";
import { ArticleDetail } from "../components/ArticleDetail";
import { LoadingError } from "../components/LoadingError";
import { StatusBadge } from "../components/StatusBadge";

interface ArticleSource {
  id: string;
  host: string;
}

interface ArticleListItem {
  id: string;
  source_id: string;
  title: string;
  summary: string | null;
  author: string | null;
  published_at: string | null;
  fetched_at: number;
  status: string;
}

interface ArticlePageResult {
  articles: ArticleListItem[];
  next_cursor: string | null;
}

interface ArticleFilters {
  sourceId: string;
  from: string;
  to: string;
  q: string;
  limit: number;
}

interface ArticlesPageProps {
  session: Pick<TokenSession, "getToken" | "clear">;
}

const DEFAULT_FILTERS: ArticleFilters = { sourceId: "", from: "", to: "", q: "", limit: 20 };

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

function dateLabel(value: string | null): string {
  if (value === null) return "Date unavailable";
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? "Date unavailable"
    : new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(date);
}

function localDayBoundary(value: string, nextDay = false): string | null {
  if (value === "") return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(value);
  if (match === null) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(0);
  date.setFullYear(year, month - 1, day);
  date.setHours(0, 0, 0, 0);
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) return null;
  if (nextDay) date.setDate(date.getDate() + 1);
  return date.toISOString();
}

function articleListPath(filters: ArticleFilters, cursor: string | null): string {
  const params = new URLSearchParams();
  if (filters.sourceId !== "") params.set("source_id", filters.sourceId);
  if (filters.from !== "") params.set("from", filters.from);
  if (filters.to !== "") params.set("to", filters.to);
  if (filters.q !== "") params.set("q", filters.q);
  params.set("limit", String(filters.limit));
  if (cursor !== null) params.set("cursor", cursor);
  return `/v1/articles?${params.toString()}`;
}

function validArticlePage(payload: unknown): payload is ArticlePageResult {
  if (typeof payload !== "object" || payload === null || !("articles" in payload) || !("next_cursor" in payload)) return false;
  const page = payload as { articles?: unknown; next_cursor?: unknown };
  return Array.isArray(page.articles) && (page.next_cursor === null || typeof page.next_cursor === "string");
}

export function ArticlesPage({ session }: ArticlesPageProps) {
  const [sources, setSources] = useState<ArticleSource[]>([]);
  const [sourcesError, setSourcesError] = useState<string | null>(null);
  const [draftFilters, setDraftFilters] = useState<ArticleFilters>(DEFAULT_FILTERS);
  const [filters, setFilters] = useState<ArticleFilters>(DEFAULT_FILTERS);
  const [filterError, setFilterError] = useState<string | null>(null);
  const [cursorHistory, setCursorHistory] = useState<Array<string | null>>([null]);
  const [pageIndex, setPageIndex] = useState(0);
  const [page, setPage] = useState<ArticlePageResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selectedArticleId, setSelectedArticleId] = useState<string | null>(null);

  const loadSources = useCallback(async () => {
    setSourcesError(null);
    try {
      const response = await apiRequest(session, "/v1/sources");
      const payload = await readJson(response);
      if (!response.ok) throw new Error(apiMessage(payload, response.status));
      if (typeof payload !== "object" || payload === null || !("sources" in payload) || !Array.isArray(payload.sources)) {
        throw new Error("The source list response was not recognized");
      }
      const options = payload.sources.filter((source): source is ArticleSource =>
        typeof source === "object" && source !== null && "id" in source && "host" in source &&
        typeof source.id === "string" && typeof source.host === "string",
      );
      setSources(options);
    } catch (caught) {
      setSourcesError(caught instanceof Error ? caught.message : "Sources could not be loaded");
    }
  }, [session]);

  useEffect(() => {
    void loadSources();
  }, [loadSources]);

  const currentCursor = cursorHistory[pageIndex] ?? null;
  const loadArticles = useCallback(async (isActive: () => boolean) => {
    setLoading(true);
    setLoadError(null);
    try {
      const response = await apiRequest(session, articleListPath(filters, currentCursor));
      const payload = await readJson(response);
      if (!response.ok) throw new Error(apiMessage(payload, response.status));
      if (!validArticlePage(payload)) throw new Error("The article list response was not recognized");
      if (isActive()) setPage(payload);
    } catch (caught) {
      if (isActive()) setLoadError(caught instanceof Error ? caught.message : "Articles could not be loaded");
    } finally {
      if (isActive()) setLoading(false);
    }
  }, [currentCursor, filters, session]);

  useEffect(() => {
    let active = true;
    void loadArticles(() => active);
    return () => { active = false; };
  }, [loadArticles]);

  const changeDraft = (key: keyof ArticleFilters, value: string) => {
    setDraftFilters((current) => ({ ...current, [key]: key === "limit" ? Number(value) : value }));
  };

  const applyFilters = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const from = localDayBoundary(draftFilters.from);
    const to = localDayBoundary(draftFilters.to, true);
    if ((draftFilters.from !== "" && from === null) || (draftFilters.to !== "" && to === null)) {
      setFilterError("Enter valid dates for the article range.");
      return;
    }
    if (from !== null && to !== null && from >= to) {
      setFilterError("The start date must be on or before the end date.");
      return;
    }
    setFilterError(null);
    setFilters({
      sourceId: draftFilters.sourceId,
      from: from ?? "",
      to: to ?? "",
      q: draftFilters.q.trim(),
      limit: draftFilters.limit,
    });
    setCursorHistory([null]);
    setPageIndex(0);
    setSelectedArticleId(null);
  };

  const goToNextPage = () => {
    if (page?.next_cursor === null || page?.next_cursor === undefined) return;
    const nextCursor = page.next_cursor;
    setCursorHistory((history) => [...history.slice(0, pageIndex + 1), nextCursor]);
    setPageIndex(pageIndex + 1);
    setSelectedArticleId(null);
  };

  const goToPreviousPage = () => {
    if (pageIndex === 0) return;
    setPageIndex((index) => index - 1);
    setSelectedArticleId(null);
  };

  const sourceHostById = new Map(sources.map((source) => [source.id, source.host]));

  return (
    <div className="page-content">
      <header className="page-heading">
        <p className="eyebrow">Collected stories</p>
        <h2>Articles / Feed</h2>
        <p>Search covers article titles and summaries, not full article bodies. Open a story to read its stored text and metadata.</p>
      </header>

      <form className="form-card article-filters" onSubmit={applyFilters}>
        <h3>Filter articles</h3>
        <div className="article-filter-grid">
          <label className="form-field" htmlFor="article-source-filter">
            Source
            <select id="article-source-filter" value={draftFilters.sourceId} onChange={(event) => changeDraft("sourceId", event.currentTarget.value)}>
              <option value="">All sources</option>
              {sources.map((source) => <option key={source.id} value={source.id}>{source.host} ({source.id})</option>)}
            </select>
          </label>
          <label className="form-field" htmlFor="article-from-filter">
            From date
            <input id="article-from-filter" type="date" value={draftFilters.from} onChange={(event) => changeDraft("from", event.currentTarget.value)} />
          </label>
          <label className="form-field" htmlFor="article-to-filter">
            To date
            <input id="article-to-filter" type="date" value={draftFilters.to} onChange={(event) => changeDraft("to", event.currentTarget.value)} />
          </label>
          <label className="form-field" htmlFor="article-search-filter">
            Search titles and summaries
            <input id="article-search-filter" type="search" value={draftFilters.q} onChange={(event) => changeDraft("q", event.currentTarget.value)} placeholder="Words to find" />
          </label>
          <label className="form-field" htmlFor="article-page-size">
            Articles per page
            <select id="article-page-size" value={draftFilters.limit} onChange={(event) => changeDraft("limit", event.currentTarget.value)}>
              <option value="20">20</option>
              <option value="50">50</option>
              <option value="100">100</option>
            </select>
          </label>
        </div>
        {sourcesError !== null && (
          <div className="article-source-error" role="alert">
            <p>Source options unavailable: {sourcesError}</p>
            <button className="secondary-button" type="button" onClick={() => void loadSources()}>Retry sources</button>
          </div>
        )}
        {filterError !== null && <p className="form-error" role="alert">{filterError}</p>}
        <div className="article-filter-actions">
          <button type="submit">Apply filters</button>
        </div>
      </form>

      <p className="article-search-note">Results are ordered by publication date, with undated stories after dated stories. Date filters follow your device's local calendar.</p>

      {selectedArticleId !== null && (
        <ArticleDetail
          articleId={selectedArticleId}
          session={session}
          onClose={() => setSelectedArticleId(null)}
        />
      )}

      <LoadingError loading={loading} error={loadError} onRetry={() => { void loadArticles(() => true); }}>
        {page !== null && page.articles.length === 0 ? (
          <section className="empty-state">
            <h3>No articles match these filters</h3>
            <p>Try a different source, date range, or search term.</p>
          </section>
        ) : (
          <>
            <section className="article-list" aria-label="Articles">
              {(page?.articles ?? []).map((article) => (
                <article className="article-card" key={article.id}>
                  <header className="article-card-header">
                    <div>
                      <h3>{article.title}</h3>
                      <p className="article-source-line">{sourceHostById.get(article.source_id) ?? "Source"} · ID: {article.source_id}</p>
                    </div>
                    <StatusBadge status={article.status} />
                  </header>
                  <p className="article-summary">{article.summary ?? "No summary available."}</p>
                  <dl className="article-metadata">
                    <div><dt>Published</dt><dd>{dateLabel(article.published_at)}</dd></div>
                    <div><dt>Author</dt><dd>{article.author ?? "Unknown"}</dd></div>
                    <div><dt>Fetched</dt><dd>{dateLabel(new Date(article.fetched_at * 1_000).toISOString())}</dd></div>
                  </dl>
                  <button className="secondary-button article-open-button" type="button" onClick={() => setSelectedArticleId(article.id)}>
                    Read full article
                  </button>
                </article>
              ))}
            </section>
            {page !== null && page.articles.length > 0 && (
              <nav className="article-pagination" aria-label="Article pages">
                <button className="secondary-button" type="button" disabled={pageIndex === 0 || loading} onClick={goToPreviousPage}>Previous page</button>
                <span>Page {pageIndex + 1}</span>
                <button className="secondary-button" type="button" disabled={page.next_cursor === null || loading} onClick={goToNextPage}>Next page</button>
              </nav>
            )}
          </>
        )}
      </LoadingError>
    </div>
  );
}
