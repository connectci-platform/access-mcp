import { describe, test, expect } from "vitest";
import { projectFields } from "../projection.js";

// Representative envelope sample, modeled on the shape Pillar 1 produced.
const sample = {
  total: 3,
  items: [
    {
      id: "anvil.purdue.access-ci.org",
      name: "Anvil",
      url: "https://anvil.example",
      description: "A compute resource",
      tags: ["cpu", "gpu"],
    },
    {
      id: "delta.ncsa.access-ci.org",
      name: "Delta",
      url: "https://delta.example",
      description: "Another compute resource",
      tags: ["gpu"],
    },
    {
      id: "bridges2.psc.access-ci.org",
      name: "Bridges-2",
      url: "https://bridges2.example",
      description: "Yet another",
      tags: ["cpu"],
    },
  ],
  metadata: {
    pagination: { limit: 25, offset: 0, has_more: false },
    aggregations: {
      counts: { operational: 2, affected: 1 },
      popular_tags: ["cpu", "gpu"],
    },
    filters_applied: { query: "compute" },
  },
  documentation: {
    related_tools: ["get_resource_details"],
    links: { see_all_url: "https://example.test/all" },
  },
} as const;

describe("projectFields", () => {
  describe("guard rails", () => {
    test("returns response unchanged when fields is undefined", () => {
      const out = projectFields(sample, undefined);
      expect(out).toBe(sample);
    });

    test("returns response unchanged when fields is null", () => {
      const out = projectFields(sample, null);
      expect(out).toBe(sample);
    });

    test("does not mutate input when projecting", () => {
      const before = JSON.stringify(sample);
      projectFields(sample, ["items[].name"]);
      expect(JSON.stringify(sample)).toBe(before);
    });
  });

  describe("always-preserve sticky containers (total, metadata, documentation)", () => {
    test("includes total even when fields omits it", () => {
      const out = projectFields(sample, ["items[].name"]);
      expect(out.total).toBe(3);
    });

    test("empty fields array preserves all sticky containers", () => {
      const out = projectFields(sample, []);
      expect(out).toEqual({
        total: 3,
        metadata: sample.metadata,
        documentation: sample.documentation,
      });
    });

    test("does not invent total when response has no total", () => {
      const out = projectFields({ items: [{ a: 1 }] }, ["items[].a"]);
      expect(out).toEqual({ items: [{ a: 1 }] });
      expect(out).not.toHaveProperty("total");
    });

    test("does not invent metadata/documentation when response has none", () => {
      const minimal = { total: 1, items: [{ a: 1 }] };
      const out = projectFields(minimal, ["items[].a"]);
      expect(out).toEqual({ total: 1, items: [{ a: 1 }] });
      expect(out).not.toHaveProperty("metadata");
      expect(out).not.toHaveProperty("documentation");
    });

    test("sticky preservation skipped when caller projects a sub-path", () => {
      // Explicit metadata.pagination.has_more in paths means caller is
      // narrowing into metadata — don't sticky-add the whole subtree.
      // filters_applied still rides along (sticky-within-metadata), so it
      // is asserted separately below rather than baked into this toEqual.
      const out = projectFields(sample, [
        "items[].name",
        "metadata.pagination.has_more",
      ]);
      expect(out.metadata).toEqual({
        pagination: { has_more: false },
        filters_applied: sample.metadata.filters_applied,
      });
      // documentation wasn't projected explicitly; still preserved.
      expect(out.documentation).toEqual(sample.documentation);
    });
  });

  describe("filters_applied sticky-within-metadata", () => {
    const sampleWithFilters = {
      total: 2,
      items: [{ id: 1 }],
      metadata: {
        pagination: { has_more: true, limit: 25 },
        filters_applied: { query: "x", tags: null },
        query_relevance: "exact",
      },
    };

    test("subpath projection into metadata still rescues filters_applied, not the rest of metadata", () => {
      const out = projectFields(sampleWithFilters, [
        "metadata.pagination.has_more",
      ]);
      expect(out.metadata).toEqual({
        pagination: { has_more: true },
        filters_applied: { query: "x", tags: null },
      });
      // Proves this isn't just reverting to whole-metadata stickiness.
      expect(out.metadata).not.toHaveProperty("query_relevance");
    });

    test("regression: no filters_applied in metadata — subpath projection unchanged", () => {
      const noFilters = {
        total: 1,
        metadata: { pagination: { has_more: false, limit: 10 } },
      };
      const out = projectFields(noFilters, ["metadata.pagination.has_more"]);
      expect(out).toEqual({
        total: 1,
        metadata: { pagination: { has_more: false } },
      });
      expect(out.metadata).not.toHaveProperty("filters_applied");
    });

    test("regression: whole-metadata sticky case (metadata unmentioned) is unchanged", () => {
      const out = projectFields(sampleWithFilters, ["items[].id"]);
      expect(out.metadata).toEqual(sampleWithFilters.metadata);
    });

    test("caller explicitly lists metadata.filters_applied — no double-add", () => {
      const out = projectFields(sampleWithFilters, [
        "metadata.pagination.has_more",
        "metadata.filters_applied",
      ]);
      expect(out.metadata).toEqual({
        pagination: { has_more: true },
        filters_applied: { query: "x", tags: null },
      });
    });
  });

  describe("path syntax", () => {
    test("projects items[].field to per-element subset", () => {
      const out = projectFields(sample, ["items[].name", "items[].url"]);
      expect(out).toEqual({
        total: 3,
        items: [
          { name: "Anvil", url: "https://anvil.example" },
          { name: "Delta", url: "https://delta.example" },
          { name: "Bridges-2", url: "https://bridges2.example" },
        ],
        metadata: sample.metadata,
        documentation: sample.documentation,
      });
    });

    test("bare 'items' includes the array as-is", () => {
      const out = projectFields(sample, ["items"]);
      expect(out.items).toEqual(sample.items);
      expect(out.total).toBe(3);
    });

    test("'items[]' alone is equivalent to bare 'items'", () => {
      const a = projectFields(sample, ["items"]);
      const b = projectFields(sample, ["items[]"]);
      expect(b).toEqual(a);
    });

    test("nested object projection — metadata.pagination.has_more", () => {
      const out = projectFields(sample, [
        "metadata.pagination.has_more",
      ]);
      expect(out).toEqual({
        total: 3,
        // filters_applied rides along (sticky-within-metadata) even though
        // only a pagination subpath was projected — see the dedicated
        // "filters_applied sticky-within-metadata" describe block below.
        metadata: {
          pagination: { has_more: false },
          filters_applied: sample.metadata.filters_applied,
        },
        documentation: sample.documentation,
      });
    });

    test("includes whole subtree when path ends at an interior node", () => {
      const out = projectFields(sample, ["metadata.aggregations"]);
      expect(out).toEqual({
        total: 3,
        metadata: {
          aggregations: sample.metadata.aggregations,
          filters_applied: sample.metadata.filters_applied,
        },
        documentation: sample.documentation,
      });
    });

    test("nested arrays — items[].tags returns each element's tags array", () => {
      const out = projectFields(sample, ["items[].tags"]);
      expect(out).toEqual({
        total: 3,
        items: [
          { tags: ["cpu", "gpu"] },
          { tags: ["gpu"] },
          { tags: ["cpu"] },
        ],
        metadata: sample.metadata,
        documentation: sample.documentation,
      });
    });

    test("union of paths combines under shared prefix", () => {
      const out = projectFields(sample, [
        "items[].name",
        "items[].id",
        "metadata.pagination",
        "documentation.links.see_all_url",
      ]);
      expect(out).toEqual({
        total: 3,
        items: [
          { id: "anvil.purdue.access-ci.org", name: "Anvil" },
          { id: "delta.ncsa.access-ci.org", name: "Delta" },
          { id: "bridges2.psc.access-ci.org", name: "Bridges-2" },
        ],
        metadata: {
          pagination: { limit: 25, offset: 0, has_more: false },
          filters_applied: sample.metadata.filters_applied,
        },
        documentation: { links: { see_all_url: "https://example.test/all" } },
      });
    });

    test("terminal path wins over child path under same prefix", () => {
      // Asking for both "metadata" (whole) and "metadata.pagination.has_more"
      // (narrow) should include the whole metadata subtree — the broader path
      // is more permissive.
      const out = projectFields(sample, [
        "metadata",
        "metadata.pagination.has_more",
      ]);
      expect(out).toEqual({
        total: 3,
        metadata: sample.metadata,
        documentation: sample.documentation,
      });
    });
  });

  describe("missing-field handling", () => {
    test("silently omits keys that do not exist on the response", () => {
      const out = projectFields(sample, [
        "items[].name",
        "items[].fancy_color",
      ]);
      expect(out).toEqual({
        total: 3,
        items: [
          { name: "Anvil" },
          { name: "Delta" },
          { name: "Bridges-2" },
        ],
        metadata: sample.metadata,
        documentation: sample.documentation,
      });
    });

    test("missing top-level branch silently omitted", () => {
      const out = projectFields(sample, [
        "items[].name",
        "experimental.thing",
      ]);
      expect(out).toEqual({
        total: 3,
        items: [
          { name: "Anvil" },
          { name: "Delta" },
          { name: "Bridges-2" },
        ],
        metadata: sample.metadata,
        documentation: sample.documentation,
      });
      expect(out).not.toHaveProperty("experimental");
    });

    test("all-missing paths still yield sticky containers", () => {
      const out = projectFields(sample, ["nope", "nada.zilch"]);
      expect(out).toEqual({
        total: 3,
        metadata: sample.metadata,
        documentation: sample.documentation,
      });
    });
  });

  describe("structural edge cases", () => {
    test("non-items envelope projects correctly (lookup-by-id shape)", () => {
      const lookup = {
        total: 1,
        items: [{ id: 42, name: "found", description: "long text…" }],
      };
      const out = projectFields(lookup, ["items[].name"]);
      expect(out).toEqual({ total: 1, items: [{ name: "found" }] });
    });

    test("empty items array projects to empty array (not dropped)", () => {
      const empty = { total: 0, items: [] };
      const out = projectFields(empty, ["items[].name"]);
      expect(out).toEqual({ total: 0, items: [] });
    });

    test("projection without an items path drops items entirely", () => {
      const out = projectFields(sample, [
        "metadata.pagination.has_more",
      ]);
      expect(out).not.toHaveProperty("items");
    });

    test("response with only total returns identity after projection", () => {
      const out = projectFields({ total: 5 }, []);
      expect(out).toEqual({ total: 5 });
    });

    test("path with whitespace trimmed", () => {
      const out = projectFields(sample, [" items[].name "]);
      expect(out).toEqual({
        total: 3,
        items: [{ name: "Anvil" }, { name: "Delta" }, { name: "Bridges-2" }],
        metadata: sample.metadata,
        documentation: sample.documentation,
      });
    });
  });
});
