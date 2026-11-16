import { normalizeAndValidateUrl } from "./url-policy";
import { normalizePublishedAt } from "./feed-parser";
import type { ParsedSitemap } from "./types";
import { childrenNamed, firstChildText, localName, parseXmlDocument } from "./xml";

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
      continue;
    }
    if (seen.has(canonical)) continue;
    seen.add(canonical);
    locations.push({
      url: canonical,
      lastModified: normalizePublishedAt(firstChildText(record, "lastmod")),
      sourceCursor: { kind: "sitemap", value: canonical },
    });
  }

  return {
    locations,
    isIndex,
    nextCursor: locations[locations.length - 1]?.sourceCursor ?? null,
  };
}
