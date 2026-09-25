import { describe, it, expect, vi } from "vitest";
import { AllocationsServer } from "../server.js";

/**
 * I1 (final whole-branch review, Important): analyzeProjectFunding
 * (single-project path) doesn't distinguish an NSF outage from a genuine
 * "unfunded" result. Task 6 fixed this for the bulk path
 * (crossReferenceWithNSF); this path was missed.
 *
 * The per-variation loop catches errors and swallows them, and skips
 * error-shaped bodies via an inline `!nsfResponse.includes("Error")` gate.
 * On a total NSF outage (every name variation throws OR returns an
 * error-shaped body), relevantAwards stays empty and the code rendered the
 * "No NSF awards found ... / Possible Explanations" unfunded block — a
 * false "unfunded" conclusion, exactly the no-match/unavailable conflation
 * design decision #5 forbids.
 *
 * Fix: track usableResponseCount across the variation loop (reusing
 * isNSFErrorResponse for consistency with Task 6). If EVERY variation
 * failed (usableResponseCount === 0), render the single-project unavailable
 * message instead of the unfunded block. A usable response that legitimately
 * finds nothing must still render the genuine "No NSF awards found" message
 * (proven by the positive-control test below).
 *
 * This test drives the REAL analyzeProjectFunding entry point end-to-end
 * (mocking only findProjectById + callRemoteServer), per the design's
 * test-oracle discipline, and asserts on RENDERED output text. Every
 * absent-assertion is paired with a positive anchor.
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

function rec(pi: string, requestTitle: string, piInstitution: string): Rec {
  return {
    projectId: 1,
    requestNumber: "REQ1",
    requestTitle,
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

const UNAVAILABLE_STRING = "NSF lookup unavailable";
const UNKNOWN_STRING = "funding status unknown";
const UNFUNDED_STRING = "No NSF awards found";
const POSSIBLE_EXPLANATIONS_STRING = "Possible Explanations";

describe("analyzeProjectFunding service-unavailable (I1) — every variation throws", () => {
  it("renders the unavailable/unknown-status message, not the unfunded block", async () => {
    const server = new AllocationsServer();
    vi.spyOn(
      server as unknown as {
        callRemoteServer: (s: string, t: string, a: unknown) => Promise<unknown>;
      },
      "callRemoteServer",
    ).mockRejectedValue(new Error("ECONNREFUSED"));

    const project = rec("Long, Matthew", "Unreachable Peer Project", "Example University");
    mockFindProjectById(server, project);

    const response = await analyzeProjectFunding(server, 1);
    const text = response.content[0].text;

    // Positive anchors: the unavailable/unknown-status signal IS present.
    expect(text).toContain(UNAVAILABLE_STRING);
    expect(text).toContain(UNKNOWN_STRING);

    // Absent assertions, now that we've proven the signal rendered: the
    // false-negative unfunded block must not appear.
    expect(text).not.toContain(UNFUNDED_STRING);
    expect(text).not.toContain(POSSIBLE_EXPLANATIONS_STRING);
  });
});

describe("analyzeProjectFunding service-unavailable (I1) — every variation returns an error body", () => {
  it("renders the unavailable/unknown-status message, not the unfunded block", async () => {
    const server = new AllocationsServer();
    vi.spyOn(
      server as unknown as {
        callRemoteServer: (s: string, t: string, a: unknown) => Promise<unknown>;
      },
      "callRemoteServer",
    ).mockResolvedValue({
      content: [
        {
          text: JSON.stringify({
            status: "error",
            executed: false,
            error: { code: "error", message: "NSF service returned a 503" },
          }),
        },
      ],
    });

    const project = rec("Smith, John", "Error Body Project", "Example University");
    mockFindProjectById(server, project);

    const response = await analyzeProjectFunding(server, 1);
    const text = response.content[0].text;

    expect(text).toContain(UNAVAILABLE_STRING);
    expect(text).toContain(UNKNOWN_STRING);
    expect(text).not.toContain(UNFUNDED_STRING);
    expect(text).not.toContain(POSSIBLE_EXPLANATIONS_STRING);
  });
});

describe("analyzeProjectFunding service-unavailable (I1) — positive control (genuine no-match)", () => {
  it("still renders the genuine 'No NSF awards found' block when a usable response legitimately finds nothing", async () => {
    const server = new AllocationsServer();
    vi.spyOn(
      server as unknown as {
        callRemoteServer: (s: string, t: string, a: unknown) => Promise<unknown>;
      },
      "callRemoteServer",
    ).mockResolvedValue({
      content: [{ text: JSON.stringify({ total: 0, items: [], metadata: {} }) }],
    });

    const project = rec("Nobody, Really", "Genuinely Unfunded Project", "Example University");
    mockFindProjectById(server, project);

    const response = await analyzeProjectFunding(server, 1);
    const text = response.content[0].text;

    // Positive anchor: the genuine unfunded block DOES render.
    expect(text).toContain(UNFUNDED_STRING);
    expect(text).toContain(POSSIBLE_EXPLANATIONS_STRING);

    // The unavailable path must not fire spuriously on a clean/usable
    // no-match response.
    expect(text).not.toContain(UNAVAILABLE_STRING);
    expect(text).not.toContain(UNKNOWN_STRING);
  });
});
