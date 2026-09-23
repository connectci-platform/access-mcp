import { describe, it, expect, vi } from "vitest";
import { AllocationsServer } from "../server.js";

/**
 * Task 4 (NSF match accuracy): crossReferenceWithNSF must not let a
 * name-only match starve an institution-confirmed match out of the
 * returned `limit`. Confirmed matches are the primary/authoritative tier
 * (Task 3's validateInstitutionMatch discriminates them); name-only matches
 * are a lossy secondary tier. Previously correlations filled `limit` slots
 * in PROJECT ORDER and cut with `correlations.length < limit` inside the
 * scan loop, so a name-only match appearing before a confirmed match in
 * project order could consume the only slot and the confirmed match would
 * never be seen/returned. This guards the fix: partition each correlation's
 * awards into confirmedAwards/nameOnlyAwards, rank institution-confirmed
 * correlations before name-only ones, and apply `limit` AFTER that ranking.
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

function nsfBlob(pi: string, institution: string): string {
  return [
    "Award Number: 1234567",
    `Principal Investigator: ${pi}`,
    `Institution: ${institution}`,
    "Amount: $100,000",
  ].join("\n");
}

type Correlation = {
  accessProject: Rec;
  confirmedAwards: Array<{ blob: string; institution: string }>;
  nameOnlyAwards: Array<{ blob: string; institution: string }>;
};

function crossReference(
  server: AllocationsServer,
  projects: Rec[],
  limit: number,
): Promise<Correlation[]> {
  return (
    server as unknown as {
      crossReferenceWithNSF: (projects: Rec[], limit: number) => Promise<Correlation[]>;
    }
  ).crossReferenceWithNSF(projects, limit);
}

describe("crossReferenceWithNSF tier partition", () => {
  it("partitions one project's awards into confirmedAwards (institution match) and nameOnlyAwards", async () => {
    const server = new AllocationsServer();

    vi.spyOn(
      server as unknown as {
        callRemoteServer: (s: string, t: string, a: unknown) => Promise<unknown>;
      },
      "callRemoteServer",
    ).mockImplementation(async (_serverName, _tool, args) => {
      const personnel = (args as { personnel?: string }).personnel ?? "";
      // Two awards for the same PI: one at the ACCESS institution (confirmed),
      // one at an unrelated institution (name-only).
      const text = [
        nsfBlob(personnel, "Example University"),
        nsfBlob(personnel, "Unrelated Institute of Technology"),
      ].join("\n");
      return { content: [{ text }] };
    });

    const project = rec("Long, Matthew", "Confirmed Project", "Example University");
    const results = await crossReference(server, [project], 10);

    expect(results).toHaveLength(1);
    expect(results[0].confirmedAwards).toHaveLength(1);
    expect(results[0].confirmedAwards[0].institution).toBe("Example University");
    expect(results[0].nameOnlyAwards).toHaveLength(1);
    expect(results[0].nameOnlyAwards[0].institution).toBe("Unrelated Institute of Technology");
  });
});

describe("crossReferenceWithNSF outer-limit ordering", () => {
  it("ranks an institution-confirmed match ahead of an earlier name-only match so it survives the limit cut", async () => {
    const server = new AllocationsServer();

    vi.spyOn(
      server as unknown as {
        callRemoteServer: (s: string, t: string, a: unknown) => Promise<unknown>;
      },
      "callRemoteServer",
    ).mockImplementation(async (_serverName, _tool, args) => {
      const personnel = (args as { personnel?: string }).personnel ?? "";
      if (personnel === "Alice NameOnly") {
        // Award institution does NOT match the ACCESS project's institution.
        return {
          content: [{ text: nsfBlob("Alice NameOnly", "Unrelated Institute of Technology") }],
        };
      }
      if (personnel === "Bob Confirmed") {
        // Award institution DOES match the ACCESS project's institution.
        return { content: [{ text: nsfBlob("Bob Confirmed", "Example University") }] };
      }
      return { content: [{ text: "No awards found" }] };
    });

    // Project order: name-only match FIRST, institution-confirmed match SECOND.
    const nameOnlyProject = rec("Alice NameOnly", "Name Only Project", "Example University");
    const confirmedProject = rec(
      "Bob Confirmed",
      "Confirmed Project",
      "Example University",
    );

    const results = await crossReference(server, [nameOnlyProject, confirmedProject], 1);

    // With limit=1, the institution-confirmed project must win the single
    // slot over the name-only project that appeared earlier in project order.
    expect(results).toHaveLength(1);
    expect(results[0].accessProject.requestTitle).toBe("Confirmed Project");
    expect(results[0].confirmedAwards.length).toBeGreaterThan(0);
  });
});
