import type { PendingItem } from "./pending-repository";
import { fetchPublicUrl } from "./http-fetch";
import { normalizeAndValidateUrl } from "./url-policy";
import type { FetchResult } from "./types";
import type { Source } from "../sources/types";

function sourceHeaders(source: Source): Headers {
  const headers = new Headers();
  if (source.etag !== null) headers.set("If-None-Match", source.etag);
  if (source.last_modified !== null) headers.set("If-Modified-Since", source.last_modified);
  return headers;
}

export async function fetchSourceDocument(source: Source, onRequest?: () => void): Promise<FetchResult> {
  const url = normalizeAndValidateUrl(source.url, source.host);
  return fetchPublicUrl(url, source.host, { headers: sourceHeaders(source), onRequest });
}

export async function fetchPendingDocument(source: Source, item: PendingItem, onRequest?: () => void): Promise<FetchResult> {
  const url = normalizeAndValidateUrl(item.canonical_url, source.host);
  return fetchPublicUrl(url, source.host, { onRequest });
}
