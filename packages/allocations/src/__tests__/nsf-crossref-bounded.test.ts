import { describe, it, expect, vi } from "vitest";
import { AllocationsServer } from "../server.js";

/**
 * Prod wedge fix: crossReferenceWithNSF (findFundedProjects) and
 * crossReferenceInstitutionPIs (institutionalFundingProfile) used to await
 * each project's NSF lookup SERIALLY at the base 30s axios timeout. A PI
 * with ~20 candidate projects to cross-reference could cost up to ~10
 * minutes of wall-clock, all blocking the single-threaded MCP server —
 * every other in-flight request (get_my_rp_accounts, get_allocation_statistics,
 * etc.) then also timed out.
 *
 * The fix is three coordinated bounds applied to both cross-ref paths:
 *  - bounded concurrency (batched Promise.all, CONCURRENCY_CAP=5 in flight)
 *    instead of one-at-a-time
 *  - a short PER_CALL_TIMEOUT_MS=5000 per NSF lookup, passed via
 *    callRemoteServer's new optional `options.timeoutMs`
 *  - an overall OVERALL_BUDGET_MS=30000 wall-clock deadline on the bulk
 *    crossReferenceWithNSF path (crossReferenceInstitutionPIs doesn't need
 *    one — it's already capped at 10 projects, 2 batches at the cap)
 *
 * A timed-out or failed per-call lookup counts as "unavailable" (funding
 * status unknown), never silently as "no funding". A deadline cutoff is
 * disclosed as "cross-reference incomplete", also never as "no funding".
 */

type Rec = {
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
  resources: { resourceName: string; units: null; allocation: null; resourceId: number }[];
};

function rec(id: number, pi: string, piInstitution: string): Rec {
  return {
    projectId: id,
    requestNumber: `REQ${id}`,
    requestTitle: `Project ${id}`,
    pi,
    piInstitution,
    fos: "Computer Science",
    abstract: "abstract",
    allocationType: "Explore",
    beginDate: "2026-01-01",
    endDate: "2027-01-01",
    resources: [],
  };
}

function nsfEnvelope(pi: string, institution: string, awardNumber: string): string {
  return JSON.stringify({
    total: 1,
    items: [
      {
        awardNumber,
        title: "Some Grant",
        institution,
        principalInvestigator: pi,
        totalIntendedAward: "$100,000",
      },
    ],
    metadata: {},
  });
}

const NO_AWARDS_ENVELOPE = JSON.stringify({ total: 0, items: [], metadata: {} });

function findFundedProjects(
  server: AllocationsServer,
  piName?: string,
  fieldOfScience?: string,
  limit?: number,
): Promise<{ content: Array<{ type: string; text: string }> }> {
  return (
    server as unknown as {
      findFundedProjects: (
        piName?: string,
        fieldOfScience?: string,
        limit?: number,
      ) => Promise<{ content: Array<{ type: string; text: string }> }>;
    }
  ).findFundedProjects(piName, fieldOfScience, limit);
}

function mockProjects(server: AllocationsServer, projects: Rec[]): void {
  vi.spyOn(
    server as unknown as {
      searchProjectsByPIName: (p: string, f?: string, l?: number) => Promise<Rec[]>;
    },
    "searchProjectsByPIName",
  ).mockResolvedValue(projects);
}

function institutionalFundingProfile(
  server: AllocationsServer,
  institutionName: string,
  limit?: number,
): Promise<{ content: Array<{ type: string; text: string }> }> {
  return (
    server as unknown as {
      institutionalFundingProfile: (
        n: string,
        l?: number,
      ) => Promise<{ content: Array<{ type: string; text: string }> }>;
    }
  ).institutionalFundingProfile(institutionName, limit);
}

