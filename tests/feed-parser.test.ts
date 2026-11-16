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
  sourceCursor: SourceCursor | null;
  terminalFailure?: { status: "blocked" | "failed"; code: string; message: string };
}

interface SourceCursor {
  kind: "feed" | "sitemap";
  value: string;
}

interface ParsedFeed {
  candidates: Candidate[];
  hasMore: boolean;
  cursorFound: boolean;
  nextCursor: SourceCursor | null;
  rejectedCount: number;
}

interface FeedParserModule {
  parseFeed(body: string, contentType: string, afterCursor?: SourceCursor): ParsedFeed;
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
  it("returns_unsafe_URLs_as_bounded_terminal_candidates_without_the_raw_URL", async () => {
    const module = await loadFeedParser();
    if (!module) return;

    const unsafeUrl = "http://127.0.0.1/private?token=do-not-store";
    const result = module.parseFeed(`<rss><channel><item><guid>local-story</guid><link>${unsafeUrl}</link><title>Local story</title></item><item><guid>safe</guid><link>https://example.com/safe</link></item></channel></rss>`, "application/rss+xml");
    const rejected = result.candidates[0];

    expect(result.rejectedCount).toBe(1);
    expect(result.candidates).toHaveLength(2);
    expect(rejected).toMatchObject({
      terminalFailure: { status: "blocked", code: "blocked_unsafe_url" },
      canonicalUrl: expect.stringMatching(/^https:\/\/metadata\.invalid\/sha256\/[a-f0-9]{64}$/),
      externalId: null,
      title: null,
      summary: null,
    });
    expect(rejected?.sourceCursor?.value.length).toBeLessThanOrEqual(4096);
    expect(JSON.stringify(rejected)).not.toContain(unsafeUrl);
    expect(result.nextCursor).toEqual(result.candidates[1]?.sourceCursor);
  });

  it("separates_a_safe_external_ID_that_matches_the_unsafe_hash_namespace", async () => {
    const module = await loadFeedParser();
    if (!module) return;

    const unsafeUrl = "http://127.0.0.1/private";
    const unsafeOnly = module.parseFeed(`<rss><channel><item><guid isPermaLink="false">local-story</guid><link>${unsafeUrl}</link></item></channel></rss>`, "application/rss+xml");
    const unsafeIdentity = unsafeOnly.candidates[0]?.dedupeKey;
    expect(unsafeIdentity).toBeDefined();

    const body = `<rss><channel><item><guid isPermaLink="false">local-story</guid><link>${unsafeUrl}</link></item><item><guid isPermaLink="false">${unsafeIdentity}</guid><link>https://example.com/safe</link></item></channel></rss>`;
    const result = module.parseFeed(body, "application/rss+xml");

    expect(result.candidates).toHaveLength(2);
    expect(result.candidates[0]?.terminalFailure?.code).toBe("blocked_unsafe_url");
    expect(result.candidates[1]?.terminalFailure).toBeUndefined();
    expect(result.candidates[1]?.dedupeKey).not.toBe(unsafeIdentity);
    expect(result.candidates[1]?.sourceCursor?.value).not.toBe(result.candidates[0]?.sourceCursor?.value);
  });

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

  it.each(["RSS", "Atom", "JSON Feed"] as const)("pages_all_%s_entries_beyond_100_until_every_candidate_is_emitted", async (format) => {
    const module = await loadFeedParser();
    if (!module) return;

    const slug = format === "RSS" ? "rss-paged" : format === "Atom" ? "atom-paged" : "json-paged";
    const urls = Array.from({ length: 205 }, (_, index) => `https://example.com/${slug}-${index}`);
    const body = format === "RSS"
      ? `<rss><channel>${urls.map((url, index) => `<item><guid>${slug}-${index}</guid><link>${url}</link><title>Page ${index}</title></item>`).join("")}</channel></rss>`
      : format === "Atom"
        ? `<feed xmlns="http://www.w3.org/2005/Atom">${urls.map((url, index) => `<entry><id>${slug}-${index}</id><link rel="alternate" href="${url}"/><title>Page ${index}</title></entry>`).join("")}</feed>`
        : JSON.stringify({ version: "https://jsonfeed.org/version/1.1", items: urls.map((url, index) => ({ id: `${slug}-${index}`, url, title: `Page ${index}` })) });
    const contentType = format === "RSS" ? "application/rss+xml" : format === "Atom" ? "application/atom+xml" : "application/feed+json";
    const yieldedUrls: string[] = [];
    let afterCursor: SourceCursor | undefined;
    let pageCount = 0;
    let hasMore = true;

    while (hasMore) {
      const page = module.parseFeed(body, contentType, afterCursor);
      pageCount += 1;
      expect(page.cursorFound).toBe(true);
      expect(page.candidates.length).toBeLessThanOrEqual(100);
      yieldedUrls.push(...page.candidates.map((candidate) => candidate.canonicalUrl));
      hasMore = page.hasMore;
      afterCursor = page.nextCursor ?? undefined;
      expect(pageCount).toBeLessThanOrEqual(3);
    }

    expect(pageCount).toBe(3);
    expect(yieldedUrls).toHaveLength(205);
    expect(yieldedUrls[0]).toBe(urls[0]);
    expect(yieldedUrls[204]).toBe(urls[204]);
    expect(new Set(yieldedUrls).size).toBe(205);
  });

