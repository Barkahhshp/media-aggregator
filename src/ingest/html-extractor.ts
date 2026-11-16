import type { ArticleSelectors } from "../sources/types";
import type { ExtractedArticle } from "./types";

const MAX_HTML_BYTES = 2 * 1024 * 1024;
const VOID_ELEMENTS = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"]);

interface CollectedValue {
  value: string;
  found: boolean;
  complete: boolean;
  captureText: boolean;
}

function makeCollector(attribute?: string | readonly string[]): { result: CollectedValue; handler: HTMLRewriterElementContentHandlers } {
  const result: CollectedValue = { value: "", found: false, complete: false, captureText: attribute === undefined };
  const handler: HTMLRewriterElementContentHandlers = {
    element(element) {
      if (result.found) return;
      result.found = true;
      if (attribute !== undefined) {
        const attributeNames = typeof attribute === "string" ? [attribute] : attribute;
        for (const name of attributeNames) {
          const value = element.getAttribute(name);
          if (value !== null) {
            result.value = value;
            break;
          }
        }
        result.captureText = result.value.length === 0;
      }
      if (result.captureText && !VOID_ELEMENTS.has(element.tagName.toLowerCase())) {
        element.onEndTag(() => { result.complete = true; });
      } else {
        result.complete = true;
      }
    },
    text(text) {
      if (result.found && !result.complete && result.captureText) {
        result.value += text.text;
        if (text.lastInTextNode) result.value += " ";
      }
    },
  };
  return { result, handler };
}

function normalizedText(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}

export async function extractArticle(html: string, selectors: ArticleSelectors): Promise<ExtractedArticle> {
  if (new TextEncoder().encode(html).byteLength > MAX_HTML_BYTES) {
    throw new Error("HTML payload exceeds the 2 MiB parser limit");
  }

  const title = makeCollector("content");
  const summary = selectors.summary === undefined ? undefined : makeCollector("content");
  const author = selectors.author === undefined ? undefined : makeCollector("content");
  const publishedAt = selectors.publishedAt === undefined ? undefined : makeCollector(["datetime", "content"]);
  const body = makeCollector();
  let rewriter = new HTMLRewriter()
    .on(selectors.title, title.handler)
    .on(selectors.body, body.handler);
  if (selectors.summary !== undefined && summary !== undefined) rewriter = rewriter.on(selectors.summary, summary.handler);
  if (selectors.author !== undefined && author !== undefined) rewriter = rewriter.on(selectors.author, author.handler);
  if (selectors.publishedAt !== undefined && publishedAt !== undefined) {
    rewriter = rewriter.on(selectors.publishedAt, publishedAt.handler);
  }

  const transformed = rewriter.transform(new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8" } }));
  await transformed.text();

  const titleValue = title.result.found ? normalizedText(title.result.value) : "";
  const summaryValue = summary?.result.found ? normalizedText(summary.result.value) : "";
  const authorValue = author?.result.found ? normalizedText(author.result.value) : "";
  const publishedValue = publishedAt?.result.found ? normalizedText(publishedAt.result.value) : "";
  return {
    title: titleValue.length === 0 ? null : titleValue,
    summary: summaryValue.length === 0 ? null : summaryValue,
    author: authorValue.length === 0 ? null : authorValue,
    publishedAt: publishedValue.length === 0 ? null : publishedValue,
    body: normalizedText(body.result.value),
  };
}
