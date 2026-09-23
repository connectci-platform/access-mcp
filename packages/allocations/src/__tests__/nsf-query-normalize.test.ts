import { describe, it, expect, vi } from "vitest";
import { AllocationsServer } from "../server.js";

/**
 * Task 1 (NSF match accuracy): ACCESS stores `project.pi` as "Last, First"
 * (comma format). Querying NSF's `personnel` field in comma format floods
 * results with unrelated namesakes and can push the real person off the
 * result cap; clean "First Last" returns the correct person. This guards
 * the `normalizePIQuery` helper and its use at the bulk NSF query call site.
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

function rec(pi: string): Rec {
  return {
    projectId: 1,
    requestNumber: "REQ1",
    requestTitle: "Project 1",
    pi,
    piInstitution: "Example University",
    fos: "Computer Science",
    abstract: "abstract",
    allocationType: "Explore",
    beginDate: "2026-01-01",
    endDate: "2027-01-01",
    resources: [],
  };
}

describe("normalizePIQuery", () => {
  it.each([
    ["Long, Matthew", "Matthew Long"],
    ["Ganesan, Venkat", "Venkat Ganesan"],
    ["Matthew Long", "Matthew Long"], // already clean, unchanged
    ["Cher", "Cher"], // single token, unchanged
    ["Long,  Matthew ", "Matthew Long"], // extra whitespace
  ])("normalizePIQuery(%j) === %j", (input, expected) => {
    const server = new AllocationsServer();
    const normalize = (
      server as unknown as { normalizePIQuery: (pi: string) => string }
    ).normalizePIQuery.bind(server);
    expect(normalize(input)).toBe(expected);
  });
});

describe("bulk NSF query passes normalized PI name to callRemoteServer", () => {
  it("sends 'Matthew Long' (not 'Long, Matthew') as the personnel arg", async () => {
    const server = new AllocationsServer();

    const nsfCalls: Array<{ personnel?: string }> = [];
    vi.spyOn(
      server as unknown as {
        callRemoteServer: (s: string, t: string, a: unknown) => Promise<unknown>;
      },
      "callRemoteServer",
    ).mockImplementation(async (_serverName, _tool, args) => {
      nsfCalls.push(args as { personnel?: string });
      return { content: [{ text: "No awards found" }] };
    });

    const project = rec("Long, Matthew");
    await (
      server as unknown as {
        crossReferenceWithNSF: (
          projects: Rec[],
          limit: number,
        ) => Promise<unknown>;
      }
    ).crossReferenceWithNSF([project], 10);

    expect(nsfCalls.length).toBeGreaterThan(0);
    expect(nsfCalls[0].personnel).toBe("Matthew Long");
    expect(nsfCalls[0].personnel).not.toBe("Long, Matthew");
  });
});
