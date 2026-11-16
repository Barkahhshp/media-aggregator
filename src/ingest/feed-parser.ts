import { normalizeAndValidateUrl } from "./url-policy";
import type { Candidate, ParsedFeed, SourceCursor } from "./types";
import { childrenNamed, firstChild, firstChildText, localName, nodeText, parseXmlDocument, type XmlNode } from "./xml";

const MAX_FEED_BYTES = 2 * 1024 * 1024;
const MAX_FEED_CANDIDATES = 100;

function hasValidCalendarDate(year: number, month: number, day: number): boolean {
  if (month < 1 || month > 12) return false;
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1] ?? 0;
  return day >= 1 && day <= daysInMonth;
}

function monthNumber(name: string): number {
  const months = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
  return months.indexOf(name.slice(0, 3).toLowerCase()) + 1;
}

function hasValidCalendarDateText(value: string): boolean {
  const iso = /^(\d{4})-(\d{2})-(\d{2})(?:T|\s|$)/iu.exec(value);
  if (iso !== null) return hasValidCalendarDate(Number(iso[1]), Number(iso[2]), Number(iso[3]));

  const dayFirst = /^(?:[A-Za-z]{3},\s*)?(\d{1,2})\s+([A-Za-z]{3,9})\s+(\d{4})(?:\s|$)/u.exec(value);
  if (dayFirst !== null) return hasValidCalendarDate(Number(dayFirst[3]), monthNumber(dayFirst[2] ?? ""), Number(dayFirst[1]));

  const monthFirst = /^([A-Za-z]{3,9})\s+(\d{1,2}),?\s+(\d{4})(?:\s|$)/u.exec(value);
  if (monthFirst !== null) return hasValidCalendarDate(Number(monthFirst[3]), monthNumber(monthFirst[1] ?? ""), Number(monthFirst[2]));
  return true;
}

function cleanText(value: string): string | null {
  const cleaned = value.replace(/\s+/gu, " ").trim();
  return cleaned.length === 0 ? null : cleaned;
}

export function normalizePublishedAt(value: string | null | undefined): string | null {
  if (value === null || value === undefined || new TextEncoder().encode(value).byteLength > 64 || !hasValidCalendarDateText(value)) return null;
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return null;
  const normalized = new Date(timestamp).toISOString();
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(normalized) ? normalized : null;
}

function candidate(
  item: { id: string; url: string; title?: string; summary?: string; author?: string; publishedAt?: string },
): Candidate | null {
  const externalId = cleanText(item.id);
  let canonicalUrl: string;
  try {
    canonicalUrl = normalizeAndValidateUrl(item.url).href;
  } catch {
    return null;
  }
  const cursor: SourceCursor = { kind: "feed", value: externalId ?? canonicalUrl };
  return {
    dedupeKey: externalId ?? canonicalUrl,
    canonicalUrl,
    externalId,
    title: cleanText(item.title ?? ""),
    summary: cleanText(item.summary ?? ""),
    author: cleanText(item.author ?? ""),
    publishedAt: normalizePublishedAt(item.publishedAt),
    sourceCursor: cursor,
  };
}

function rssCandidates(root: XmlNode): Candidate[] {
  const rootName = localName(root.name);
  const channel = rootName === "channel" ? root : firstChild(root, "channel");
  const items = rootName === "rdf" ? childrenNamed(root, "item") : childrenNamed(channel, "item");
  const output: Candidate[] = [];
  for (const item of items) {
    if (output.length >= MAX_FEED_CANDIDATES) break;
    const link = firstChildText(item, "link");
    const guidNode = firstChild(item, "guid");
    const guid = nodeText(guidNode).trim();
    const url = link || (guidNode?.attributes.isPermaLink?.toLowerCase() !== "false" ? guid : "");
    if (url.length === 0) continue;
    const parsed = candidate({
      id: guid || url,
      url,
      title: firstChildText(item, "title"),
      summary: firstChildText(item, "description"),
      author: firstChildText(item, "author") || firstChildText(item, "creator"),
      publishedAt: firstChildText(item, "pubDate") || firstChildText(item, "date"),
    });
    if (parsed !== null) output.push(parsed);
  }
  return output;
}

