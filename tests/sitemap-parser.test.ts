import { describe, expect, it } from "vitest";

interface SitemapParserModule {
  parseSitemap(body: string): {
    locations: Array<{
      url: string;
      lastModified: string | null;
      sourceCursor: { kind: "sitemap"; value: string };
      terminalFailure?: { status: "blocked" | "failed"; code: string; message: string };
    }>;
    isIndex: boolean;
    nextCursor: { kind: "sitemap"; value: string } | null;
    rejectedCount: number;
  };
}

const sitemapModules = import.meta.glob<SitemapParserModule>("../src/ingest/sitemap-parser.ts");

async function loadParseSitemap() {
  const moduleLoader = sitemapModules["../src/ingest/sitemap-parser.ts"];
  expect(moduleLoader).toBeDefined();
  if (!moduleLoader) return undefined;
  const module = await moduleLoader();
  expect(module.parseSitemap).toBeTypeOf("function");
  return module.parseSitemap;
}

describe("sitemap parsing", () => {
  it("returns_unsafe_locations_as_bounded_terminal_records_without_the_raw_URL", async () => {
    const parseSitemap = await loadParseSitemap();
    if (!parseSitemap) return;

    const unsafeUrl = "http://127.0.0.1/private?token=do-not-store";
    const result = parseSitemap(`<urlset><url><loc>${unsafeUrl}</loc><lastmod>2026-11-15</lastmod></url><url><loc>https://example.com/safe</loc></url></urlset>`);
    const rejected = result.locations[0];

    expect(result.rejectedCount).toBe(1);
    expect(result.locations).toHaveLength(2);
    expect(rejected).toMatchObject({
      url: expect.stringMatching(/^https:\/\/metadata\.invalid\/sha256\/[a-f0-9]{64}$/),
      lastModified: null,
      terminalFailure: { status: "blocked", code: "blocked_unsafe_url" },
    });
    expect(rejected?.sourceCursor.value.length).toBeLessThanOrEqual(4096);
    expect(JSON.stringify(rejected)).not.toContain(unsafeUrl);
    expect(result.nextCursor).toEqual(result.locations[1]?.sourceCursor);
  });

  it("preserves_more_than_100_urlset_locations_for_cursorable_batching", async () => {
    const parseSitemap = await loadParseSitemap();
    if (!parseSitemap) return;

    const urls = Array.from({ length: 105 }, (_, index) =>
      `<url><loc>https://example.com/article-${index}</loc><lastmod>2026-01-01</lastmod></url>`,
    ).join("");
    const result = parseSitemap(`<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls}</urlset>`);

    expect(result.isIndex).toBe(false);
    expect(result.locations).toHaveLength(105);
    expect(result.locations[0]?.url).toBe("https://example.com/article-0");
    expect(result.locations[104]?.url).toBe("https://example.com/article-104");
    expect(result.nextCursor).toEqual({ kind: "sitemap", value: "https://example.com/article-104" });
  });

  it("attaches_per_location_cursor_and_lastmod_for_safe_persistence", async () => {
    const parseSitemap = await loadParseSitemap();
    if (!parseSitemap) return;

    const result = parseSitemap(`<urlset><url><loc>https://example.com/news</loc><lastmod>2026-11-15T08:00:00+07:00</lastmod></url></urlset>`);

    expect(result.locations[0]).toEqual({
      url: "https://example.com/news",
      lastModified: "2026-11-15T01:00:00.000Z",
      sourceCursor: { kind: "sitemap", value: "https://example.com/news" },
    });
  });

  it("parses_sitemap_index_children_as_cursorable_locations", async () => {
    const parseSitemap = await loadParseSitemap();
    if (!parseSitemap) return;

    const result = parseSitemap(`<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><sitemap><loc>https://example.com/news-sitemap.xml</loc><lastmod>2026-11-15</lastmod></sitemap><sitemap><loc>https://example.com/pages-sitemap.xml</loc></sitemap></sitemapindex>`);

    expect(result).toMatchObject({
      isIndex: true,
      locations: [
        { url: "https://example.com/news-sitemap.xml", lastModified: "2026-11-15T00:00:00.000Z", sourceCursor: { kind: "sitemap", value: "https://example.com/news-sitemap.xml" } },
        { url: "https://example.com/pages-sitemap.xml", lastModified: null, sourceCursor: { kind: "sitemap", value: "https://example.com/pages-sitemap.xml" } },
      ],
      nextCursor: { kind: "sitemap", value: "https://example.com/pages-sitemap.xml" },
    });
  });

  it("rejects_DTD_and_entity_expansion_payloads", async () => {
    const parseSitemap = await loadParseSitemap();
    if (!parseSitemap) return;

    const body = `<!DOCTYPE urlset [<!ENTITY target "https://example.com/secret">]><urlset><url><loc>&target;</loc></url></urlset>`;

    expect(() => parseSitemap(body)).toThrow();
  });

  it("rejects_sitemap_payloads_over_2_MiB", async () => {
    const parseSitemap = await loadParseSitemap();
    if (!parseSitemap) return;

    expect(() => parseSitemap(`<urlset>${" ".repeat(2 * 1024 * 1024)}</urlset>`)).toThrow();
  });
});
