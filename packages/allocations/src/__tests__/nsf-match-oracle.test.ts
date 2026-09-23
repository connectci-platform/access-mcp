import { describe, it, expect, vi } from "vitest";
import { AllocationsServer } from "../server.js";

/**
 * Task 8 (NSF match accuracy): the capstone test oracle.
 *
 * This oracle asserts BEHAVIOR, not a precision percentage. NSF
 * name-matching has no shared identifier with the ACCESS corpus, so match
 * PRECISION is not numerically verifiable in production. These tests assert
 * the pipeline DISCRIMINATES — namesake flood is gone, institution-confirmed
 * awards reach the confident/primary tier, name-only namesakes are
 * demoted/suppressed — and that all output states render per the design's
 * Output framing. A green oracle means the structural laundering defense
 * holds, not that a measured precision threshold was met.
 *
 * This drives the REAL entry points (findFundedProjects, the bulk path, and
 * analyzeProjectFunding, the single-project path) end-to-end through the
 * REAL capped NSF call (limit:3), REAL query normalization, REAL name/
 * institution matching, REAL tier assembly, and REAL rendering. Only
 * `callRemoteServer` (the NSF peer boundary) and — where the bulk path is
 * exercised — `searchProjectsByPIName`/`findProjectById` (the ACCESS corpus
 * boundary) are mocked; every step in between is the production code path.
 * Assertions are on the RENDERED OUTPUT TEXT the LLM consumer reads, never
 * on private helper return values.
 *
 * Every "assert ABSENT" below is paired with a co-present POSITIVE anchor in
 * the same test (Task 5's discipline), so an absent-assertion can never pass
 * vacuously on a block that simply failed to render.
 *
 * The cases below are HELD OUT: fresh names/institutions not used by Tasks
 * 1-7's own unit tests (which anchor on "Matthew Long"/"Christy Long"/
 * "Matthew Longstreet" for names and "Purdue University"/"Indiana
 * University-Purdue University" for institutions). Reusing those would be
 * teaching-to-the-test — this oracle is the independent check.
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

// Real NSF response shape: "Award Number:" / "Principal Investigator:" /
// "Institution:" / "Title:" / "Amount:" lines, matching the fixture
// convention established in nsf-tier-assembly.test.ts / nsf-demote-rendering.test.ts.
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

function mockSearchProjects(server: AllocationsServer, projects: Rec[]): void {
  vi.spyOn(
    server as unknown as {
      searchProjectsByPIName: (p: string, f?: string, l?: number) => Promise<Rec[]>;
    },
    "searchProjectsByPIName",
  ).mockResolvedValue(projects);
}

function mockFindProjectById(server: AllocationsServer, project: Rec): void {
  vi.spyOn(
    server as unknown as {
      findProjectById: (id: number) => Promise<Rec | null>;
    },
    "findProjectById",
  ).mockResolvedValue(project);
}

// Records every `personnel` argument passed to callRemoteServer, so tests
// can assert the REAL capped path (limit:3) was actually exercised, not
// bypassed.
function mockRemoteByPersonnel(
  server: AllocationsServer,
  handler: (personnel: string) => string,
): { calls: Array<{ personnel: string; limit: number }> } {
  const calls: Array<{ personnel: string; limit: number }> = [];
  vi.spyOn(
    server as unknown as {
      callRemoteServer: (s: string, t: string, a: unknown) => Promise<unknown>;
    },
    "callRemoteServer",
  ).mockImplementation(async (_serverName, _tool, args) => {
    const personnel = (args as { personnel?: string }).personnel ?? "";
    const limit = (args as { limit?: number }).limit ?? 0;
    calls.push({ personnel, limit });
    return { content: [{ text: handler(personnel) }] };
  });
  return { calls };
}

describe("oracle: coexist/discriminate — confirmed award and namesake for the SAME PI name", () => {
  // NOTE on the `Title:` field: parseNSFResponse/parseNSFResponseExact treat
  // any line containing "Title:" as an award-boundary reset, identically to
  // "Award Number:" (server.ts ~2994/~2507). When a real NSF award record
  // has BOTH an "Award Number:" line and a separate "Title:" line (as real
  // NSF records do, and as this file's own established nsfBlob() fixture
  // shape produces — see nsf-demote-rendering.test.ts / nsf-service-
  // unavailable.test.ts), the "Title:" line flushes the in-progress award
  // (PI + Institution already accumulated) and starts a NEW "award" from
  // just the title line, which then never accumulates a PI/Institution/
  // Amount of its own and is dropped. Net effect: the award IS correctly
  // captured (Award Number, PI, Institution, Amount all survive and the
  // institution match still fires correctly), but the Title text itself is
  // silently absent from the rendered blob. This is a PRE-EXISTING gap in
  // Tasks 1-7's parser (not introduced here) that the existing unit tests
  // did not catch because none of them assert the title text is present in
  // rendered output. Flagged in the Task 8 report; not fixed here per this
  // task's scope (test-file only, no source changes). This oracle asserts
  // on what the pipeline actually renders (award number + institution),
  // which is what the discrimination claim depends on.
  it("promotes the institution-confirmed award to the primary block and demotes the namesake, through the real bulk path", async () => {
    const server = new AllocationsServer();

    // Held-out PI: "Nguyen, Thanh" at "University of Texas at Austin". NSF
    // returns TWO awards for the same personnel query: one confirmed (same
    // institution), one namesake (a different real institution,
    // "University of Washington" — not a superstring/substring collision,
    // a genuinely distinct researcher case).
    const { calls } = mockRemoteByPersonnel(server, (personnel) =>
      [
        nsfBlob(
          personnel,
          "University of Texas at Austin",
          "2233445",
          "Distributed Systems for Climate Modeling",
        ),
        nsfBlob(personnel, "University of Washington", "9988776", "Coral Reef Namesake Study"),
      ].join("\n"),
    );

    const project = rec("Nguyen, Thanh", "Climate Modeling at Scale", "University of Texas at Austin");
    mockSearchProjects(server, [project]);

    const response = await findFundedProjects(server, "Nguyen, Thanh");
    const text = response.content[0].text;

    // Prove the REAL capped path ran: normalized query, limit 3.
    expect(calls).toHaveLength(1);
    expect(calls[0].personnel).toBe("Thanh Nguyen");
    expect(calls[0].limit).toBe(3);

    // DISCRIMINATION, not blanket suppression: the confirmed award reaches
    // the primary block, naming the ACCESS PI and its institution, with its
    // award identifier and confirmed institution both present.
    expect(text).toContain("NSF award(s) confirmed for Nguyen, Thanh at University of Texas at Austin");
    expect(text).toContain("2233445");

    // The namesake at a different institution is demoted: its identifiers
    // are NOT rendered as confident-tier content, and the lossy secondary
    // sentence is present instead (paired positive anchor for the absence).
    expect(text).toContain(
      "These are unconfirmed namesake matches only (different institution). Treat as no confirmed NSF funding for this PI.",
    );
    expect(text).not.toContain("9988776");
    expect(text).not.toContain("Coral Reef Namesake Study");
    expect(text).not.toContain("University of Washington");

    // Aggregate reflects the confirmed count.
    expect(text).toMatch(/\*\*1\*\*\s+projects with confirmed NSF funding/);
  });

  it("shows the same discrimination through the single-project path (analyzeProjectFunding)", async () => {
    const server = new AllocationsServer();

    mockRemoteByPersonnel(server, (personnel) =>
      [
        nsfBlob(
          personnel,
          "University of Texas at Austin",
          "2233445",
          "Distributed Systems for Climate Modeling",
        ),
        nsfBlob(personnel, "University of Washington", "9988776", "Coral Reef Namesake Study"),
      ].join("\n"),
    );

    const project = rec("Nguyen, Thanh", "Climate Modeling at Scale", "University of Texas at Austin");
    mockFindProjectById(server, project);

    const response = await analyzeProjectFunding(server, 1);
    const text = response.content[0].text;

    expect(text).toContain("NSF award(s) confirmed for Nguyen, Thanh at University of Texas at Austin");
    expect(text).toContain("2233445");

    expect(text).toContain(
      "These are unconfirmed namesake matches only (different institution). Treat as no confirmed NSF funding for this PI.",
    );
    expect(text).not.toContain("9988776");
    expect(text).not.toContain("Coral Reef Namesake Study");
    expect(text).not.toContain("University of Washington");
  });
});

describe("oracle: short-institution over-match — Delaware State vs University of Delaware", () => {
  it("does NOT let a superstring-containing different institution reach the confident tier", async () => {
    const server = new AllocationsServer();

    // Held-out pair (fresh, not Purdue/Indiana from Task 3): "Delaware
    // State University" is genuinely a different institution from
    // "University of Delaware", even though "Delaware" and "University"
    // both appear in each. Distinctive-token sets: {delaware, state} vs
    // {delaware} — different sizes, so validateInstitutionMatch correctly
    // separates them (verified directly against the matcher before writing
    // this fixture).
    mockRemoteByPersonnel(server, (personnel) =>
      nsfBlob(personnel, "University of Delaware", "5566778", "Coastal Erosion Namesake Grant"),
    );

    const project = rec(
      "Okafor, Ijeoma",
      "Coastal Resilience Computation",
      "Delaware State University",
    );
    mockSearchProjects(server, [project]);

    const response = await findFundedProjects(server, "Okafor, Ijeoma");
    const text = response.content[0].text;

    // Positive anchor: the block DID render (safe header present) before
    // asserting what's absent from it.
    expect(text).toContain("No confirmed NSF funding found for this PI.");
    expect(text).toContain(
      "These are unconfirmed namesake matches only (different institution). Treat as no confirmed NSF funding for this PI.",
    );

    // The namesake must NOT reach the confident/primary tier.
    expect(text).not.toContain("NSF award(s) confirmed for");
    expect(text).not.toContain("5566778");
    expect(text).not.toContain("Coastal Erosion Namesake Grant");

    // No confirmed projects in the aggregate.
    expect(text).toMatch(/\*\*0\*\*\s+projects with confirmed NSF funding/);
  });
});

describe("oracle regression: namesake flood is gone (common-name PI, all different-institution namesakes)", () => {
  it("emits no confident/primary claim and the demoted treatment for a common held-out name", async () => {
    const server = new AllocationsServer();

    // Held-out common name distinct from the "Long"/"Wang"/"Kim" set used
    // elsewhere. All three NSF hits are namesakes at institutions unrelated
    // to the ACCESS PI's institution.
    mockRemoteByPersonnel(server, (personnel) =>
      [
        nsfBlob(personnel, "Riverbend Polytechnic Institute", "1112223", "Flood Namesake One"),
        nsfBlob(personnel, "Lakeshore State College", "1112224", "Flood Namesake Two"),
        nsfBlob(personnel, "Prairie Technical University", "1112225", "Flood Namesake Three"),
      ].join("\n"),
    );

    const project = rec("Silva, Carla", "Materials Science Computation", "Example University");
    mockSearchProjects(server, [project]);

    const response = await findFundedProjects(server, "Silva, Carla");
    const text = response.content[0].text;

    // Positive anchor: the safe/degraded header IS present (proves the
    // block rendered) before asserting what's absent.
    expect(text).toContain("No confirmed NSF funding found for this PI.");
    // 3 name-only awards is exactly at the suppress cap (> 3 suppresses),
    // so the non-suppressed lossy sentence is the expected rendering here.
    expect(text).toContain(
      "These are unconfirmed namesake matches only (different institution). Treat as no confirmed NSF funding for this PI.",
    );

    // No confident claim, and none of the namesakes' identifiers leaked.
    expect(text).not.toContain("NSF award(s) confirmed for");
    expect(text).not.toContain("1112223");
    expect(text).not.toContain("1112224");
    expect(text).not.toContain("1112225");
    expect(text).not.toContain("Riverbend Polytechnic Institute");

    expect(text).toMatch(/\*\*0\*\*\s+projects with confirmed NSF funding/);
  });
});

describe("oracle regression: word-boundary holds end-to-end (forward-substring namesake)", () => {
  it("does not match 'Chen, Wen' against NSF PI 'Wen Chenoweth'", async () => {
    const server = new AllocationsServer();

    // Held-out forward-substring pair (fresh, not Matthew Long/Longstreet):
    // "Wen" is a real token-prefix of "Chenoweth"'s surname collision risk
    // only if matching were raw substring; token/word-boundary matching
    // must reject it because "chen" is not a whole token in "wen
    // chenoweth".
    mockRemoteByPersonnel(server, (personnel) => {
      // Only respond with an award if queried with the literal namesake
      // name, to prove the real query normalization + real name-match gate
      // ran (not a hand-fed predicate).
      if (personnel === "Wen Chen") {
        return nsfBlob("Wen Chenoweth", "Some Other University", "3334445", "Unrelated Grant");
      }
      return "No awards found";
    });

    const project = rec("Chen, Wen", "Materials Informatics", "Example University");
    mockSearchProjects(server, [project]);

    const response = await findFundedProjects(server, "Chen, Wen");
    const text = response.content[0].text;

    // Positive anchor: the "no NSF awards found" clean path renders (proves
    // this ran through to a real result, not an error/empty short-circuit).
    expect(text).toContain("No NSF awards found");

    // No confident claim and no leaked namesake identifiers — the
    // word-boundary gate rejected "Wen Chenoweth" as a match for "Chen, Wen".
    expect(text).not.toContain("NSF award(s) confirmed for");
    expect(text).not.toContain("3334445");
    expect(text).not.toContain("Unrelated Grant");
  });
});

describe("oracle regression: confirmed=0 degrades to the safe message (analyzeProjectFunding)", () => {
  it("renders the safe unhedged message when zero awards are found at all", async () => {
    const server = new AllocationsServer();

    mockRemoteByPersonnel(server, () => "No awards found");

    const project = rec("Adeyemi, Bola", "Genomics Pipeline Scaling", "Example University");
    mockFindProjectById(server, project);

    const response = await analyzeProjectFunding(server, 1);
    const text = response.content[0].text;

    expect(text).toContain('No NSF awards found for PI "Adeyemi, Bola" variations.');
    expect(text).not.toContain("NSF award(s) confirmed for");
  });
});

describe("oracle regression: service-unavailable emits unavailable, not unfunded", () => {
  it("renders the unavailable signal and suppresses the confirmed aggregate when the NSF peer throws", async () => {
    const server = new AllocationsServer();
    vi.spyOn(
      server as unknown as {
        callRemoteServer: (s: string, t: string, a: unknown) => Promise<unknown>;
      },
      "callRemoteServer",
    ).mockRejectedValue(new Error("ETIMEDOUT"));

    const project = rec("Haddad, Rami", "Seismic Simulation", "Example University");
    mockSearchProjects(server, [project]);

    const response = await findFundedProjects(server, "Haddad, Rami");
    const text = response.content[0].text;

    // Positive anchor: the unavailable signal IS present.
    expect(text).toMatch(/NSF lookup unavailable for 1 projects — funding status unknown/);

    // Paired absence: no confirmed aggregate line, and no clean "no awards
    // found" framing that would read as an indistinguishable false negative.
    expect(text).not.toContain("projects with confirmed NSF funding");
    expect(text).not.toContain("No NSF awards found");
  });
});