  it("uses_bounded_namespaced_SHA256_cursors_for_oversized_or_reserved_ID_values", async () => {
    const module = await loadFeedParser();
    if (!module) return;
    const longId = `long-${"x".repeat(5000)}`;
    const reservedId = `__cue_cursor_sha256_v1__:${"a".repeat(64)}`;
    const body = `<rss><channel><item><guid>${longId}</guid><link>https://example.com/long</link></item><item><guid>${reservedId}</guid><link>https://example.com/reserved</link></item></channel></rss>`;

    const firstParse = module.parseFeed(body, "application/rss+xml");
    const repeatParse = module.parseFeed(body, "application/rss+xml");
    const longCursor = firstParse.candidates[0]?.sourceCursor?.value ?? "";
    const reservedCursor = firstParse.candidates[1]?.sourceCursor?.value ?? "";

    expect(longCursor).toBe("__cue_cursor_sha256_v1__:e18e44419b858b33e42399d9e25b5afc283e77e51a9654953273e4cf64dce80d");
    expect(reservedCursor).toBe("__cue_cursor_sha256_v1__:df2657a194263f5c0472f50a14fb70029cd10efa62162aeb9708d51af51cc8e2");
    expect(longCursor).not.toBe(longId);
    expect(reservedCursor).not.toBe(reservedId);
    expect(new TextEncoder().encode(longCursor).byteLength).toBeLessThanOrEqual(4096);
    expect(repeatParse).toEqual(firstParse);
  });

  it("hashes_an_oversized_no_ID_canonical_URL_instead_of_emitting_an_unbounded_cursor", async () => {
    const module = await loadFeedParser();
    if (!module) return;
    const longUrl = `https://example.com/${"path".repeat(1300)}`;
    const body = `<rss><channel><item><link>${longUrl}</link><title>No ID</title></item></channel></rss>`;

    const page = module.parseFeed(body, "application/rss+xml");
    const candidate = page.candidates[0];
    const cursor = candidate?.sourceCursor?.value ?? "";

    expect(candidate?.externalId).toBeNull();
    expect(candidate?.dedupeKey).toBe(candidate?.canonicalUrl);
    expect(cursor).toBe("__cue_cursor_sha256_v1__:bdd86a8c872c43b0b7bb15d6fa5f13d1cebbe773d37eeac7e09eb592685e5702");
    expect(new TextEncoder().encode(cursor).byteLength).toBeLessThanOrEqual(4096);
  });

  it("pages_after_a_hashed_long_ID_without_replay_when_that_ID_is_duplicated", async () => {
    const module = await loadFeedParser();
    if (!module) return;
    const longId = `long-${"z".repeat(5000)}`;
    const items = [
      ...Array.from({ length: 99 }, (_, index) => `<item><guid>story-${index}</guid><link>https://example.com/story-${index}</link></item>`),
      `<item><guid>${longId}</guid><link>https://example.com/long-first</link></item>`,
      `<item><guid>${longId}</guid><link>https://example.com/long-duplicate</link></item>`,
      ...Array.from({ length: 6 }, (_, index) => `<item><guid>later-${index}</guid><link>https://example.com/later-${index}</link></item>`),
    ];
    const body = `<rss><channel>${items.join("")}</channel></rss>`;
    const first = module.parseFeed(body, "application/rss+xml");
    const second = module.parseFeed(body, "application/rss+xml", first.nextCursor ?? undefined);

    expect(first.candidates).toHaveLength(100);
    expect(first.nextCursor?.value).toMatch(/^__cue_cursor_sha256_v1__:[a-f0-9]{64}$/);
    expect(second.candidates.map((candidate) => candidate.dedupeKey)).toEqual(Array.from({ length: 6 }, (_, index) => `later-${index}`));
    expect(second.candidates.some((candidate) => candidate.canonicalUrl === "https://example.com/long-duplicate")).toBe(false);
    expect(second.hasMore).toBe(false);
  });

