export interface SourceCursor {
  kind: "feed" | "sitemap";
  value: string;
}

export interface Candidate {
  sourceId?: string;
  dedupeKey: string;
  canonicalUrl: string;
  externalId: string | null;
  title: string | null;
  summary: string | null;
  author: string | null;
  publishedAt: string | null;
  sourceCursor: SourceCursor | null;
  terminalFailure?: { status: "blocked" | "failed"; code: string; message: string };
}

export interface FetchLimits {
  maxRedirects?: number;
  timeoutMs?: number;
  maxBytes?: number;
}

export interface FetchResult {
  url: URL;
  status: number;
  headers: Headers;
  body: string;
  bytes: number;
}

export interface ParsedFeed {
  candidates: Candidate[];
  hasMore: boolean;
  cursorFound: boolean;
  nextCursor: SourceCursor | null;
  rejectedCount: number;
}

export interface ParsedSitemap {
  locations: SitemapLocation[];
  isIndex: boolean;
  nextCursor: SourceCursor | null;
  rejectedCount: number;
}

export interface SitemapLocation {
  url: string;
  lastModified: string | null;
  sourceCursor: SourceCursor;
  terminalFailure?: { status: "blocked" | "failed"; code: string; message: string };
}

export interface ExtractedArticle {
  title: string | null;
  summary: string | null;
  author: string | null;
  publishedAt: string | null;
  body: string;
}
