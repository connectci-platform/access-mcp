import { describe, it, expect, vi } from "vitest";
import { AllocationsServer } from "../server.js";

/**
 * Task 5 (NSF match accuracy): the demote-rendering laundering defense.
 *
 * findFundedProjects renders crossReferenceWithNSF's tiered result
 * (confirmedAwards / nameOnlyAwards) into the text an LLM consumer reads.
 * That consumer launders hedges ("possible match" -> "is funded"), so the
 * defense is structural, not wording: the primary (confirmed) block is the
 * only place award identifiers/institutions appear; the secondary
 * (name-only) block is deliberately lossy — a fixed conclusion sentence
 * with no titles, numbers, institutions, or counts — and collapses further
 * under a suppress cap when there are more than 3 name-only awards. The
 * confirmed=0 case (the common case) degrades the header to a safe,
 * unhedged "no confirmed funding" message. The aggregate reports the
 * confirmed count only, never a "possible" or mixed "X of Y" number.
 *
 * Every "assert ABSENT" below is paired with a co-present POSITIVE anchor
 * in the same test, per the plan-review finding: an absent-assertion on a
 * block that simply failed to render (or rendered empty) passes vacuously,
 * so we first prove the block rendered before asserting what it omits.
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

function nsfBlob(
  pi: string,
  institution: string,
  awardNumber: string,
  title: string,
): string {
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

function mockRemote(
  server: AllocationsServer,
  handler: (personnel: string) => string,
): void {
  vi.spyOn(
    server as unknown as {
      callRemoteServer: (s: string, t: string, a: unknown) => Promise<unknown>;
    },
    "callRemoteServer",
  ).mockImplementation(async (_serverName, _tool, args) => {
    const personnel = (args as { personnel?: string }).personnel ?? "";
    return { content: [{ text: handler(personnel) }] };
  });
}

describe("findFundedProjects demote rendering — confirmed present", () => {
  it("renders the primary block with the confident header and a confirmed award identifier", async () => {
    const server = new AllocationsServer();
    mockRemote(server, (personnel) =>
      nsfBlob(personnel, "Example University", "9998887", "Confirmed Grant Title"),
    );

    const project = rec("Long, Matthew", "Confirmed Project", "Example University");
    vi.spyOn(
      server as unknown as {
        searchProjectsByPIName: (p: string, f?: string, l?: number) => Promise<Rec[]>;
      },
      "searchProjectsByPIName",
    ).mockResolvedValue([project]);

    const response = await findFundedProjects(server, "Long, Matthew");
    const text = response.content[0].text;

    // Positive anchors: primary header + a confirmed award identifier.
    expect(text).toContain("NSF award(s) confirmed for");
    expect(text).toContain("Example University");
    expect(text).toContain("9998887");
  });
});

describe("findFundedProjects demote rendering — confirmed=0, name-only <= 3", () => {
  it("degrades to the safe header and the lossy conclusion sentence, with no leaked identifiers", async () => {
    const server = new AllocationsServer();
    mockRemote(server, (personnel) =>
      nsfBlob(personnel, "Totally Unrelated Institute", "5551234", "Namesake Award Title"),
    );

    const project = rec("Smith, John", "Name Only Project", "Example University");
    vi.spyOn(
      server as unknown as {
        searchProjectsByPIName: (p: string, f?: string, l?: number) => Promise<Rec[]>;
      },
      "searchProjectsByPIName",
    ).mockResolvedValue([project]);

    const response = await findFundedProjects(server, "Smith, John");
    const text = response.content[0].text;

    // Positive anchors: safe header IS present, lossy conclusion IS present.
    expect(text).toContain("No confirmed NSF funding found for this PI.");
    expect(text).toContain("Treat as no confirmed NSF funding");

    // Absent assertions, now that we've proven the block rendered:
    expect(text).not.toContain("5551234");
    expect(text).not.toContain("Namesake Award Title");
    expect(text).not.toContain("Totally Unrelated Institute");
    // No re-laundered count digit for the name-only awards (only 1 here).
    expect(text).not.toMatch(/\b1\s+possible\b/i);
    expect(text).not.toMatch(/possible/i);
  });
});

describe("findFundedProjects demote rendering — name-only > suppress cap (3)", () => {
  it("collapses the whole secondary block to the fixed suppression string", async () => {
    const server = new AllocationsServer();

    // parseNSFResponse hard-caps a single search_nsf_awards call's parsed
    // awards to 3 (see parseNSFResponse's `.slice(0, 3)`), so a single
    // crossReferenceWithNSF call can't itself produce >3 name-only awards
    // today. The suppress cap is a rendering-layer guarantee independent of
    // that upstream limit (e.g. it must still hold if the upstream cap is
    // raised or multiple sources are merged later), so this test exercises
    // the renderer via crossReferenceWithNSF directly with a correlation
    // that already has 4 name-only awards.
    const project = rec("Common, Name", "Common Name Project", "Example University");
    vi.spyOn(
      server as unknown as {
        searchProjectsByPIName: (p: string, f?: string, l?: number) => Promise<Rec[]>;
      },
      "searchProjectsByPIName",
    ).mockResolvedValue([project]);

    vi.spyOn(
      server as unknown as {
        crossReferenceWithNSF: (
          projects: Rec[],
          limit: number,
        ) => Promise<{
          correlations: Array<{
            accessProject: Rec;
            confirmedAwards: Array<{ blob: string; institution: string }>;
            nameOnlyAwards: Array<{ blob: string; institution: string }>;
          }>;
          unavailableCount: number;
        }>;
      },
      "crossReferenceWithNSF",
    ).mockResolvedValue({
      correlations: [
        {
          accessProject: project,
          confirmedAwards: [],
          nameOnlyAwards: [
            {
              blob: nsfBlob("Common, Name", "Unrelated Inst One", "1000001", "Suppressed Title One"),
              institution: "Unrelated Inst One",
            },
            {
              blob: nsfBlob("Common, Name", "Unrelated Inst Two", "1000002", "Suppressed Title Two"),
              institution: "Unrelated Inst Two",
            },
            {
              blob: nsfBlob(
                "Common, Name",
                "Unrelated Inst Three",
                "1000003",
                "Suppressed Title Three",
              ),
              institution: "Unrelated Inst Three",
            },
            {
              blob: nsfBlob(
                "Common, Name",
                "Unrelated Inst Four",
                "1000004",
                "Suppressed Title Four",
              ),
              institution: "Unrelated Inst Four",
            },
          ],
        },
      ],
      unavailableCount: 0,
    });

    const response = await findFundedProjects(server, "Common, Name");
    const text = response.content[0].text;

    // Positive anchor: the fixed suppression string IS present.
    expect(text).toContain("common name — namesake matches suppressed");

    // Absent assertions for the individual award identifiers/titles.
    expect(text).not.toContain("1000001");
    expect(text).not.toContain("Suppressed Title One");
    expect(text).not.toContain("Unrelated Inst One");
    expect(text).not.toContain("1000004");
    expect(text).not.toContain("Suppressed Title Four");
  });
});

describe("findFundedProjects demote rendering — aggregate", () => {
  it("reports the confirmed-only count, never a possible/unconfirmed count or an X-of-Y mixed line", async () => {
    const server = new AllocationsServer();
    mockRemote(server, (personnel) => {
      if (personnel === "Pi Confirmed") {
        return nsfBlob(personnel, "Example University", "7778889", "Confirmed Grant");
      }
      return nsfBlob(personnel, "Totally Unrelated Institute", "5551234", "Namesake Award Title");
    });

    const confirmedProject = rec("Confirmed, Pi", "Confirmed Project", "Example University");
    const nameOnlyProject = rec("NameOnly, Pi", "Name Only Project", "Example University");
    vi.spyOn(
      server as unknown as {
        searchProjectsByPIName: (p: string, f?: string, l?: number) => Promise<Rec[]>;
      },
      "searchProjectsByPIName",
    ).mockResolvedValue([confirmedProject, nameOnlyProject]);

    const response = await findFundedProjects(server, "Common Pi");
    const text = response.content[0].text;

    // Positive anchor: the confirmed-count aggregate IS present.
    expect(text).toContain("projects with confirmed NSF funding");
    expect(text).toMatch(/\*\*1\*\*\s+projects with confirmed NSF funding/);

    // Scope the "no possible/unconfirmed count, no bare X-of-Y" assertions
    // to the AGGREGATE section specifically (from "Correlation Insights"
    // onward). The per-project secondary block legitimately uses the word
    // "unconfirmed" in its fixed lossy sentence ("unconfirmed namesake
    // matches") — that's expected and is not the aggregate this test is
    // guarding against re-laundering a count into.
    const aggregateSection = text.slice(text.indexOf("Correlation Insights"));
    expect(aggregateSection).not.toMatch(/possible/i);
    expect(aggregateSection).not.toMatch(/unconfirmed/i);
    expect(aggregateSection).not.toMatch(/\b2\s+of\s+2\b/);
    expect(aggregateSection).not.toMatch(/\*\*2\*\*\s+of\s+2\s+ACCESS projects/);
  });
});