  it("deduplicates_repeated_IDs_before_paging_and_keeps_the_first_candidate", async () => {
    const module = await loadFeedParser();
    if (!module) return;

    const items = [
      `<item><guid>repeated-id</guid><link>https://example.com/first-representation</link><title>First</title></item>`,
      ...Array.from({ length: 98 }, (_, index) => {
        const id = index + 1;
        return `<item><guid>item-${id}</guid><link>https://example.com/item-${id}</link><title>Item ${id}</title></item>`;
      }),
      `<item><guid>repeated-id</guid><link>https://example.com/duplicate-representation</link><title>Duplicate</title></item>`,
      ...[100, 101, 102].map((id) => `<item><guid>item-${id}</guid><link>https://example.com/item-${id}</link><title>Item ${id}</title></item>`),
    ];
    const body = `<rss><channel>${items.join("")}</channel></rss>`;
    const yielded: Candidate[] = [];
    let afterCursor: SourceCursor | undefined;
    let hasMore = true;
    let pageCount = 0;

    while (hasMore) {
      const page = module.parseFeed(body, "application/rss+xml", afterCursor);
      pageCount += 1;
      expect(page.cursorFound).toBe(true);
      yielded.push(...page.candidates);
      hasMore = page.hasMore;
      afterCursor = page.nextCursor ?? undefined;
      expect(pageCount).toBeLessThanOrEqual(2);
    }

    const expectedKeys = ["repeated-id", ...Array.from({ length: 98 }, (_, index) => `item-${index + 1}`), "item-100", "item-101", "item-102"];
    expect(pageCount).toBe(2);
    expect(yielded.map((candidate) => candidate.dedupeKey)).toEqual(expectedKeys);
    expect(yielded).toHaveLength(102);
    expect(yielded[0]?.canonicalUrl).toBe("https://example.com/first-representation");
    expect(yielded.some((candidate) => candidate.canonicalUrl === "https://example.com/duplicate-representation")).toBe(false);
  });

  it("deduplicates_repeated_no_ID_URLs_before_paging_and_keeps_the_first_candidate", async () => {
    const module = await loadFeedParser();
    if (!module) return;

    const items = [
      `<item><link>https://example.com/no-id-0</link><title>First</title></item>`,
      ...Array.from({ length: 98 }, (_, index) => {
        const id = index + 1;
        return `<item><link>https://example.com/no-id-${id}</link><title>Item ${id}</title></item>`;
      }),
      `<item><link>https://example.com/no-id-0</link><title>Duplicate</title></item>`,
      ...[100, 101, 102].map((id) => `<item><link>https://example.com/no-id-${id}</link><title>Item ${id}</title></item>`),
    ];
    const body = `<rss><channel>${items.join("")}</channel></rss>`;
    const yielded: Candidate[] = [];
    let afterCursor: SourceCursor | undefined;
    let hasMore = true;
    let pageCount = 0;

    while (hasMore) {
      const page = module.parseFeed(body, "application/rss+xml", afterCursor);
      pageCount += 1;
      expect(page.cursorFound).toBe(true);
      yielded.push(...page.candidates);
      hasMore = page.hasMore;
      afterCursor = page.nextCursor ?? undefined;
      expect(pageCount).toBeLessThanOrEqual(2);
    }

    const expectedKeys = [
      "https://example.com/no-id-0",
      ...Array.from({ length: 98 }, (_, index) => `https://example.com/no-id-${index + 1}`),
      "https://example.com/no-id-100",
      "https://example.com/no-id-101",
      "https://example.com/no-id-102",
    ];
    expect(pageCount).toBe(2);
    expect(yielded.map((candidate) => candidate.dedupeKey)).toEqual(expectedKeys);
    expect(yielded).toHaveLength(102);
    expect(yielded[0]?.canonicalUrl).toBe("https://example.com/no-id-0");
    expect(yielded[0]?.title).toBe("First");
    expect(yielded.filter((candidate) => candidate.canonicalUrl === "https://example.com/no-id-0")).toHaveLength(1);
  });

  it("restarts_from_the_first_page_when_the_saved_cursor_is_missing", async () => {
    const module = await loadFeedParser();
    if (!module) return;

    const body = `<rss><channel><item><guid>first</guid><link>https://example.com/first</link></item><item><guid>second</guid><link>https://example.com/second</link></item></channel></rss>`;
    const page = module.parseFeed(body, "application/rss+xml", { kind: "feed", value: "deleted-from-current-feed" });

    expect(page.cursorFound).toBe(false);
    expect(page.candidates[0]?.canonicalUrl).toBe("https://example.com/first");
    expect(page.hasMore).toBe(false);
    expect(page.nextCursor).toEqual({ kind: "feed", value: "second" });
  });

  it("returns_an_empty_page_after_a_valid_last_cursor_for_poll_reset", async () => {
    const module = await loadFeedParser();
    if (!module) return;

    const body = `<rss><channel><item><guid>last</guid><link>https://example.com/last</link></item></channel></rss>`;
    const firstPage = module.parseFeed(body, "application/rss+xml");
    const emptyPage = module.parseFeed(body, "application/rss+xml", firstPage.nextCursor ?? undefined);

    expect(emptyPage.candidates).toEqual([]);
    expect(emptyPage.cursorFound).toBe(true);
    expect(emptyPage.hasMore).toBe(false);
    expect(emptyPage.nextCursor).toBeNull();
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
