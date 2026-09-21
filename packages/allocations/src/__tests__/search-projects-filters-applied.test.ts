import { describe, it, expect, vi } from "vitest";
import { AllocationsServer } from "../server.js";
import { assertFiltersAppliedShape } from "@access-mcp/shared/testkit/filters-applied";

/**
 * Per-branch behavioral tests for search_projects' `filters_applied`
 * disclosure (Phase 4b, allocations cosmetic tier — design §3).
 *
 * Canonical shape: `filters_applied` is a uniform six-key object
 * (query/field_of_science/resource_name/allocation_type/date_range/
 * min_allocation) on EVERY sub-handler (design §3 option b, matching
 * nsf-awards' buildFiltersApplied). The gate this suite exists to enforce:
 * a filter a branch DOES apply must show its applied value, NEVER null — a
 * false disclosure (e.g. field_of_science: null on a branch that filtered by
 * it) is strictly worse than the old omission-based shape it replaces.
 */

const ALL_KEYS = [
  "query",
  "field_of_science",
  "resource_name",
  "allocation_type",
  "date_range",
  "min_allocation",
];

type Resource = { resourceName: string; units: string | null; allocation: number | null; resourceId: number };

type Project = {
  projectId: number;
  requestNumber: string;
  requestTitle: string;
  pi: string;
  piInstitution: string;
  fos: string;
  abstract: string;
  allocationType: string;
  beginDate: string;
  endDate: string;
  resources: Resource[];
};

function makeProject(overrides: Partial<Project>): Project {
  return {
    projectId: 1,
    requestNumber: "R1",
    requestTitle: "Machine learning research project",
    pi: "Jane PI",
    piInstitution: "Test University",
    fos: "Computer Science",
    abstract: "machine learning research",
    allocationType: "Explore",
    beginDate: "2024-01-01",
    endDate: "2026-01-01",
    resources: [{ resourceName: "NCSA Delta GPU", units: "ACCESS Credits", allocation: 5000, resourceId: 1 }],
    ...overrides,
  };
}

/** Stub the resident corpus so tests are deterministic — no live API. */
function stubCorpus(server: AllocationsServer, records: Project[]) {
  vi.spyOn(server as unknown as { ensureCorpus: () => Promise<unknown> }, "ensureCorpus").mockResolvedValue({
    records,
    fetchedAt: 1_700_000_000_000,
    pages: 1,
    truncated: false,
  });
}

async function callSearchProjects(server: AllocationsServer, args: Record<string, unknown>) {
  return server["handleToolCall"]({
    method: "tools/call",
    params: { name: "search_projects", arguments: args },
  }) as Promise<{ content: Array<{ type: string; text: string }> }>;
}

async function callSearchProjectsJSON(server: AllocationsServer, args: Record<string, unknown>) {
  const res = await callSearchProjects(server, args);
  return JSON.parse(res.content[0].text);
}

describe("search_projects filters_applied — shape conformance (all four sub-handlers)", () => {
  it("searchProjects (query branch) conforms to the six-key shape", async () => {
    const server = new AllocationsServer();
    stubCorpus(server, [makeProject({})]);
    const res = await callSearchProjects(server, { query: "machine learning" });
    assertFiltersAppliedShape(res, ALL_KEYS, expect);
  });

  it("listProjectsByField conforms to the six-key shape", async () => {
    const server = new AllocationsServer();
    stubCorpus(server, [makeProject({})]);
    const res = await callSearchProjects(server, { field_of_science: "Computer Science" });
    assertFiltersAppliedShape(res, ALL_KEYS, expect);
  });

  it("listProjectsByAllocationType conforms to the six-key shape", async () => {
    const server = new AllocationsServer();
    stubCorpus(server, [makeProject({})]);
    const res = await callSearchProjects(server, { allocation_type: "Explore" });
    assertFiltersAppliedShape(res, ALL_KEYS, expect);
  });

  it("listProjectsByResource conforms to the six-key shape", async () => {
    const server = new AllocationsServer();
    stubCorpus(server, [makeProject({})]);
    const res = await callSearchProjects(server, { resource_name: "NCSA Delta GPU" });
    assertFiltersAppliedShape(res, ALL_KEYS, expect);
  });
});

