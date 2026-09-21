import { describe, test, expect } from "vitest";
import { assertFiltersAppliedShape } from "../filters-applied-conformance.js";

function toolResponse(envelope: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(envelope) }],
  };
}

describe("assertFiltersAppliedShape", () => {
  test("passes when the key set exactly matches expectedKeys", () => {
    const response = toolResponse({
      metadata: { filters_applied: { query: "gpu", tags: null, date: null } },
    });

    expect(() =>
      assertFiltersAppliedShape(response, ["query", "tags", "date"], expect)
    ).not.toThrow();
  });

  test("passes when a key is present but null (present-but-null is valid)", () => {
    const response = toolResponse({
      metadata: { filters_applied: { query: null, tags: null, date: null } },
    });

    expect(() =>
      assertFiltersAppliedShape(response, ["query", "tags", "date"], expect)
    ).not.toThrow();
  });

  test("fails when an expected key is missing", () => {
    const response = toolResponse({
      metadata: { filters_applied: { query: "gpu", tags: null } },
    });

    expect(() =>
      assertFiltersAppliedShape(response, ["query", "tags", "date"], expect)
    ).toThrow();
  });

  test("fails when there is an extra, undeclared key", () => {
    const response = toolResponse({
      metadata: {
        filters_applied: { query: "gpu", tags: null, date: null, extra: "surprise" },
      },
    });

    expect(() =>
      assertFiltersAppliedShape(response, ["query", "tags", "date"], expect)
    ).toThrow();
  });

  test("fails when metadata.filters_applied is absent entirely", () => {
    const response = toolResponse({ metadata: { pagination: { limit: 25 } } });

    expect(() =>
      assertFiltersAppliedShape(response, ["query", "tags", "date"], expect)
    ).toThrow();
  });

  test("fails when the response is not a { content: [{ type: 'text' }] } envelope", () => {
    expect(() =>
      assertFiltersAppliedShape({ notAToolResponse: true }, ["query"], expect)
    ).toThrow();
  });
});