function atomLink(entry: XmlNode): string {
  const links = childrenNamed(entry, "link");
  const selected = links.find((link) => {
    const rel = link.attributes.rel?.toLowerCase();
    return rel === undefined || rel === "alternate";
  });
  return selected?.attributes.href ?? "";
}

function atomCandidates(root: XmlNode): Candidate[] {
  const entries = localName(root.name) === "entry" ? [root] : childrenNamed(root, "entry");
  const output: Candidate[] = [];
  for (const entry of entries) {
    if (output.length >= MAX_FEED_CANDIDATES) break;
    const id = firstChildText(entry, "id");
    const url = atomLink(entry) || id;
    if (url.length === 0) continue;
    const author = firstChild(entry, "author");
    const parsed = candidate({
      id: id || url,
      url,
      title: firstChildText(entry, "title"),
      summary: firstChildText(entry, "summary") || firstChildText(entry, "content"),
      author: firstChildText(author, "name"),
      publishedAt: firstChildText(entry, "published") || firstChildText(entry, "updated"),
    });
    if (parsed !== null) output.push(parsed);
  }
  return output;
}

function jsonCandidates(body: string): Candidate[] {
  let document: unknown;
  try {
    document = JSON.parse(body) as unknown;
  } catch {
    throw new Error("Invalid JSON Feed document");
  }
  if (typeof document !== "object" || document === null || Array.isArray(document)) {
    throw new Error("JSON Feed document must be an object");
  }
  const items = (document as { items?: unknown }).items;
  if (!Array.isArray(items)) throw new Error("JSON Feed items must be an array");
  const output: Candidate[] = [];
  for (const item of items) {
    if (output.length >= MAX_FEED_CANDIDATES) break;
    if (typeof item !== "object" || item === null || Array.isArray(item)) continue;
    const record = item as Record<string, unknown>;
    const id = typeof record.id === "string" ? record.id : "";
    const url = typeof record.url === "string" ? record.url : typeof record.external_url === "string" ? record.external_url : "";
    if (url.length === 0) continue;
    let author = "";
    if (Array.isArray(record.authors)) {
      const firstAuthor = record.authors.find((entry) => typeof entry === "object" && entry !== null && typeof (entry as Record<string, unknown>).name === "string");
      if (firstAuthor !== undefined) author = (firstAuthor as { name: string }).name;
    }
    if (author.length === 0 && typeof record.author === "object" && record.author !== null && !Array.isArray(record.author)) {
      if (typeof (record.author as Record<string, unknown>).name === "string") {
        author = (record.author as { name: string }).name;
      }
    }
    if (author.length === 0 && Array.isArray(record.author) && record.author.length > 0) {
      const firstAuthor = record.author[0];
      if (typeof firstAuthor === "object" && firstAuthor !== null && typeof (firstAuthor as Record<string, unknown>).name === "string") {
        author = (firstAuthor as { name: string }).name;
      }
    }
    const title = typeof record.title === "string" ? record.title : "";
    const summary = typeof record.summary === "string" ? record.summary : typeof record.content_text === "string" ? record.content_text : "";
    const publishedAt = typeof record.date_published === "string" ? record.date_published : typeof record.date_modified === "string" ? record.date_modified : "";
    const parsed = candidate({ id: id || url, url, title, summary, author, publishedAt });
    if (parsed !== null) output.push(parsed);
  }
  return output;
}

export function parseFeed(body: string, contentType: string): ParsedFeed {
  if (new TextEncoder().encode(body).byteLength > MAX_FEED_BYTES) throw new Error("Feed payload exceeds the 2 MiB parser limit");
  const candidates = contentType.toLowerCase().includes("json") || body.trimStart().startsWith("{")
    ? jsonCandidates(body)
    : (() => {
      const root = parseXmlDocument(body);
      switch (localName(root.name)) {
        case "rss":
        case "rdf":
        case "channel":
          return rssCandidates(root);
        case "feed":
        case "entry":
          return atomCandidates(root);
        default:
          throw new Error("Unsupported XML feed root element");
      }
    })();
  const nextCursor = candidates[candidates.length - 1]?.sourceCursor ?? null;
  return { candidates, nextCursor };
}
