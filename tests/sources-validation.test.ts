import { describe, expect, it } from "vitest";

interface ValidationResult {
  kind?: string;
  url?: string;
  poll_interval_sec?: number;
  selectors?: Record<string, string>;
  status?: number;
  code?: string;
}

interface ValidationModule {
  validateSourceInput(input: unknown): ValidationResult;
}

const validationModules = import.meta.glob<ValidationModule>("../src/sources/validation.ts");

async function loadValidateSourceInput() {
  const moduleLoader = validationModules["../src/sources/validation.ts"];
  expect(moduleLoader).toBeDefined();
  if (!moduleLoader) return undefined;

  const module = await moduleLoader();
  expect(module.validateSourceInput).toBeTypeOf("function");
  return module.validateSourceInput;
}

const articleSelectors = {
  title: "h1",
  summary: ".summary",
  author: ".byline",
  publishedAt: "time[datetime]",
  body: "article",
};

describe("source input validation", () => {
  it.each([
    { kind: "feed", url: "https://example.com/feed.xml" },
    { kind: "sitemap", url: "https://example.com/sitemap.xml" },
    { kind: "article", url: "https://example.com/story", selectors: articleSelectors },
    { kind: "html_list", url: "https://example.com/news", selectors: { ...articleSelectors, itemLink: "a.story-link" } },
  ])("accepts valid $kind sources", async (input) => {
    const validateSourceInput = await loadValidateSourceInput();
    if (!validateSourceInput) return;

    const result = validateSourceInput(input);

    expect(result).toMatchObject({
      kind: input.kind,
      url: input.url,
      poll_interval_sec: 7200,
    });
  });

  it("requires_itemLink_for_html_list_sources", async () => {
    const validateSourceInput = await loadValidateSourceInput();
    if (!validateSourceInput) return;

    expect(validateSourceInput({ kind: "html_list", url: "https://example.com/news", selectors: articleSelectors }))
      .toMatchObject({ status: 400, code: "invalid_selectors" });
  });

  it("rejects_itemLink_on_single_article_sources", async () => {
    const validateSourceInput = await loadValidateSourceInput();
    if (!validateSourceInput) return;

    expect(validateSourceInput({ kind: "article", url: "https://example.com/story", selectors: { ...articleSelectors, itemLink: "a.story-link" } }))
      .toMatchObject({ status: 400, code: "invalid_selectors" });
  });

  it("rejects_an_unknown_source_kind", async () => {
    const validateSourceInput = await loadValidateSourceInput();
    if (!validateSourceInput) return;

    const result = validateSourceInput({ kind: "social", url: "https://example.com/feed" });

    expect(result).toMatchObject({ status: 400, code: "invalid_source_kind" });
  });

  it("rejects_invalid_or_non_http_source_urls", async () => {
    const validateSourceInput = await loadValidateSourceInput();
    if (!validateSourceInput) return;

    for (const url of ["not a URL", "ftp://example.com/feed", "https://user:pass@example.com/feed"]) {
      expect(validateSourceInput({ kind: "feed", url })).toMatchObject({
        status: 400,
        code: "invalid_source_url",
      });
    }
  });

  it("accepts_the_minimum_poll_interval_and_rejects_a_shorter_one", async () => {
    const validateSourceInput = await loadValidateSourceInput();
    if (!validateSourceInput) return;

    expect(validateSourceInput({ kind: "feed", url: "https://example.com/feed", poll_interval_sec: 900 }))
      .toMatchObject({ poll_interval_sec: 900 });
    expect(validateSourceInput({ kind: "feed", url: "https://example.com/feed", poll_interval_sec: 899 }))
      .toMatchObject({ status: 400, code: "invalid_poll_interval" });
  });

  it("rejects_HTML_source_selectors_that_exceed_the_UTF8_request_body_limit", async () => {
    const validateSourceInput = await loadValidateSourceInput();
    if (!validateSourceInput) return;

    const result = validateSourceInput({
      kind: "html_list",
      url: "https://example.com/news",
      selectors: { title: "h1", body: "🗞️".repeat(8192) },
    });

    expect(result).toMatchObject({ status: 413, code: "request_too_large" });
  });

  it("rejects_source_urls_that_exceed_the_4_KiB_UTF8_field_limit", async () => {
    const validateSourceInput = await loadValidateSourceInput();
    if (!validateSourceInput) return;

    const result = validateSourceInput({
      kind: "feed",
      url: `https://example.com/${"a".repeat(4_096)}`,
    });

    expect(result).toMatchObject({ status: 400, code: "source_url_too_large" });
  });
});