describe("search_projects filters_applied — per-branch applied-value tests", () => {
  describe("searchProjects (query branch)", () => {
    it("discloses query, field_of_science, allocation_type, date_range, min_allocation with their APPLIED values when set; resource_name null", async () => {
      const server = new AllocationsServer();
      const recs = [
        makeProject({ projectId: 1, fos: "Computer Science", allocationType: "Explore", beginDate: "2024-06-01", endDate: "2025-06-01", resources: [{ resourceName: "R1", units: "ACCESS Credits", allocation: 5000, resourceId: 1 }] }),
        makeProject({ projectId: 2, fos: "Physics", allocationType: "Discover", requestTitle: "Unrelated physics project", abstract: "unrelated", beginDate: "2020-01-01", endDate: "2021-01-01", resources: [{ resourceName: "R2", units: "ACCESS Credits", allocation: 100, resourceId: 2 }] }),
      ];
      stubCorpus(server, recs);

      const res = await callSearchProjectsJSON(server, {
        query: "machine learning",
        field_of_science: "Computer Science",
        allocation_type: "Explore",
        date_range: { start_date: "2024-01-01" },
        min_allocation: 1000,
      });

      expect(res.metadata.filters_applied).toEqual({
        query: "machine learning",
        field_of_science: "Computer Science",
        resource_name: null,
        allocation_type: "Explore",
        date_range: { start_date: "2024-01-01" },
        min_allocation: 1000,
      });
      // The narrowing actually took effect: only project 1 matches all filters.
      expect(res.items.map((p: { projectId: number }) => p.projectId)).toEqual([1]);
    });

    // Regression guard, same class as the listProjectsByResource false-disclosure
    // bug: the router guard `args.resource_name && !args.query` is false once
    // query is also set, so resource_name+query together fall through to this
    // branch — which never filters by resource. resource_name must stay null.
    it("resource_name is null even when the caller also passes it alongside query — this branch never applies it", async () => {
      const server = new AllocationsServer();
      const recs = [
        makeProject({
          projectId: 1,
          requestTitle: "machine learning project",
          resources: [{ resourceName: "Purdue Anvil", units: "ACCESS Credits", allocation: 5000, resourceId: 1 }],
        }),
      ];
      stubCorpus(server, recs);

      const res = await callSearchProjectsJSON(server, {
        query: "machine learning",
        resource_name: "NCSA Delta GPU", // doesn't match project 1's resource
      });

      expect(res.metadata.filters_applied.resource_name).toBeNull();
      expect(res.metadata.filters_applied.query).toBe("machine learning");
      // Project 1 is returned despite its resource not matching the passed
      // resource_name — proving resource_name was NOT applied here.
      expect(res.items.map((p: { projectId: number }) => p.projectId)).toEqual([1]);
    });

    it("with only query set, all other keys are null (never a false-applied value)", async () => {
      const server = new AllocationsServer();
      stubCorpus(server, [makeProject({})]);

      const res = await callSearchProjectsJSON(server, { query: "machine learning" });

      expect(res.metadata.filters_applied).toEqual({
        query: "machine learning",
        field_of_science: null,
        resource_name: null,
        allocation_type: null,
        date_range: null,
        min_allocation: null,
      });
    });
  });

  describe("listProjectsByField", () => {
    it("discloses field_of_science with its APPLIED value — never null when set", async () => {
      const server = new AllocationsServer();
      const recs = [
        makeProject({ projectId: 1, fos: "Computer Science" }),
        makeProject({ projectId: 2, fos: "Physics" }),
      ];
      stubCorpus(server, recs);

      const res = await callSearchProjectsJSON(server, { field_of_science: "Computer Science" });

      expect(res.metadata.filters_applied.field_of_science).toBe("Computer Science");
      expect(res.metadata.filters_applied.field_of_science).not.toBeNull();
      expect(res.items.map((p: { projectId: number }) => p.projectId)).toEqual([1]);
    });

    it("keys this branch never applies (query, resource_name, allocation_type) are null", async () => {
      const server = new AllocationsServer();
      stubCorpus(server, [makeProject({})]);

      const res = await callSearchProjectsJSON(server, { field_of_science: "Computer Science" });

      expect(res.metadata.filters_applied).toEqual({
        query: null,
        field_of_science: "Computer Science",
        resource_name: null,
        allocation_type: null,
        date_range: null,
        min_allocation: null,
      });
    });

    it("date_range and min_allocation show their applied values and narrow results", async () => {
      const server = new AllocationsServer();
      const recs = [
        makeProject({
          projectId: 1,
          fos: "Computer Science",
          beginDate: "2024-06-01",
          endDate: "2025-06-01",
          resources: [{ resourceName: "R1", units: "ACCESS Credits", allocation: 5000, resourceId: 1 }],
        }),
        makeProject({
          projectId: 2,
          fos: "Computer Science",
          beginDate: "2020-01-01",
          endDate: "2021-01-01",
          resources: [{ resourceName: "R2", units: "ACCESS Credits", allocation: 100, resourceId: 2 }],
        }),
      ];
      stubCorpus(server, recs);

      const res = await callSearchProjectsJSON(server, {
        field_of_science: "Computer Science",
        date_range: { start_date: "2024-01-01" },
        min_allocation: 1000,
      });

      expect(res.metadata.filters_applied.date_range).toEqual({ start_date: "2024-01-01" });
      expect(res.metadata.filters_applied.min_allocation).toBe(1000);
      expect(res.items.map((p: { projectId: number }) => p.projectId)).toEqual([1]);
    });
  });

  describe("listProjectsByAllocationType", () => {
    it("discloses allocation_type with its APPLIED value — never null when set", async () => {
      const server = new AllocationsServer();
      const recs = [
        makeProject({ projectId: 1, allocationType: "Explore" }),
        makeProject({ projectId: 2, allocationType: "Discover" }),
      ];
      stubCorpus(server, recs);

      const res = await callSearchProjectsJSON(server, { allocation_type: "Explore" });

      expect(res.metadata.filters_applied.allocation_type).toBe("Explore");
      expect(res.metadata.filters_applied.allocation_type).not.toBeNull();
      expect(res.items.map((p: { projectId: number }) => p.projectId)).toEqual([1]);
    });

    it("also discloses the optional field_of_science with its applied value when both are set", async () => {
      const server = new AllocationsServer();
      const recs = [
        makeProject({ projectId: 1, allocationType: "Explore", fos: "Computer Science" }),
        makeProject({ projectId: 2, allocationType: "Explore", fos: "Physics" }),
      ];
      stubCorpus(server, recs);

      const res = await callSearchProjectsJSON(server, {
        allocation_type: "Explore",
        field_of_science: "Computer Science",
      });

      expect(res.metadata.filters_applied).toEqual({
        query: null,
        field_of_science: "Computer Science",
        resource_name: null,
        allocation_type: "Explore",
        date_range: null,
        min_allocation: null,
      });
      expect(res.items.map((p: { projectId: number }) => p.projectId)).toEqual([1]);
    });

    it("with allocation_type only, field_of_science/query/resource_name are null", async () => {
      const server = new AllocationsServer();
      stubCorpus(server, [makeProject({})]);

      const res = await callSearchProjectsJSON(server, { allocation_type: "Explore" });

      expect(res.metadata.filters_applied).toEqual({
        query: null,
        field_of_science: null,
        resource_name: null,
        allocation_type: "Explore",
        date_range: null,
        min_allocation: null,
      });
    });
  });

  describe("listProjectsByResource", () => {
    it("discloses resource_name with its APPLIED value — never null when set", async () => {
      const server = new AllocationsServer();
      const recs = [
        makeProject({ projectId: 1, resources: [{ resourceName: "NCSA Delta GPU", units: "ACCESS Credits", allocation: 5000, resourceId: 1 }] }),
        makeProject({ projectId: 2, resources: [{ resourceName: "Purdue Anvil", units: "ACCESS Credits", allocation: 5000, resourceId: 2 }] }),
      ];
      stubCorpus(server, recs);

      const res = await callSearchProjectsJSON(server, { resource_name: "NCSA Delta GPU" });

      expect(res.metadata.filters_applied.resource_name).toBe("NCSA Delta GPU");
      expect(res.metadata.filters_applied.resource_name).not.toBeNull();
      expect(res.items.map((p: { projectId: number }) => p.projectId)).toEqual([1]);
    });

    it("keys this branch never applies (query, field_of_science, allocation_type) are null", async () => {
      const server = new AllocationsServer();
      stubCorpus(server, [makeProject({})]);

      const res = await callSearchProjectsJSON(server, { resource_name: "NCSA Delta GPU" });

      expect(res.metadata.filters_applied).toEqual({
        query: null,
        field_of_science: null,
        resource_name: "NCSA Delta GPU",
        allocation_type: null,
        date_range: null,
        min_allocation: null,
      });
    });

    it("date_range and min_allocation show their applied values and narrow results", async () => {
      const server = new AllocationsServer();
      const recs = [
        makeProject({
          projectId: 1,
          resources: [{ resourceName: "NCSA Delta GPU", units: "ACCESS Credits", allocation: 5000, resourceId: 1 }],
          beginDate: "2024-06-01",
          endDate: "2025-06-01",
        }),
        makeProject({
          projectId: 2,
          resources: [{ resourceName: "NCSA Delta GPU", units: "ACCESS Credits", allocation: 100, resourceId: 2 }],
          beginDate: "2020-01-01",
          endDate: "2021-01-01",
        }),
      ];
      stubCorpus(server, recs);

      const res = await callSearchProjectsJSON(server, {
        resource_name: "NCSA Delta GPU",
        date_range: { start_date: "2024-01-01" },
        min_allocation: 1000,
      });

      expect(res.metadata.filters_applied.date_range).toEqual({ start_date: "2024-01-01" });
      expect(res.metadata.filters_applied.min_allocation).toBe(1000);
      expect(res.items.map((p: { projectId: number }) => p.projectId)).toEqual([1]);
    });

    // Regression guard: listProjectsByResource does NOT narrow by field_of_science
    // or allocation_type (it only filters on resource_name/date_range/min_allocation).
    // The router guard `if (args.resource_name && !args.query)` still routes here even
    // when the caller ALSO passed field_of_science or allocation_type (the schema
    // declares them as independent optionals, not mutually exclusive). Disclosing
    // the caller's field_of_science/allocation_type as applied on this branch would
    // be a false disclosure — a filter shown as applied that never touched the
    // result set. Both keys must be null here regardless of what the caller passed.
    it("field_of_science is null even when the caller also passes it — this branch never applies it", async () => {
      const server = new AllocationsServer();
      const recs = [
        makeProject({
          projectId: 1,
          fos: "Physics", // deliberately NOT the field_of_science passed below
          resources: [{ resourceName: "NCSA Delta GPU", units: "ACCESS Credits", allocation: 5000, resourceId: 1 }],
        }),
        makeProject({
          projectId: 2,
          fos: "Physics",
          resources: [{ resourceName: "Purdue Anvil", units: "ACCESS Credits", allocation: 5000, resourceId: 2 }],
        }),
      ];
      stubCorpus(server, recs);

      const res = await callSearchProjectsJSON(server, {
        resource_name: "NCSA Delta GPU",
        field_of_science: "Computer Science",
      });

      expect(res.metadata.filters_applied.field_of_science).toBeNull();
      expect(res.metadata.filters_applied.resource_name).toBe("NCSA Delta GPU");
      // Results narrowed by resource only — project 1 (Physics, not Computer
      // Science) is still returned, proving field_of_science was NOT applied.
      expect(res.items.map((p: { projectId: number }) => p.projectId)).toEqual([1]);
    });

    it("allocation_type is null even when the caller also passes it — this branch never applies it", async () => {
      const server = new AllocationsServer();
      const recs = [
        makeProject({
          projectId: 1,
          allocationType: "Discover", // deliberately NOT the allocation_type passed below
          resources: [{ resourceName: "NCSA Delta GPU", units: "ACCESS Credits", allocation: 5000, resourceId: 1 }],
        }),
      ];
      stubCorpus(server, recs);

      const res = await callSearchProjectsJSON(server, {
        resource_name: "NCSA Delta GPU",
        allocation_type: "Explore",
      });

      expect(res.metadata.filters_applied.allocation_type).toBeNull();
      expect(res.metadata.filters_applied.resource_name).toBe("NCSA Delta GPU");
      // Project 1 is "Discover", not "Explore" — still returned, proving
      // allocation_type was NOT applied on this branch.
      expect(res.items.map((p: { projectId: number }) => p.projectId)).toEqual([1]);
    });
  });
});

describe("search_projects filters_applied — fields projection", () => {
  it("filters_applied survives a narrowing `fields` projection", async () => {
    const server = new AllocationsServer();
    stubCorpus(server, [makeProject({})]);

    const res = await callSearchProjectsJSON(server, {
      field_of_science: "Computer Science",
      fields: ["total", "items[].requestTitle"],
    });

    expect(res.metadata.filters_applied).toEqual({
      query: null,
      field_of_science: "Computer Science",
      resource_name: null,
      allocation_type: null,
      date_range: null,
      min_allocation: null,
    });
  });
});
