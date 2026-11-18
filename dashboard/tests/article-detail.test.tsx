import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TokenSession } from "../src/auth/AuthProvider";
import { ArticleDetail } from "../src/components/ArticleDetail";

function createSession() {
  const session = new TokenSession();
  session.login("task-11-test-token");
  return session;
}

function articleFixture(overrides: Record<string, unknown> = {}) {
  return {
    id: "article-detail-1",
    source_id: "source-7",
    external_id: "external-7",
    canonical_url: "https://publisher.example.test/story",
    title: "A detailed story",
    summary: "The summary text.",
    author: "Ada Writer",
    published_at: "2025-02-03T12:00:00.000Z",
    fetched_at: 1_738_598_400,
    content_text: "Full article body text.",
    content_hash: "hash-7",
    status: "stored",
    created_at: 1_738_598_400,
    updated_at: 1_738_598_400,
    ...overrides,
  };
}

function jsonResponse(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), { status, headers: { "Content-Type": "application/json" } });
}

describe("Article detail", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("loads full text and metadata, including a missing publication date", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      expect(String(input)).toBe("/v1/articles/article-detail-1");
      return jsonResponse({ article: articleFixture({ published_at: null }) });
    });
    vi.stubGlobal("fetch", fetchMock);
    const onClose = vi.fn();

    render(<ArticleDetail articleId="article-detail-1" session={createSession()} onClose={onClose} />);

    expect(await screen.findByRole("heading", { name: "A detailed story" })).toBeTruthy();
    expect(screen.getByText("The summary text.")).toBeTruthy();
    expect(screen.getByText("Full article body text.")).toBeTruthy();
    expect(screen.getByText("Ada Writer")).toBeTruthy();
    expect(screen.getByText("source-7")).toBeTruthy();
    expect(screen.getByText(/date unavailable/i)).toBeTruthy();
    expect(screen.getByText(/stored/i)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /close article details/i }));
    expect(onClose).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("renders malicious title, summary, and body markup only as inert text", async () => {
    const malicious = "<script>window.__articleXss = true</script><img src=x onerror=alert(1)>";
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ article: articleFixture({ title: malicious, summary: malicious, content_text: malicious }) })));
    const { container } = render(<ArticleDetail articleId="article-detail-1" session={createSession()} />);

    expect(await screen.findAllByText(malicious, { exact: true })).toHaveLength(3);
    expect(container.querySelector("script, img, iframe, svg")).toBeNull();
    expect((window as Window & { __articleXss?: boolean }).__articleXss).toBeUndefined();
  });

  it("shows a retryable error when article detail cannot be loaded", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ error: { code: "article_not_found", message: "Article not found", request_id: "req-404" } }, 404)));

    render(<ArticleDetail articleId="missing-article" session={createSession()} />);

    expect(await screen.findByText("Article not found")).toBeTruthy();
    expect(screen.getByRole("button", { name: /retry/i })).toBeTruthy();
  });
});