describe("crossReferenceWithNSF bounded concurrency", () => {
  it("completes and returns confirmed correlations without calling NSF purely serially", async () => {
    const server = new AllocationsServer();
    const callTimestamps: number[] = [];

    vi.spyOn(
      server as unknown as {
        callRemoteServer: (
          s: string,
          t: string,
          a: unknown,
          o?: { timeoutMs?: number },
        ) => Promise<unknown>;
      },
      "callRemoteServer",
    ).mockImplementation(async (_serverName, _tool, args) => {
      callTimestamps.push(Date.now());
      await new Promise((resolve) => setTimeout(resolve, 50));
      const pi = (args as { pi?: string }).pi ?? "";
      // Give a few PIs confirmed awards; the rest get none.
      if (pi.includes("Funded")) {
        return { content: [{ text: nsfEnvelope(pi, "Example University", "1112223") }] };
      }
      return { content: [{ text: NO_AWARDS_ENVELOPE }] };
    });

    // 12 ACCESS projects — well past the old batchSize of 5, well within
    // the CONCURRENCY_CAP=5 bounded-pool behavior.
    const projects: Rec[] = [];
    for (let i = 0; i < 12; i++) {
      const pi = i < 3 ? `Funded, PI${i}` : `Unfunded, PI${i}`;
      projects.push(rec(i, pi, "Example University"));
    }
    mockProjects(server, projects);

    const start = Date.now();
    const response = await findFundedProjects(server, "Researcher", undefined, 20);
    const elapsed = Date.now() - start;
    const text = response.content[0].text;

    // Serial would be ~12 * 50ms = 600ms; concurrency-5 batches (3 batches
    // of ~50ms each) should be well under half that. Loose bound to avoid
    // flakiness across CI machines.
    expect(elapsed).toBeLessThan(400);

    expect(text).toContain("Cross-Referenced Funded Projects");
    // Tightened per review: bare "3" is near-vacuous (matches dates/resource
    // counts too) — assert the actual confirmed-count phrasing instead.
    expect(text).toMatch(/\*\*3\*\*\s+projects with confirmed NSF funding/);
  });
});

describe("crossReferenceWithNSF overall deadline", () => {
  it(
    "returns well within the old 180s wedge bound when every call is slow, and discloses incompleteness rather than claiming no funding",
    async () => {
    const server = new AllocationsServer();

    vi.spyOn(
      server as unknown as {
        callRemoteServer: (
          s: string,
          t: string,
          a: unknown,
          o?: { timeoutMs?: number },
        ) => Promise<unknown>;
      },
      "callRemoteServer",
    ).mockImplementation(async (_serverName, _tool, args, options) => {
      // Simulate a hung/slow NSF peer: the call only ever resolves after
      // the timeout the CALLER configured elapses (defaulting to the real
      // axios default of 30000ms when no options are passed — exactly what
      // the pre-fix code path does). This is what makes the RED run against
      // the old serial code actually take ~20*30s instead of being
      // artificially capped by the mock itself.
      const timeoutMs = options?.timeoutMs ?? 30000;
      return new Promise((_resolve, reject) => {
        setTimeout(() => reject(new Error("simulated timeout")), timeoutMs);
      });
    });

    // 20 candidate projects (limit*2 at default limit 10) — the shape that
    // wedged the server in production.
    const projects: Rec[] = [];
    for (let i = 0; i < 20; i++) {
      projects.push(rec(i, `Slow, PI${i}`, "Example University"));
    }
    mockProjects(server, projects);

    const start = Date.now();
    const response = await findFundedProjects(server, "Slow", undefined, 10);
    const elapsed = Date.now() - start;
    const text = response.content[0].text;

    // Must resolve, and well under the old up-to-180s+ (up to ~10min) wedge.
    // With 20 projects at CONCURRENCY_CAP=5 (4 batches) and every call
    // taking the full PER_CALL_TIMEOUT_MS=5000, worst case is ~20s of
    // batch time, itself bounded by the OVERALL_BUDGET_MS=30000 deadline —
    // either way, nowhere near the old serial ~10min.
    expect(elapsed).toBeLessThan(35000);

    // Every project's lookup fails (timeout), so all become "unavailable"
    // or "incomplete" (if the deadline cut the scan short first). The
    // output must disclose this, not render a clean "no funding"
    // conclusion for projects that were never successfully checked.
    expect(text).toMatch(/unavailable|unknown|incomplete/i);
    expect(text).not.toContain("✅ **No NSF awards found**");
    },
    40000,
  );
});

