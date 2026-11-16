export interface ArticleCursorValue {
  published_at: string | null;
  fetched_at: number;
  id: string;
}

const CURSOR_VERSION = 1;
const MAX_CURSOR_LENGTH = 1_024;

export class InvalidArticleCursorError extends Error {
  constructor() {
    super("Invalid article cursor");
    this.name = "InvalidArticleCursorError";
  }
}

function isValidPublishedAt(value: unknown): value is string | null {
  if (value === null) return true;
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value)) return false;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value;
}

function validateCursorValue(value: ArticleCursorValue): void {
  if (!isValidPublishedAt(value.published_at)) throw new InvalidArticleCursorError();
  if (!Number.isSafeInteger(value.fetched_at) || value.fetched_at < 0) throw new InvalidArticleCursorError();
  if (typeof value.id !== "string" || value.id.length === 0 || new TextEncoder().encode(value.id).byteLength > 512) {
    throw new InvalidArticleCursorError();
  }
}

function encodeBase64Url(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/gu, "-").replace(/\//gu, "_").replace(/=+$/gu, "");
}

function decodeBase64Url(token: string): string {
  if (token.length === 0 || token.length > MAX_CURSOR_LENGTH || !/^[A-Za-z0-9_-]+$/u.test(token)) {
    throw new InvalidArticleCursorError();
  }
  try {
    const base64 = token.replace(/-/gu, "+").replace(/_/gu, "/");
    const binary = atob(base64 + "=".repeat((4 - (base64.length % 4)) % 4));
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new InvalidArticleCursorError();
  }
}

export function encodeArticleCursor(value: ArticleCursorValue): string {
  validateCursorValue(value);
  return encodeBase64Url(JSON.stringify({ v: CURSOR_VERSION, ...value }));
}

export function decodeArticleCursor(token: string): ArticleCursorValue {
  const decoded = decodeBase64Url(token);
  let payload: unknown;
  try {
    payload = JSON.parse(decoded) as unknown;
  } catch {
    throw new InvalidArticleCursorError();
  }
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) throw new InvalidArticleCursorError();
  const record = payload as Record<string, unknown>;
  if (record.v !== CURSOR_VERSION) throw new InvalidArticleCursorError();
  const value = {
    published_at: record.published_at,
    fetched_at: record.fetched_at,
    id: record.id,
  };
  if (typeof value.published_at !== "string" && value.published_at !== null) throw new InvalidArticleCursorError();
  if (typeof value.fetched_at !== "number" || typeof value.id !== "string") throw new InvalidArticleCursorError();
  validateCursorValue(value as ArticleCursorValue);
  return value as ArticleCursorValue;
}
