import { describe, it, expect, vi } from "vitest";
import { AllocationsServer } from "../server.js";

/**
 * Task 7 (NSF match accuracy): bring the DEMOTE always-show-both display to
 * the single-project path (analyzeProjectFunding).
 *
 * Before this task, analyzeProjectFunding used a MUTUALLY-EXCLUSIVE fallback:
 * institution-confirmed awards OR ELSE (only when zero pass institution
 * validation) the full `.blob` of name-matched awards under a soft "may
 * differ / may have moved" hedge. That fallback both (a) silently DROPS
 * name-only namesakes whenever at least one confirmed award exists, and (b)
 * leaks full award identifiers (titles/award-numbers/institutions) for
 * unconfirmed namesakes when nothing is confirmed — the exact laundering
 * surface Task 5 eliminated on the bulk path.
 *
 * This test drives the REAL analyzeProjectFunding entry point end-to-end
 * (mocking only findProjectById + callRemoteServer) and asserts on the
 * RENDERED output text, per the design's test-oracle discipline. Every
 * absent-assertion is paired with a positive anchor proving the block
 * actually rendered, so an absent-assert can't pass vacuously on an
 * empty/failed render.
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
// metadata} — see packages/nsf-awards/src/server.ts. One award's worth of
// envelope; combine via combineEnvelopes when a mock needs multiple items
// visible in a single search_nsf_awards response.
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

// Merge multiple single-award envelope strings (as produced by nsfEnvelope)
// into one envelope carrying all their items — mirrors a single
// search_nsf_awards call returning several awards for one PI query.
function combineEnvelopes(...envelopes: string[]): string {
  const items = envelopes.flatMap((e) => (JSON.parse(e) as { items: unknown[] }).items);
  return JSON.stringify({ total: items.length, items, metadata: {} });
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

// pi is the queried name variation; handler decides what NSF returns for
// that variation. Returning "" is treated as unavailable (isNSFUnavailable
// fails toward unavailable on an empty/unparseable body), so tests that
// want "no match at all" for a variation should return an empty envelope
// (JSON.stringify({total:0, items:[], metadata:{}})) instead.
function mockRemote(server: AllocationsServer, handler: (pi: string) => string): void {
  vi.spyOn(
    server as unknown as {
      callRemoteServer: (s: string, t: string, a: unknown) => Promise<unknown>;
    },
    "callRemoteServer",
  ).mockImplementation(async (_serverName, _tool, args) => {
    const pi = (args as { pi?: string }).pi ?? "";
    const text = handler(pi);
    return { content: [{ text }] };
  });
}

describe("analyzeProjectFunding demote rendering — 1 confirmed + name-only present", () => {
  it("shows BOTH the confirmed primary tier and the demoted name-only secondary tier, with no leaked namesake identifiers", async () => {
    const server = new AllocationsServer();
    const project = rec("Long, Matthew", "Confirmed Project", "Example University");
    mockFindProjectById(server, project);

    // Every name-variation query returns one confirmed award (matching
    // institution) PLUS one namesake award (different institution) baked
    // into the same response text, so parseNSFResponseExact's per-response
    // parse naturally yields both an institution-validated and a
    // name-only-only award across the variation loop.
    mockRemote(server, (pi) =>
      combineEnvelopes(
        nsfEnvelope(pi, "Example University", "9998887", "Confirmed Grant Title"),
        nsfEnvelope(pi, "Totally Unrelated Institute", "5551234", "Namesake Award Title"),
      ),
    );

    const response = await analyzeProjectFunding(server, 1);
    const text = response.content[0].text;

    // Positive anchor: confirmed primary tier IS present with its identifier.
    expect(text).toContain("NSF award(s) confirmed for");
    expect(text).toContain("9998887");
    expect(text).toContain("Example University");

    // Positive anchor: the demoted secondary tier for the namesake IS present
    // (this proves always-show-both replaced the drop-the-namesakes
    // fallback — under the old mutually-exclusive fallback, confirmed>0
    // meant the name-only namesake was silently dropped entirely).
    expect(text).toContain("Treat as no confirmed NSF funding");

    // Absent assertions: the namesake's own identifiers must never render as
    // confident award data anywhere in the output.
    expect(text).not.toContain("5551234");
    expect(text).not.toContain("Namesake Award Title");
    expect(text).not.toContain("Totally Unrelated Institute");
  });
});

describe("analyzeProjectFunding demote rendering — confirmed=0, name-only <= 3", () => {
  it("degrades to the safe header and the lossy conclusion sentence, with no leaked full-blob identifiers", async () => {
    const server = new AllocationsServer();
    const project = rec("Smith, John", "Name Only Project", "Example University");
    mockFindProjectById(server, project);

    mockRemote(server, (pi) =>
      nsfEnvelope(pi, "Totally Unrelated Institute", "5551234", "Namesake Award Title"),
    );

    const response = await analyzeProjectFunding(server, 1);
    const text = response.content[0].text;

    // Positive anchors: safe header IS present, lossy conclusion IS present.
    expect(text).toContain("No confirmed NSF funding found for this PI.");
    expect(text).toContain("Treat as no confirmed NSF funding");

    // Absent assertions, now that we've proven the block rendered: the old
    // code's leaky full-blob render (award.blob for relevantAwards.slice(0,3))
    // must be gone.
    expect(text).not.toContain("5551234");
    expect(text).not.toContain("Namesake Award Title");
    expect(text).not.toContain("Totally Unrelated Institute");
  });
});

describe("analyzeProjectFunding demote rendering — name-only > suppress cap (3)", () => {
  it("collapses the secondary block to the fixed suppression string via the real capped entry point", async () => {
    const server = new AllocationsServer();
    const project = rec("Common, Name", "Common Name Project", "Example University");
    mockFindProjectById(server, project);
    // A common name so multiple distinct name-variation queries each surface
    // a namesake award at a different unrelated institution — accumulating
    // more than 3 name-only awards across the variation loop, which is
    // reachable through the real single-project path since it loops
    // multiple name variations (unlike the bulk path's single query). NSF's
    // personnel field is returned as the full canonical "First Last" name
    // regardless of which query-variation string was sent (this mirrors
    // real NSF API behavior — the response always carries the award's
    // actual PI name, not an echo of the query), so every variation's
    // response passes piNameMatches's word-boundary check against the
    // ACCESS PI's full token set.
    let counter = 0;
    mockRemote(server, () => {
      counter += 1;
      return nsfEnvelope(
        "Common Name",
        `Unrelated Institute ${counter}`,
        `100000${counter}`,
        `Suppressed Title ${counter}`,
      );
    });

    const response = await analyzeProjectFunding(server, 1);
    const text = response.content[0].text;

    // Positive anchor: the fixed suppression string IS present.
    expect(text).toContain("common name — namesake matches suppressed");

    // Absent assertions for the individual award identifiers/titles across
    // all variations that fed into the name-only tier.
    expect(text).not.toContain("1000001");
    expect(text).not.toContain("Suppressed Title 1");
    expect(text).not.toContain("Unrelated Institute 1");
  });
});
