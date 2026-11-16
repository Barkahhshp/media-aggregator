import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { normalizeAndValidateUrl } from "./url-policy";
import { stableCursorValue } from "./cursor";
import { normalizePublishedAt } from "./feed-parser";
import type { ParsedSitemap } from "./types";
import { childrenNamed, firstChildText, localName, parseXmlDocument } from "./xml";

const SAFE_METADATA_URL_PREFIX = "https://metadata.invalid/sha256/";

function safeMetadataUrl(value: string): string {
  return `${SAFE_METADATA_URL_PREFIX}${bytesToHex(sha256(new TextEncoder().encode(value)))}`;
}

export function parseSitemap(body: string): ParsedSitemap {
  const root = parseXmlDocument(body);
  const rootName = localName(root.name);
  const isIndex = rootName === "sitemapindex";
  if (!isIndex && rootName !== "urlset") throw new Error("Unsupported sitemap root element");

  const recordName = isIndex ? "sitemap" : "url";
  const locations: ParsedSitemap["locations"] = [];
  const seen = new Set<string>();
  for (const record of childrenNamed(root, recordName)) {
    const location = firstChildText(record, "loc");
    if (location.length === 0) continue;
    let canonical: string;
    try {
      canonical = normalizeAndValidateUrl(location).href;
    } catch {
      canonical = safeMetadataUrl(location);
      if (seen.has(canonical)) continue;
      seen.add(canonical);
      const sourceCursor = { kind: "sitemap" as const, value: stableCursorValue(canonical) };
      locations.push({
        url: canonical,
        lastModified: null,
        sourceCursor,
        terminalFailure: {
          status: "blocked",
          code: "blocked_unsafe_url",
          message: "Sitemap location is not a permitted public URL",
        },
      });
      continue;
    }
    if (seen.has(canonical)) continue;
    seen.add(canonical);
    const sourceCursor = { kind: "sitemap" as const, value: stableCursorValue(canonical) };
    locations.push({
      url: canonical,
      lastModified: normalizePublishedAt(firstChildText(record, "lastmod")),
      sourceCursor,
    });
  }

  return {
    locations,
    isIndex,
    nextCursor: locations[locations.length - 1]?.sourceCursor ?? null,
    rejectedCount: locations.filter((location) => location.terminalFailure !== undefined).length,
  };
}
