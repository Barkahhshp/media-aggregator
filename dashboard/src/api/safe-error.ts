const MAX_DISPLAY_MESSAGE_LENGTH = 240;
const SAFE_ERROR_CODE = /^[a-z0-9_-]{1,64}$/i;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeMessage(message: string): string {
  const withoutControls = Array.from(message, (character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f) ? " " : character;
  }).join("");
  return withoutControls.replace(/\s+/g, " ").trim();
}

export function safeApiErrorMessage(payload: unknown, status: number, resourceLabel: string): string {
  const fallback = `${resourceLabel} request failed (HTTP ${status})`;
  if (!isRecord(payload) || !isRecord(payload.error)) return fallback;

  const { code, message } = payload.error;
  if (typeof code !== "string" || !SAFE_ERROR_CODE.test(code) || typeof message !== "string") return fallback;

  const normalized = normalizeMessage(message);
  if (normalized.length === 0) return fallback;
  if (normalized.length <= MAX_DISPLAY_MESSAGE_LENGTH) return normalized;
  return `${normalized.slice(0, MAX_DISPLAY_MESSAGE_LENGTH - 1).trimEnd()}…`;
}
