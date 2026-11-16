import { describe, expect, it } from "vitest";
import type { ArticleSelectors } from "../src/sources/types";

interface ExtractedArticle {
  title: string | null;
  summary: string | null;
  author: string | null;
  publishedAt: string | null;
  body: string;
}

interface HtmlExtractorModule {
  extractArticle(html: string, selectors: ArticleSelectors): Promise<ExtractedArticle>;
}

const extractorModules = import.meta.glob<HtmlExtractorModule>("../src/ingest/html-extractor.ts");

async function loadExtractArticle() {
  const moduleLoader = extractorModules["../src/ingest/html-extractor.ts"];
  expect(moduleLoader).toBeDefined();
  if (!moduleLoader) return undefined;
  const module = await moduleLoader();
  expect(module.extractArticle).toBeTypeOf("function");
  return module.extractArticle;
}

const selectors: ArticleSelectors = {
  title: "h1.headline",
  summary: ".dek",
  author: ".byline",
  publishedAt: "time.published",
  body: "article.story",
};

describe("HTML article extraction", () => {
  it("extracts_configured_fields_and_time_attributes_with_HTMLRewriter", async () => {
    const extractArticle = await loadExtractArticle();
    if (!extractArticle) return;

    const html = `<h1 class="headline">A <em>clear</em> title</h1><p class="dek">Summary text</p><span class="byline">Reporter Name</span><time class="published" datetime="2026-11-16T03:00:00Z">Today</time><article class="story"><p>Body paragraph one.</p><p>Body paragraph two.</p></article>`;

    await expect(extractArticle(html, selectors)).resolves.toMatchObject({
      title: "A clear title",
      summary: "Summary text",
      author: "Reporter Name",
      publishedAt: "2026-11-16T03:00:00Z",
      body: "Body paragraph one. Body paragraph two.",
    });
  });

  it("returns_empty_values_when_configured_selectors_do_not_match", async () => {
    const extractArticle = await loadExtractArticle();
    if (!extractArticle) return;

    await expect(extractArticle("<main><p>No configured selectors are present.</p></main>", selectors)).resolves.toEqual({
      title: null,
      summary: null,
      author: null,
      publishedAt: null,
      body: "",
    });
  });

  it("falls_back_to_visible_text_when_a_time_element_has_no_datetime_attribute", async () => {
    const extractArticle = await loadExtractArticle();
    if (!extractArticle) return;

    const html = `<h1 class="headline">Title</h1><time class="published">2026-11-16T03:00:00Z</time><article class="story">Article text.</article>`;
    await expect(extractArticle(html, selectors)).resolves.toMatchObject({
      publishedAt: "2026-11-16T03:00:00Z",
    });
  });

  it("extracts_publication_dates_from_meta_content_attributes", async () => {
    const extractArticle = await loadExtractArticle();
    if (!extractArticle) return;

    const html = `<html><head><meta class="published" content="2026-11-16T03:00:00Z"></head><body><h1 class="headline">Title</h1><article class="story">Article text.</article></body></html>`;
    await expect(extractArticle(html, { ...selectors, publishedAt: "meta.published" })).resolves.toMatchObject({
      publishedAt: "2026-11-16T03:00:00Z",
    });
  });

  it("extracts_title_summary_and_author_from_meta_content_selectors", async () => {
    const extractArticle = await loadExtractArticle();
    if (!extractArticle) return;

    const html = `<html><head><meta property="og:title" content="Metadata title"><meta name="description" content="Metadata summary"><meta name="author" content="Metadata author"></head><body><article class="story">Article text.</article></body></html>`;
    const metaSelectors: ArticleSelectors = {
      title: 'meta[property="og:title"]',
      summary: 'meta[name="description"]',
      author: 'meta[name="author"]',
      body: selectors.body,
    };
    await expect(extractArticle(html, metaSelectors)).resolves.toMatchObject({
      title: "Metadata title",
      summary: "Metadata summary",
      author: "Metadata author",
    });
  });

  it("rejects_HTML_payloads_over_2_MiB_UTF8", async () => {
    const extractArticle = await loadExtractArticle();
    if (!extractArticle) return;

    await expect(extractArticle(`<article>${"x".repeat(2 * 1024 * 1024)}</article>`, selectors)).rejects.toThrow();
  });
});
