import { describe, expect, it } from "vitest";

interface Candidate {
  sourceId?: string;
  dedupeKey: string;
  canonicalUrl: string;
  externalId: string | null;
  title: string | null;
  summary: string | null;
  author: string | null;
  publishedAt: string | null;
  sourceCursor: unknown;
}

interface FeedParserModule {
  parseFeed(body: string, contentType: string): { candidates: Candidate[] };
  normalizePublishedAt(value: string | null | undefined): string | null;
}

const feedModules = import.meta.glob<FeedParserModule>("../src/ingest/feed-parser.ts");

async function loadFeedParser() {
  const moduleLoader = feedModules["../src/ingest/feed-parser.ts"];
  expect(moduleLoader).toBeDefined();
  if (!moduleLoader) return undefined;
  const module = await moduleLoader();
  expect(module.parseFeed).toBeTypeOf("function");
  expect(module.normalizePublishedAt).toBeTypeOf("function");
  return module;
}

describe("feed parsing", () => {
  it("parses_RSS_items_into_canonical_provisional_candidates", async () => {
    const module = await loadFeedParser();
    if (!module) return;

    const body = `<?xml version="1.0"?><rss version="2.0"><channel><item><guid isPermaLink="false">story-1</guid><link>https://example.com/story-1#top</link><title>RSS title</title><description>Short summary</description><author>Grace Hopper</author><pubDate>Wed, 15 Nov 2023 12:00:00 +0200</pubDate></item></channel></rss>`;
    const result = module.parseFeed(body, "application/rss+xml");

    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]).toMatchObject({
      dedupeKey: "story-1",
      canonicalUrl: "https://example.com/story-1",
      externalId: "story-1",
      title: "RSS title",
      summary: "Short summary",
      author: "Grace Hopper",
      publishedAt: "2023-11-15T10:00:00.000Z",
    });
  });

  it("parses_Atom_entries_and_nested_author_names", async () => {
    const module = await loadFeedParser();
    if (!module) return;

    const body = `<feed xmlns="http://www.w3.org/2005/Atom"><entry><id>tag:example.com,2026:story</id><link rel="alternate" href="https://example.com/atom-story"/><title>Atom title</title><summary>Atom summary</summary><author><name>Ada Lovelace</name></author><published>2024-03-03T09:00:00+01:00</published></entry></feed>`;
    const result = module.parseFeed(body, "application/atom+xml");

    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]).toMatchObject({
      dedupeKey: "tag:example.com,2026:story",
      canonicalUrl: "https://example.com/atom-story",
      title: "Atom title",
      summary: "Atom summary",
      author: "Ada Lovelace",
      publishedAt: "2024-03-03T08:00:00.000Z",
    });
  });

  it("ignores_Atom_enclosure_links_when_no_alternate_article_link_exists", async () => {
    const module = await loadFeedParser();
    if (!module) return;

    const body = `<feed xmlns="http://www.w3.org/2005/Atom"><entry><id>tag:example.com,2026:audio</id><link rel="enclosure" href="https://example.com/audio.mp3"/><title>Audio item</title></entry></feed>`;
    const result = module.parseFeed(body, "application/atom+xml");

    expect(result.candidates).toHaveLength(0);
  });

  it("parses_RSS_1_0_RDF_items_outside_the_channel", async () => {
    const module = await loadFeedParser();
    if (!module) return;

    const body = `<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><channel><title>Site</title></channel><item><title>RDF story</title><link>https://example.com/rdf-story</link><description>RDF summary</description></item></rdf:RDF>`;
    const result = module.parseFeed(body, "application/rdf+xml");

    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]).toMatchObject({
      canonicalUrl: "https://example.com/rdf-story",
      title: "RDF story",
      summary: "RDF summary",
    });
  });

  it("parses_JSON_Feed_items", async () => {
    const module = await loadFeedParser();
    if (!module) return;

    const body = JSON.stringify({
      version: "https://jsonfeed.org/version/1.1",
      items: [{
        id: "json-id-7",
        url: "https://example.com/json-story",
        title: "JSON Feed title",
        summary: "JSON summary",
        authors: [{ name: "Katherine Johnson" }],
        date_published: "2025-01-02T03:04:05-04:00",
      }],
    });
    const result = module.parseFeed(body, "application/feed+json");

    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]).toMatchObject({
      dedupeKey: "json-id-7",
      canonicalUrl: "https://example.com/json-story",
      title: "JSON Feed title",
      summary: "JSON summary",
      author: "Katherine Johnson",
      publishedAt: "2025-01-02T07:04:05.000Z",
    });
  });

  it("parses_JSON_Feed_1_0_singular_author_objects", async () => {
    const module = await loadFeedParser();
    if (!module) return;

    const result = module.parseFeed(JSON.stringify({
      version: "https://jsonfeed.org/version/1",
      items: [{
        id: "legacy-json-id",
        url: "https://example.com/legacy-story",
        title: "Legacy JSON title",
        author: { name: "Dorothy Vaughan" },
      }],
    }), "application/feed+json");

    expect(result.candidates[0]).toMatchObject({
      externalId: "legacy-json-id",
      author: "Dorothy Vaughan",
    });
  });

  it("caps_parsed_candidates_at_100", async () => {
    const module = await loadFeedParser();
    if (!module) return;

    const items = Array.from({ length: 105 }, (_, index) =>
      `<item><guid>story-${index}</guid><link>https://example.com/${index}</link><title>Story ${index}</title></item>`,
    ).join("");
    const result = module.parseFeed(`<rss><channel>${items}</channel></rss>`, "application/rss+xml");

    expect(result.candidates).toHaveLength(100);
  });

  it("rejects_XML_DTD_and_entity_expansion_payloads", async () => {
    const module = await loadFeedParser();
    if (!module) return;

    const body = `<!DOCTYPE rss [<!ENTITY secret "expanded">]><rss><channel><item><title>&secret;</title><link>https://example.com/a</link></item></channel></rss>`;

    expect(() => module.parseFeed(body, "application/rss+xml")).toThrow();
  });

  it("normalizes_valid_dates_to_RFC3339_UTC", async () => {
    const module = await loadFeedParser();
    if (!module) return;

    expect(module.normalizePublishedAt("2026-11-16T10:00:00+07:00")).toBe("2026-11-16T03:00:00.000Z");
  });

  it("returns_null_for_invalid_dates", async () => {
    const module = await loadFeedParser();
    if (!module) return;

    expect(module.normalizePublishedAt("not a date")).toBeNull();
    expect(module.normalizePublishedAt(undefined)).toBeNull();
    expect(module.normalizePublishedAt(null)).toBeNull();
    expect(module.normalizePublishedAt("2026-02-30T00:00:00Z")).toBeNull();
    expect(module.normalizePublishedAt("Mon, 30 Feb 2026 12:00:00 GMT")).toBeNull();
    expect(module.normalizePublishedAt("February 30, 2026")).toBeNull();
  });

  it("returns_null_for_published_dates_over_64_UTF8_bytes", async () => {
    const module = await loadFeedParser();
    if (!module) return;

    expect(module.normalizePublishedAt("x".repeat(65))).toBeNull();
    expect(module.normalizePublishedAt("é".repeat(33))).toBeNull();
  });

  it("rejects_feed_payloads_over_2_MiB", async () => {
    const module = await loadFeedParser();
    if (!module) return;

    expect(() => module.parseFeed(`<rss>${" ".repeat(2 * 1024 * 1024)}</rss>`, "application/rss+xml")).toThrow();
  });
});