describe("crossReferenceWithNSF per-call timeout counts as unavailable", () => {
  it("a project whose NSF call times out is counted in unavailableCount, disclosed, and not rendered as no funding", async () => {
    const server = new AllocationsServer();

    vi.spyOn(
      server as unknown as {
        callRemoteServer: (
          s: string,
          t: string,
          a: unknown,
          o?: { timeoutMs?: number },
        ) => Promise<unknown>;
      },
      "callRemoteServer",
    ).mockImplementation(async (_serverName, _tool, args, options) => {
      const pi = (args as { pi?: string }).pi ?? "";
      if (pi.includes("Hung")) {
        // Never resolves within the per-call timeout — simulate the real
        // axios timeout firing by rejecting after timeoutMs.
        const timeoutMs = options?.timeoutMs ?? 30000;
        return new Promise((_resolve, reject) => {
          setTimeout(() => reject(new Error("ETIMEDOUT")), Math.min(timeoutMs, 100));
        });
      }
      return { content: [{ text: NO_AWARDS_ENVELOPE }] };
    });

    const projects = [rec(1, "Hung, PI", "Example University")];
    mockProjects(server, projects);

    const response = await findFundedProjects(server, "Hung", undefined, 10);
    const text = response.content[0].text;

    expect(text).toContain("NSF lookup unavailable for 1 projects — funding status unknown");
    expect(text).not.toContain("No NSF awards found");
  });
});

describe("crossReferenceWithNSF backward-compat: callRemoteServer without options still works", () => {
  it("passes timeoutMs explicitly as the 4th argument for NSF lookups", async () => {
    const server = new AllocationsServer();
    const calls: Array<{ args: unknown; options: unknown }> = [];

    vi.spyOn(
      server as unknown as {
        callRemoteServer: (
          s: string,
          t: string,
          a: unknown,
          o?: { timeoutMs?: number },
        ) => Promise<unknown>;
      },
      "callRemoteServer",
    ).mockImplementation(async (_serverName, _tool, args, options) => {
      calls.push({ args, options });
      return { content: [{ text: NO_AWARDS_ENVELOPE }] };
    });

    mockProjects(server, [rec(1, "Solo, PI", "Example University")]);
    await findFundedProjects(server, "Solo", undefined, 10);

    expect(calls).toHaveLength(1);
    expect(calls[0].options).toEqual({ timeoutMs: 5000 });
  });
});

describe("crossReferenceInstitutionPIs bounded concurrency + timeout + disclosure", () => {
  it("does not render a confident 'no direct PI matches' conclusion when lookups were unavailable", async () => {
    const server = new AllocationsServer();

    vi.spyOn(
      server as unknown as {
        ensureCorpus: () => Promise<{
          records: Rec[];
          pages: number;
          truncated: boolean;
          fetchedAt: number;
        }>;
      },
      "ensureCorpus",
    ).mockResolvedValue({
      records: [rec(1, "Flaky, PI", "Example University")],
      pages: 1,
      truncated: false,
      fetchedAt: Date.now(),
    });

    vi.spyOn(
      server as unknown as {
        callRemoteServer: (
          s: string,
          t: string,
          a: unknown,
          o?: { timeoutMs?: number },
        ) => Promise<unknown>;
      },
      "callRemoteServer",
    ).mockImplementation(async (_serverName, _tool, args) => {
      const a = args as { pi?: string; institution?: string };
      if (a.pi !== undefined) {
        throw new Error("ECONNREFUSED");
      }
      return { content: [{ text: NO_AWARDS_ENVELOPE }] };
    });

    const text = (await institutionalFundingProfile(server, "Example University", 20)).content[0]
      .text;

    expect(text).toContain("NSF lookup unavailable");
    expect(text).not.toContain("No direct PI matches found between ACCESS and NSF databases");
  });

  it("passes a 5000ms per-call timeout for the institution PI cross-reference", async () => {
    const server = new AllocationsServer();
    const timeouts: Array<number | undefined> = [];

    vi.spyOn(
      server as unknown as {
        ensureCorpus: () => Promise<{
          records: Rec[];
          pages: number;
          truncated: boolean;
          fetchedAt: number;
        }>;
      },
      "ensureCorpus",
    ).mockResolvedValue({
      records: [rec(1, "Timed, PI", "Example University")],
      pages: 1,
      truncated: false,
      fetchedAt: Date.now(),
    });

    vi.spyOn(
      server as unknown as {
        callRemoteServer: (
          s: string,
          t: string,
          a: unknown,
          o?: { timeoutMs?: number },
        ) => Promise<unknown>;
      },
      "callRemoteServer",
    ).mockImplementation(async (_serverName, _tool, args, options) => {
      const a = args as { pi?: string };
      if (a.pi !== undefined) {
        timeouts.push(options?.timeoutMs);
      }
      return { content: [{ text: NO_AWARDS_ENVELOPE }] };
    });

    await institutionalFundingProfile(server, "Example University", 20);

    expect(timeouts).toEqual([5000]);
  });
});
