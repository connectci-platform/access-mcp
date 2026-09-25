import { describe, it, expect, vi } from "vitest";
import { AllocationsServer } from "../server.js";

/**
 * Task 6 (NSF match accuracy): service-unavailable is distinct from
 * "no match".
 *
 * Two failure modes previously collapsed silently to "unfunded":
 *  - Cause A: the NSF peer is unreachable / throws (per-project catch in
 *    crossReferenceWithNSF just console.warn'd and moved on).
 *  - Cause B: the NSF peer returns an error-shaped body ("not available" /
 *    "Error") that parseNSFResponse silently parsed to zero awards.
 *
 * Both must render the distinct "NSF lookup unavailable for N projects —
 * funding status unknown" signal instead, and must NOT emit the confirmed
 * aggregate line when unavailableCount > 0 (a mid-batch outage corrupts
 * the denominator — design decision #5/#8).
 *
 * Every "assert ABSENT" below is paired with a co-present POSITIVE anchor,
 * per the same discipline as Task 5's demote-rendering tests.
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

// Real peer shape: content[0].text is a JSON STRING of {total, items,
// metadata} — see packages/nsf-awards/src/server.ts.
function nsfEnvelope(pi: string, institution: string, awardNumber: string, title: string): string {
  return JSON.stringify({
    total: 1,
    items: [
      {
        awardNumber,
        title,
        institution,
        principalInvestigator: pi,
        totalIntendedAward: "$100,000",
      },
    ],
    metadata: {},
  });
}

// The real nsf-awards peer's typed error envelope — see errorResponse in
// packages/shared/src/base-server.ts.
const ERROR_ENVELOPE = JSON.stringify({
  status: "error",
  executed: false,
  error: { code: "error", message: "NSF service returned a 503" },
});

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

function mockSingleProject(server: AllocationsServer, project: Rec): void {
  vi.spyOn(
    server as unknown as {
      searchProjectsByPIName: (p: string, f?: string, l?: number) => Promise<Rec[]>;
    },
    "searchProjectsByPIName",
  ).mockResolvedValue([project]);
}

const UNAVAILABLE_STRING = "NSF lookup unavailable for";
const UNKNOWN_STRING = "funding status unknown";
const CONFIRMED_AGGREGATE_STRING = "projects with confirmed NSF funding";

describe("findFundedProjects service-unavailable — Cause A (peer throws)", () => {
  it("renders the unavailable signal, not an unfunded conclusion, and suppresses the confirmed aggregate", async () => {
    const server = new AllocationsServer();
    vi.spyOn(
      server as unknown as {
        callRemoteServer: (s: string, t: string, a: unknown) => Promise<unknown>;
      },
      "callRemoteServer",
    ).mockRejectedValue(new Error("ECONNREFUSED"));

    const project = rec("Long, Matthew", "Unreachable Peer Project", "Example University");
    mockSingleProject(server, project);

    const response = await findFundedProjects(server, "Long, Matthew");
    const text = response.content[0].text;

    // Positive anchors: the unavailable signal IS present.
    expect(text).toContain(UNAVAILABLE_STRING);
    expect(text).toContain(UNKNOWN_STRING);
    expect(text).toMatch(/NSF lookup unavailable for 1 projects — funding status unknown/);

    // Absent assertions, now that we've proven the signal rendered:
    // no confirmed-aggregate line, and no clean "no NSF awards found"
    // false-negative framing that would read as indistinguishable from
    // a genuine no-match.
    expect(text).not.toContain(CONFIRMED_AGGREGATE_STRING);
    expect(text).not.toContain("No NSF awards found");
  });
});

describe("findFundedProjects service-unavailable — Cause B (error-shaped body)", () => {
  it("renders the unavailable signal for the peer's real typed error envelope and does not silently zero to a clean confirmed aggregate", async () => {
    const server = new AllocationsServer();
    vi.spyOn(
      server as unknown as {
        callRemoteServer: (s: string, t: string, a: unknown) => Promise<unknown>;
      },
      "callRemoteServer",
    ).mockResolvedValue({ content: [{ text: ERROR_ENVELOPE }] });

    const project = rec("Smith, John", "Error Body Project", "Example University");
    mockSingleProject(server, project);

    const response = await findFundedProjects(server, "Smith, John");
    const text = response.content[0].text;

    expect(text).toContain(UNAVAILABLE_STRING);
    expect(text).toContain(UNKNOWN_STRING);
    expect(text).not.toContain(CONFIRMED_AGGREGATE_STRING);
    expect(text).not.toContain("No NSF awards found");
  });

  it("renders the unavailable signal for a malformed/unparseable body and does not silently zero to a clean confirmed aggregate", async () => {
    const server = new AllocationsServer();
    vi.spyOn(
      server as unknown as {
        callRemoteServer: (s: string, t: string, a: unknown) => Promise<unknown>;
      },
      "callRemoteServer",
    ).mockResolvedValue({ content: [{ text: "NSF award data not available at this time" }] });

    const project = rec("Jones, Amy", "Not Available Body Project", "Example University");
    mockSingleProject(server, project);

    const response = await findFundedProjects(server, "Jones, Amy");
    const text = response.content[0].text;

    expect(text).toContain(UNAVAILABLE_STRING);
    expect(text).toContain(UNKNOWN_STRING);
    expect(text).not.toContain(CONFIRMED_AGGREGATE_STRING);
    expect(text).not.toContain("No NSF awards found");
  });
});

describe("findFundedProjects service-unavailable — positive control (normal run)", () => {
  it("emits the confirmed aggregate and NO unavailable line when the NSF peer behaves normally", async () => {
    const server = new AllocationsServer();
    vi.spyOn(
      server as unknown as {
        callRemoteServer: (s: string, t: string, a: unknown) => Promise<unknown>;
      },
      "callRemoteServer",
    ).mockImplementation(async (_serverName, _tool, args) => {
      const pi = (args as { pi?: string }).pi ?? "";
      return {
        content: [
          { text: nsfEnvelope(pi, "Example University", "9998887", "Confirmed Grant Title") },
        ],
      };
    });

    const project = rec("Long, Matthew", "Confirmed Project", "Example University");
    mockSingleProject(server, project);

    const response = await findFundedProjects(server, "Long, Matthew");
    const text = response.content[0].text;

    // Positive anchor: the confirmed aggregate IS present.
    expect(text).toContain(CONFIRMED_AGGREGATE_STRING);
    expect(text).toMatch(/\*\*1\*\*\s+projects with confirmed NSF funding/);

    // The unavailable path must not fire spuriously on a clean run.
    expect(text).not.toContain(UNAVAILABLE_STRING);
    expect(text).not.toContain(UNKNOWN_STRING);
  });
});

describe("findFundedProjects — 'Amount not available' is a REAL award, not an error", () => {
  it("treats an award whose totalIntendedAward is the literal string 'Amount not available' as a real confirmed award, not unavailable", async () => {
    const server = new AllocationsServer();
    vi.spyOn(
      server as unknown as {
        callRemoteServer: (s: string, t: string, a: unknown) => Promise<unknown>;
      },
      "callRemoteServer",
    ).mockImplementation(async (_serverName, _tool, args) => {
      const pi = (args as { pi?: string }).pi ?? "";
      return {
        content: [
          {
            text: JSON.stringify({
              total: 1,
              items: [
                {
                  awardNumber: "4443332",
                  title: "Grant With No Public Amount",
                  institution: "Example University",
                  principalInvestigator: pi,
                  totalIntendedAward: "Amount not available",
                },
              ],
              metadata: {},
            }),
          },
        ],
      };
    });

    const project = rec("Kim, Sora", "No-Amount Confirmed Project", "Example University");
    mockSingleProject(server, project);

    const response = await findFundedProjects(server, "Kim, Sora");
    const text = response.content[0].text;

    // The award reaches the confirmed tier — it must NOT be swallowed by
    // the unavailable path just because its serialized blob happens to
    // contain the substring "not available" (error detection is structural
    // — parsed.status === "error" — never a substring scan over the blob).
    expect(text).toContain(CONFIRMED_AGGREGATE_STRING);
    expect(text).toContain("4443332");
    expect(text).not.toContain(UNAVAILABLE_STRING);
    expect(text).not.toContain(UNKNOWN_STRING);
  });
});
