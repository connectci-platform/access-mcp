import { describe, it, expect, vi } from "vitest";
import { AllocationsServer } from "../server.js";

/**
 * searchProjectsByPIName previously matched the user's PI query against the
 * stored ACCESS `project.pi` ("Last, First") with a raw substring
 * `.includes()`. Two live-verified failure modes:
 *
 *   1. First/Last not normalized: a natural "Hannah Kerner" query never
 *      matches the stored "Kerner, Hannah" form (order-sensitive substring),
 *      so analyze_funding falsely reports "0 ACCESS projects" for a real,
 *      funded PI.
 *   2. Prefix bleed: a query like "Kim, Hyung" substring-matches the stored
 *      "Kim, Hyungsub", merging two different researchers (Kim, Hyung @ CMU
 *      and Kim, Hyungsub @ Indiana) into one result set.
 *
 * Fix: reuse the existing, already-reviewed token/word-boundary matcher
 * `piNameMatches` (see nsf-name-match.test.ts) instead of substring
 * `.includes()`. `piNameMatches(project.pi, piName)` — project.pi (the
 * stored ACCESS name) is the haystack whose token SET is built; piName (the
 * query) supplies the needles that must ALL be present as whole tokens,
 * order-insensitive.
 */

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
    requestTitle: "Research project",
    pi: "Doe, Jane",
    piInstitution: "Test University",
    fos: "Computer Science",
    abstract: "research",
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

function searchProjectsByPIName(
  server: AllocationsServer,
  piName: string,
  fieldOfScience?: string,
  limit?: number,
): Promise<Project[]> {
  return (
    server as unknown as {
      searchProjectsByPIName: (piName: string, fieldOfScience?: string, limit?: number) => Promise<Project[]>;
    }
  ).searchProjectsByPIName(piName, fieldOfScience, limit);
}

describe("searchProjectsByPIName — token/word-boundary match (piNameMatches reuse)", () => {
  it("matches a First-Last query against a stored Last, First project (order-insensitive)", async () => {
    const server = new AllocationsServer();
    stubCorpus(server, [makeProject({ projectId: 1, pi: "Kerner, Hannah" })]);

    const results = await searchProjectsByPIName(server, "Hannah Kerner");

    expect(results).toHaveLength(1);
    expect(results[0].projectId).toBe(1);
  });

  it("still matches a last-name-only query (partial search preserved)", async () => {
    const server = new AllocationsServer();
    stubCorpus(server, [makeProject({ projectId: 1, pi: "Kerner, Hannah" })]);

    const results = await searchProjectsByPIName(server, "Kerner");

    expect(results).toHaveLength(1);
    expect(results[0].projectId).toBe(1);
  });

  it("does NOT match a prefix-bleed namesake (Kim, Hyung vs stored Kim, Hyungsub)", async () => {
    const server = new AllocationsServer();
    stubCorpus(server, [makeProject({ projectId: 1, pi: "Kim, Hyungsub" })]);

    const results = await searchProjectsByPIName(server, "Kim, Hyung");

    expect(results).toHaveLength(0);
  });

  it("matches an exact-name query (Kim, Hyung vs stored Kim, Hyung)", async () => {
    const server = new AllocationsServer();
    stubCorpus(server, [makeProject({ projectId: 1, pi: "Kim, Hyung" })]);

    const results = await searchProjectsByPIName(server, "Kim, Hyung");

    expect(results).toHaveLength(1);
    expect(results[0].projectId).toBe(1);
  });

  it("applies fieldOfScience filter alongside the name match", async () => {
    const server = new AllocationsServer();
    stubCorpus(server, [
      makeProject({ projectId: 1, pi: "Kerner, Hannah", fos: "Computer Science" }),
      makeProject({ projectId: 2, pi: "Kerner, Hannah", fos: "Physics" }),
    ]);

    const results = await searchProjectsByPIName(server, "Hannah Kerner", "Computer Science");

    expect(results).toHaveLength(1);
    expect(results[0].projectId).toBe(1);
  });
});
