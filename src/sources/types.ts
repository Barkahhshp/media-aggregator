export type SourceKind = "feed" | "sitemap" | "article" | "html_list";

export interface ArticleSelectors {
  title: string;
  summary?: string;
  author?: string;
  publishedAt?: string;
  body: string;
}

export interface SourceInput {
  kind: SourceKind;
  url: string;
  poll_interval_sec: number;
  selectors?: ArticleSelectors;
}

export interface Source extends Omit<SourceInput, "selectors"> {
  id: string;
  host: string;
  selectors: ArticleSelectors | null;
  enabled: boolean;
  next_fetch_at: number;
  etag: string | null;
  last_modified: string | null;
  feed_watermark: string | null;
  sitemap_last_loc: string | null;
  consecutive_errors: number;
  last_status: string | null;
  last_fetched_at: number | null;
  created_at: number;
  updated_at: number;
}

export interface ApiError {
  status: number;
  code: string;
  message: string;
}

export interface SourcePatchInput {
  poll_interval_sec?: number;
  selectors?: ArticleSelectors;
  enabled?: boolean;
}
