import { describe, expect, it } from "vitest";

interface ArticleCursorValue {
  published_at: string | null;
  fetched_at: number;
  id: string;
}

interface ArticleCursorModule {
  encodeArticleCursor(value: ArticleCursorValue): string;
  decodeArticleCursor(token: string): ArticleCursorValue;
}

const modules = import.meta.glob<ArticleCursorModule>("../src/articles/cursor.ts");

async function loadCursor() {
  const loader = modules["../src/articles/cursor.ts"];
  expect(loader).toBeDefined();
  if (!loader) return undefined;
  const cursor = await loader();
  expect(cursor.encodeArticleCursor).toBeTypeOf("function");
  expect(cursor.decodeArticleCursor).toBeTypeOf("function");
  return cursor;
}

describe("article pagination cursor", () => {
  it("round_trips_the_complete_ordering_tuple_without_exposing_its_fields", async () => {
    const cursor = await loadCursor();
    if (!cursor) return;
    const value: ArticleCursorValue = {
      published_at: "2026-11-16T12:34:56.789Z",
      fetched_at: 1_800_000_000,
      id: "opaque-article-id",
    };

    const token = cursor.encodeArticleCursor(value);

    expect(token).not.toContain(value.id);
    expect(token).not.toContain(value.published_at);
    expect(cursor.decodeArticleCursor(token)).toEqual(value);
  });

  it("round_trips_a_null_published_at_for_the_nulls_last_order_boundary", async () => {
    const cursor = await loadCursor();
    if (!cursor) return;
    const value: ArticleCursorValue = { published_at: null, fetched_at: 77, id: "undated-article" };

    expect(cursor.decodeArticleCursor(cursor.encodeArticleCursor(value))).toEqual(value);
  });

  it("rejects_malformed_or_invalid_ordering_tuples", async () => {
    const cursor = await loadCursor();
    if (!cursor) return;

    expect(() => cursor.decodeArticleCursor("not-a-valid-cursor")).toThrow();
    expect(() => cursor.decodeArticleCursor(cursor.encodeArticleCursor({
      published_at: "yesterday",
      fetched_at: 77,
      id: "undated-article",
    }))).toThrow();
  });
});
