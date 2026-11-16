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
  nextCursor: SourceCursor | null;
}

export interface ParsedSitemap {
  locations: SitemapLocation[];
  isIndex: boolean;
  nextCursor: SourceCursor | null;
}

export interface SitemapLocation {
  url: string;
  lastModified: string | null;
  sourceCursor: SourceCursor;
}

export interface ExtractedArticle {
  title: string | null;
  summary: string | null;
  author: string | null;
  publishedAt: string | null;
  body: string;
}
