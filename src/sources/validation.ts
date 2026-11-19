import type { ApiError, ArticleSelectors, SourceInput, SourceKind } from "./types";

export const DEFAULT_POLL_INTERVAL_SEC = 7_200;
export const MIN_POLL_INTERVAL_SEC = 900;
export const MAX_ACTIVE_SOURCES = 100;
export const MAX_SOURCE_REQUEST_BYTES = 32 * 1024;
const MAX_SOURCE_URL_BYTES = 4 * 1024;
const MAX_SOURCE_HOST_BYTES = 255;

const sourceKinds: readonly SourceKind[] = ["feed", "sitemap", "article", "html_list"];
const allowedInputKeys = new Set(["kind", "url", "poll_interval_sec", "selectors"]);
const selectorKeys = new Set(["title", "summary", "author", "publishedAt", "body", "itemLink"]);

function error(status: number, code: string, message: string): ApiError {
  return { status, code, message };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateSelectors(value: unknown, kind: "article" | "feed" | "html_list"): ArticleSelectors | ApiError {
  if (!isRecord(value)) {
    return error(400, "invalid_selectors", "Selectors must be an object");
  }
  if (Object.keys(value).some((key) => !selectorKeys.has(key))) {
    return error(400, "invalid_selectors", "Selectors contain an unsupported field");
  }
  for (const required of ["title", "body"] as const) {
    if (typeof value[required] !== "string" || value[required].trim().length === 0) {
      return error(400, "invalid_selectors", `Selector ${required} is required`);
    }
  }
  for (const optional of ["summary", "author", "publishedAt"] as const) {
    if (value[optional] !== undefined && typeof value[optional] !== "string") {
      return error(400, "invalid_selectors", `Selector ${optional} must be a string`);
    }
  }
  if (kind === "html_list" && (typeof value.itemLink !== "string" || value.itemLink.trim().length === 0)) {
    return error(400, "invalid_selectors", "Selector itemLink is required for html_list sources");
  }
  if (kind !== "html_list" && value.itemLink !== undefined) {
    return error(400, "invalid_selectors", "Selector itemLink is only supported for html_list sources");
  }
  if (value.itemLink !== undefined && typeof value.itemLink !== "string") {
    return error(400, "invalid_selectors", "Selector itemLink must be a string");
  }
  return {
    title: value.title as string,
    body: value.body as string,
    ...(value.summary === undefined ? {} : { summary: value.summary as string }),
    ...(value.author === undefined ? {} : { author: value.author as string }),
    ...(value.publishedAt === undefined ? {} : { publishedAt: value.publishedAt as string }),
    ...(value.itemLink === undefined ? {} : { itemLink: value.itemLink as string }),
  };
}

export function isApiError(value: unknown): value is ApiError {
  return isRecord(value) && "status" in value && "code" in value;
}

export function validateSourceInput(input: unknown): SourceInput | ApiError {
  if (!isRecord(input)) {
    return error(400, "invalid_source_input", "Source input must be a JSON object");
  }

  let encodedBytes: number;
  try {
    encodedBytes = new TextEncoder().encode(JSON.stringify(input)).byteLength;
  } catch {
    return error(400, "invalid_source_input", "Source input must be serializable JSON");
  }
  if (encodedBytes > MAX_SOURCE_REQUEST_BYTES) {
    return error(413, "request_too_large", "Request body exceeds 32 KiB");
  }

  if (Object.keys(input).some((key) => !allowedInputKeys.has(key))) {
    return error(400, "invalid_source_input", "Source input contains an unsupported field");
  }

  if (typeof input.kind !== "string" || !sourceKinds.includes(input.kind as SourceKind)) {
    return error(400, "invalid_source_kind", "Source kind must be feed, sitemap, article, or html_list");
  }

  if (typeof input.url !== "string" || input.url.length === 0 || input.url.trim() !== input.url) {
    return error(400, "invalid_source_url", "Source URL must be an absolute HTTP or HTTPS URL");
  }

  let url: URL;
  try {
    url = new URL(input.url);
  } catch {
    return error(400, "invalid_source_url", "Source URL must be an absolute HTTP or HTTPS URL");
  }
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.hostname.length === 0 ||
    url.username.length > 0 ||
    url.password.length > 0 ||
    (url.port.length > 0 && url.port !== "80" && url.port !== "443")
  ) {
    return error(400, "invalid_source_url", "Source URL must use HTTP or HTTPS on port 80 or 443 without credentials");
  }
  const normalizedUrl = url.toString();
  if (new TextEncoder().encode(normalizedUrl).byteLength > MAX_SOURCE_URL_BYTES) {
    return error(400, "source_url_too_large", "Source URL exceeds 4 KiB");
  }
  if (new TextEncoder().encode(url.hostname).byteLength > MAX_SOURCE_HOST_BYTES) {
    return error(400, "source_host_too_large", "Source host exceeds 255 UTF-8 bytes");
  }

  const interval = input.poll_interval_sec === undefined ? DEFAULT_POLL_INTERVAL_SEC : input.poll_interval_sec;
  if (!Number.isSafeInteger(interval) || (interval as number) < MIN_POLL_INTERVAL_SEC) {
    return error(400, "invalid_poll_interval", "Poll interval must be an integer of at least 900 seconds");
  }

  let selectors: ArticleSelectors | undefined;
  if (input.kind === "article" || input.kind === "html_list") {
    const checked = validateSelectors(input.selectors, input.kind);
    if (isApiError(checked)) return checked;
    selectors = checked as ArticleSelectors;
  } else if (input.kind === "feed" && input.selectors !== undefined && input.selectors !== null) {
    const checked = validateSelectors(input.selectors, "feed");
    if (isApiError(checked)) return checked;
    selectors = checked as ArticleSelectors;
  } else if (input.kind === "feed" && input.selectors === null) {
    // An explicit null removes a feed override and restores the default selectors.
  } else if (input.selectors !== undefined) {
    return error(400, "invalid_selectors", "Selectors are only supported for feed, article, and html_list sources");
  }

  return {
    kind: input.kind as SourceKind,
    url: normalizedUrl,
    poll_interval_sec: interval as number,
    ...(selectors === undefined ? {} : { selectors }),
  };
}
