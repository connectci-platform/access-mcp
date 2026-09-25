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

// Real peer shape: content[0].text is a JSON STRING of {total, items,
// metadata} — see packages/nsf-awards/src/server.ts.
function nsfEnvelope(pi: string, institution: string): string {
  return JSON.stringify({
    total: 1,
    items: [
      {
        awardNumber: "1234567",
        title: "Some Grant",
        institution,
        principalInvestigator: pi,
        totalIntendedAward: "$100,000",
      },
    ],
    metadata: {},
  });
}

// Merge multiple single-award envelope strings into one envelope carrying
// all their items — mirrors a single search_nsf_awards call returning
// several awards for one PI query.
function combineEnvelopes(...envelopes: string[]): string {
  const items = envelopes.flatMap((e) => (JSON.parse(e) as { items: unknown[] }).items);
  return JSON.stringify({ total: items.length, items, metadata: {} });
}

type Correlation = {
  accessProject: Rec;
  confirmedAwards: Array<{ blob: string; institution: string }>;
  nameOnlyAwards: Array<{ blob: string; institution: string }>;
};

async function crossReference(
  server: AllocationsServer,
  projects: Rec[],
  limit: number,
): Promise<Correlation[]> {
  const { correlations } = await (
    server as unknown as {
      crossReferenceWithNSF: (
        projects: Rec[],
        limit: number,
      ) => Promise<{ correlations: Correlation[]; unavailableCount: number }>;
    }
  ).crossReferenceWithNSF(projects, limit);
  return correlations;
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
      const pi = (args as { pi?: string }).pi ?? "";
      // Two awards for the same PI: one at the ACCESS institution (confirmed),
      // one at an unrelated institution (name-only).
      const text = combineEnvelopes(
        nsfEnvelope(pi, "Example University"),
        nsfEnvelope(pi, "Unrelated Institute of Technology"),
      );
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
      const pi = (args as { pi?: string }).pi ?? "";
      if (pi === "Alice NameOnly") {
        // Award institution does NOT match the ACCESS project's institution.
        return {
          content: [{ text: nsfEnvelope("Alice NameOnly", "Unrelated Institute of Technology") }],
        };
      }
      if (pi === "Bob Confirmed") {
        // Award institution DOES match the ACCESS project's institution.
        return { content: [{ text: nsfEnvelope("Bob Confirmed", "Example University") }] };
      }
      return { content: [{ text: JSON.stringify({ total: 0, items: [], metadata: {} }) }] };
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
