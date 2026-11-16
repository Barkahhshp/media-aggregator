import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";

export const MAX_SOURCE_CURSOR_BYTES = 4 * 1024;
export const HASHED_CURSOR_PREFIX = "__cue_cursor_sha256_v1__:";

/** Keep ordinary identities readable, but never persist oversized or reserved-prefix identities verbatim. */
export function stableCursorValue(identity: string): string {
  const bytes = new TextEncoder().encode(identity);
  if (bytes.byteLength <= MAX_SOURCE_CURSOR_BYTES && !identity.startsWith(HASHED_CURSOR_PREFIX)) return identity;
  return `${HASHED_CURSOR_PREFIX}${bytesToHex(sha256(bytes))}`;
}
