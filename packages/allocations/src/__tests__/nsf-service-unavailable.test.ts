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

function nsfBlob(pi: string, institution: string, awardNumber: string, title: string): string {
  return [
    `Award Number: ${awardNumber}`,
    `Principal Investigator: ${pi}`,
    `Institution: ${institution}`,
    `Title: ${title}`,
    "Amount: $100,000",
  ].join("\n");
}

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
  it("renders the unavailable signal for an 'Error' body and does not silently zero to a clean confirmed aggregate", async () => {
    const server = new AllocationsServer();
    vi.spyOn(
      server as unknown as {
        callRemoteServer: (s: string, t: string, a: unknown) => Promise<unknown>;
      },
      "callRemoteServer",
    ).mockResolvedValue({ content: [{ text: "Error: NSF service returned a 503" }] });

    const project = rec("Smith, John", "Error Body Project", "Example University");
    mockSingleProject(server, project);

    const response = await findFundedProjects(server, "Smith, John");
    const text = response.content[0].text;

    expect(text).toContain(UNAVAILABLE_STRING);
    expect(text).toContain(UNKNOWN_STRING);
    expect(text).not.toContain(CONFIRMED_AGGREGATE_STRING);
    expect(text).not.toContain("No NSF awards found");
  });

  it("renders the unavailable signal for a 'not available' body and does not silently zero to a clean confirmed aggregate", async () => {
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
      const personnel = (args as { personnel?: string }).personnel ?? "";
      return {
        content: [
          { text: nsfBlob(personnel, "Example University", "9998887", "Confirmed Grant Title") },
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
