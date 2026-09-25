import { describe, it, expect, vi } from "vitest";
import { AllocationsServer } from "../server.js";
import type { CorpusSnapshot } from "../corpus-cache.js";

/**
 * Same prod wedge fix as nsf-crossref-bounded.test.ts, extended to the two
 * remaining analyze_funding routes that adversarial review found still had
 * the exact serial-unbounded-30s pattern:
 *
 *  - analyzeProjectFunding (the `project_id` route): looped over up to
 *    ~20+ generatePINameVariations SERIALLY at the base 30s timeout plus a
 *    150ms delay each — a single project_id lookup for a PI with a
 *    hyphenated/middle name could wedge the server for ~10+ minutes.
 *  - institutionalFundingProfile Step 3 (the `institution` route): looped
 *    over up to 3 NSF query variants SERIALLY at the base 30s timeout (up
 *    to 90s), AND its catch only console.warn'd — a failed/timed-out
 *    variant silently left totalNSFAwards at 0, rendering the CONFIDENT
 *    false-negative "No NSF awards found where X is the primary recipient"
 *    line. That's the laundering this whole feature exists to prevent.
 *
 * Both are fixed with the same bounds as crossReferenceWithNSF: bounded
 * concurrency (Promise.all), a short per-call timeout via callRemoteServer's
 * options.timeoutMs, and honest disclosure of any failure/timeout instead
 * of a confident "unfunded"/"no awards" conclusion.
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

const NO_AWARDS_ENVELOPE = JSON.stringify({ total: 0, items: [], metadata: {} });

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

function analyzeProjectFunding(
  server: AllocationsServer,
  projectId: number,
): Promise<{ content: Array<{ type: string; text: string }> }> {
  return (
    server as unknown as {
      analyzeProjectFunding: (
        projectId: number,
      ) => Promise<{ content: Array<{ type: string; text: string }> }>;
    }
  ).analyzeProjectFunding(projectId);
}

function mockFindProjectById(server: AllocationsServer, project: Rec): void {
  vi.spyOn(
    server as unknown as {
      findProjectById: (projectId: number) => Promise<Rec | undefined>;
    },
    "findProjectById",
  ).mockResolvedValue(project);
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

function mockInstitutionCorpus(server: AllocationsServer, records: Rec[]): void {
  const snapshot: CorpusSnapshot<Rec> = {
    records: records as never,
    pages: 1,
    truncated: false,
    fetchedAt: Date.now(),
  };
  vi.spyOn(
    server as unknown as { ensureCorpus: () => Promise<CorpusSnapshot<Rec>> },
    "ensureCorpus",
  ).mockResolvedValue(snapshot);
}

// A hyphenated last name WITH a middle name maximizes generatePINameVariations'
// output (base + suffix-stripped + basic formats + hyphen-part variants +
// middle-name variants) — comfortably past 15 variations, the shape that
// wedged the server in production.
const HYPHENATED_PI = "Mary Ann Smith-Jones";

describe("analyzeProjectFunding bounded concurrency + timeout", () => {
  it("completes well within the old ~10min wedge bound when every NSF variation lookup is slow, and discloses unavailable rather than a confident no-funding conclusion", async () => {
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
    ).mockImplementation(async (_serverName, _tool, _args, options) => {
      // Simulate a hung/slow NSF peer: only resolves after the CALLER's
      // configured timeout elapses (defaulting to the real axios default
      // of 30000ms when no options are passed, matching the pre-fix
      // behavior exactly — this is what makes a RED run against the old
      // serial code actually take N*30s instead of being artificially
      // capped by the mock itself).
      const timeoutMs = options?.timeoutMs ?? 30000;
      return new Promise((_resolve, reject) => {
        setTimeout(() => reject(new Error("simulated timeout")), timeoutMs);
      });
    });

    const project = rec(1, HYPHENATED_PI, "Example University");
    mockFindProjectById(server, project);

    const start = Date.now();
    const response = await analyzeProjectFunding(server, 1);
    const elapsed = Date.now() - start;
    const text = response.content[0].text;

    // Must resolve, and well under the old up-to-~10min wedge (20+
    // variations * 30s serial + 150ms delays each). With CONCURRENCY_CAP=5,
    // PER_CALL_TIMEOUT_MS=5000, and OVERALL_BUDGET_MS=30000, this is bounded
    // to roughly one 30s deadline window, not 20 sequential 30s waits.
    expect(elapsed).toBeLessThan(35000);

    // Every variation's lookup fails (timeout), so usableResponseCount stays
    // 0 — must render the unavailable/unknown-status disclosure, never the
    // confident "no NSF awards found" unfunded block.
    expect(text).toContain("NSF lookup unavailable");
    expect(text).toContain("funding status unknown");
    expect(text).not.toContain("No NSF awards found for PI");
  }, 40000);
});

describe("analyzeProjectFunding per-variation timeout counts as unavailable", () => {
  it("a name variation whose NSF call times out does not count toward usableResponseCount", async () => {
    const server = new AllocationsServer();
    let callCount = 0;

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
    ).mockImplementation(async (_serverName, _tool, _args, options) => {
      callCount++;
      const timeoutMs = options?.timeoutMs ?? 30000;
      return new Promise((_resolve, reject) => {
        setTimeout(() => reject(new Error("ETIMEDOUT")), Math.min(timeoutMs, 50));
      });
    });

    const project = rec(1, "Solo Researcher", "Example University");
    mockFindProjectById(server, project);

    const response = await analyzeProjectFunding(server, 1);
    const text = response.content[0].text;

    expect(callCount).toBeGreaterThan(0);
    expect(text).toContain("NSF lookup unavailable");
    expect(text).not.toContain("No NSF awards found for PI");
  });
});

describe("analyzeProjectFunding backward-compat: passes a 5000ms per-call timeout", () => {
  it("passes timeoutMs explicitly for every NSF variation lookup", async () => {
    const server = new AllocationsServer();
    const timeouts: Array<number | undefined> = [];

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
    ).mockImplementation(async (_serverName, _tool, _args, options) => {
      timeouts.push(options?.timeoutMs);
      return { content: [{ text: NO_AWARDS_ENVELOPE }] };
    });

    const project = rec(1, "Solo Researcher", "Example University");
    mockFindProjectById(server, project);

    await analyzeProjectFunding(server, 1);

    expect(timeouts.length).toBeGreaterThan(0);
    for (const t of timeouts) {
      expect(t).toBe(5000);
    }
  });
});

describe("institutionalFundingProfile Step 3 bounded concurrency + honest disclosure", () => {
  it("does NOT render the confident 'No NSF awards found where X is primary' line when NSF variant lookups failed/timed out — discloses incompleteness instead", async () => {
    const server = new AllocationsServer();

    mockInstitutionCorpus(server, [rec(1, "Some PI", "Example University")]);

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
      if (a.institution !== undefined) {
        // Every NSF-variant call for the institution's NSF portfolio fails.
        throw new Error("ECONNREFUSED");
      }
      // The PI cross-reference sub-call (unrelated to this test) — clean.
      return { content: [{ text: NO_AWARDS_ENVELOPE }] };
    });

    const text = (await institutionalFundingProfile(server, "Example University", 20)).content[0]
      .text;

    // Absent assertion: the confident false-negative line must not render.
    expect(text).not.toContain('No NSF awards found where "Example University" is the primary recipient');

    // Positive anchor: the disclosure IS present instead.
    expect(text).toMatch(/unavailable/i);
  });

  it("runs the (at most 3) NSF variant lookups concurrently with a bounded per-call timeout, not serially at 30s each", async () => {
    const server = new AllocationsServer();

    mockInstitutionCorpus(server, [rec(1, "Some PI", "Example University")]);

    const institutionCallTimeouts: Array<number | undefined> = [];

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
      const a = args as { pi?: string; institution?: string };
      if (a.institution !== undefined) {
        institutionCallTimeouts.push(options?.timeoutMs);
        await new Promise((resolve) => setTimeout(resolve, 50));
        return { content: [{ text: nsfEnvelope("Some PI", "Example University", "1112223") }] };
      }
      return { content: [{ text: NO_AWARDS_ENVELOPE }] };
    });

    const start = Date.now();
    await institutionalFundingProfile(server, "Example University", 20);
    const elapsed = Date.now() - start;

    // 3 variant calls at ~50ms each: serial would be ~150ms; concurrent
    // should be close to a single ~50ms slot. Loose bound to avoid flake.
    expect(elapsed).toBeLessThan(500);

    expect(institutionCallTimeouts.length).toBeGreaterThan(0);
    for (const t of institutionCallTimeouts) {
      expect(t).toBe(5000);
    }
  });
});
