export interface ArticleInput {
  title: string;
  summary: string | null;
  author: string | null;
  publishedAt: string | null;
  contentText: string;
}

export interface Article {
  id: string;
  source_id: string;
  external_id: string | null;
  canonical_url: string;
  title: string;
  summary: string | null;
  author: string | null;
  published_at: string | null;
  fetched_at: number;
  content_text: string;
  content_hash: string;
  status: "stored" | "content_too_large" | "blocked" | "failed";
  created_at: number;
  updated_at: number;
}

export type SaveArticleResult =
  | { status: "saved"; articleId: string; committed: true }
  | { status: "content_too_large"; articleId: string; committed: true }
  | { status: "storage_limit"; articleId: null; committed: true }
  | { status: "metadata_too_large" | "row_too_large" | "lease_lost" | "storage_limit"; articleId: null; committed?: false };
