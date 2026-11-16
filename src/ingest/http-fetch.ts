import { normalizeAndValidateUrl } from "./url-policy";
import type { FetchLimits, FetchResult } from "./types";

const DEFAULT_MAX_REDIRECTS = 3;
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_BYTES = 2 * 1024 * 1024;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

async function readBoundedBody(response: Response, maxBytes: number): Promise<{ body: string; bytes: number }> {
  if (response.body === null) return { body: "", bytes: 0 };
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        await reader.cancel();
        throw new Error("Response body exceeds the configured byte limit");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { body: new TextDecoder("utf-8").decode(bytes), bytes: totalBytes };
}

export async function fetchPublicUrl(
  url: URL,
  sourceHost: string,
  limits: FetchLimits,
): Promise<FetchResult> {
  const maxRedirects = limits.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
  const timeoutMs = limits.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBytes = limits.maxBytes ?? DEFAULT_MAX_BYTES;
  if (!Number.isInteger(maxRedirects) || maxRedirects < 0 || maxRedirects > DEFAULT_MAX_REDIRECTS) {
    throw new Error("Redirect limit must be between zero and three");
  }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > DEFAULT_TIMEOUT_MS) {
    throw new Error("Timeout must be between zero and ten seconds");
  }
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0 || maxBytes > DEFAULT_MAX_BYTES) {
    throw new Error("Response byte limit must be between zero and two MiB");
  }

  let currentUrl = normalizeAndValidateUrl(url.href, sourceHost);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    for (let redirectCount = 0; ; redirectCount += 1) {
      const response = await fetch(currentUrl, {
        method: "GET",
        redirect: "manual",
        signal: controller.signal,
        headers: { Accept: "application/rss+xml, application/atom+xml, application/feed+json, application/json, application/xml, text/xml, text/html;q=0.9, */*;q=0.1" },
      });

      if (REDIRECT_STATUSES.has(response.status)) {
        const location = response.headers.get("Location");
        await response.body?.cancel();
        if (location === null) throw new Error("Redirect response is missing Location");
        if (redirectCount >= maxRedirects) throw new Error("Too many redirects");
        currentUrl = normalizeAndValidateUrl(new URL(location, currentUrl).href, sourceHost);
        continue;
      }

      const declaredLength = response.headers.get("Content-Length");
      if (declaredLength !== null) {
        const length = Number(declaredLength);
        if (Number.isFinite(length) && length > maxBytes) {
          await response.body?.cancel();
          throw new Error("Response body exceeds the configured byte limit");
        }
      }
      const { body, bytes } = await readBoundedBody(response, maxBytes);
      return { url: currentUrl, status: response.status, headers: response.headers, body, bytes };
    }
  } finally {
    clearTimeout(timeout);
  }
}
