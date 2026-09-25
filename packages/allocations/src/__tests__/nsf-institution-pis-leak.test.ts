import { describe, it, expect, vi } from "vitest";
import { AllocationsServer } from "../server.js";
import type { CorpusSnapshot } from "../corpus-cache.js";

/**
 * C1 (final whole-branch review, Critical): crossReferenceInstitutionPIs
 * (reached via analyze_funding with an `institution` arg ->
 * institutionalFundingProfile -> this function) was a residual laundering
 * leak the feature's earlier tasks missed. It called parseNSFResponse (the
 * UN-partitioned name-matched set — confirmed + name-only namesakes mixed)
 * and rendered the raw count as "N NSF award(s)", feeding the aggregate
 * "**N** ACCESS PIs have identifiable NSF awards" line. A bare namesake
 * count is exactly the laundering vector the design forbids (lines 33, 36,
 * 115 of the design doc): a PI with zero real NSF funding but a common name
 * (e.g. "Wei Wang") would count every namesake as "identifiable NSF
 * awards" for that ACCESS PI.
 *
 * Fix: partition by institution using the same validateInstitutionMatch
 * predicate Tasks 3/4/7 use, and count/render ONLY institution-confirmed
 * matches. This path (unlike the bulk/single-project paths) has no
 * demote-secondary contract — name-only awards simply do not appear here at
 * all, no count, no "N possible" line.
 *
 * This test drives the REAL institutionalFundingProfile entry point
 * end-to-end (mocking only ensureCorpus + callRemoteServer), per the
 * design's test-oracle discipline, and asserts on RENDERED output text.
 * Every absent-assertion is paired with a positive anchor.
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
  resources: unknown[];
};

function rec(id: number, pi: string, piInstitution: string, fos: string): Rec {
  return {
    projectId: id,
    requestNumber: `REQ${id}`,
    requestTitle: `Project ${id}`,
    pi,
    piInstitution,
    fos,
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
        coPIs: [],
        totalIntendedAward: "$100,000",
        totalAwardedToDate: "$100,000",
        startDate: "2026-01-01",
        endDate: "2027-01-01",
      },
    ],
    metadata: {},
  });
}

const NO_AWARDS_ENVELOPE = JSON.stringify({ total: 0, items: [], metadata: {} });

function server(records: Rec[], nsfHandler: (pi: string) => string): AllocationsServer {
  const s = new AllocationsServer();
  const snapshot: CorpusSnapshot<Rec> = {
    records: records as never,
    pages: 1,
    truncated: false,
    fetchedAt: Date.now(),
  };
  vi.spyOn(
    s as unknown as { ensureCorpus: () => Promise<CorpusSnapshot<Rec>> },
    "ensureCorpus",
  ).mockResolvedValue(snapshot);

  vi.spyOn(
    s as unknown as {
      callRemoteServer: (server: string, tool: string, args: unknown) => Promise<unknown>;
    },
    "callRemoteServer",
  ).mockImplementation(async (_serverName, tool, args) => {
    if (tool === "search_nsf_awards") {
      const a = args as { pi?: string; institution?: string };
      if (a.pi !== undefined) {
        return { content: [{ text: nsfHandler(a.pi) }] };
      }
      // institution-variant NSF fan-out query (institutionalFundingProfile
      // step 3) — irrelevant to this leak, return a clean empty envelope.
      return { content: [{ text: NO_AWARDS_ENVELOPE }] };
    }
    return { content: [{ text: NO_AWARDS_ENVELOPE }] };
  });
  return s;
}

async function profile(s: AllocationsServer, query: string): Promise<string> {
  const res = await (
    s as unknown as {
      institutionalFundingProfile: (
        n: string,
        l?: number,
      ) => Promise<{ content: { text: string }[] }>;
    }
  ).institutionalFundingProfile(query, 20);
  return res.content[0].text;
}

describe("crossReferenceInstitutionPIs namesake-count leak (C1)", () => {
  it("does not count or render a namesake (institution-unconfirmed) PI's award count, but DOES render a genuinely confirmed PI's confirmed count", async () => {
    const CORPUS = [
      // Namesake-only: NSF results are ALL name-only namesakes at a
      // DIFFERENT institution than project.piInstitution.
      rec(1, "Wei Wang", "Example University", "Computer Science"),
      // Genuine confirmed: NSF result institution matches piInstitution.
      rec(2, "Ada Lovelace", "Example University", "Mathematics"),
    ];

    const s = server(CORPUS, (pi) => {
      if (pi.includes("Wei Wang")) {
        return nsfEnvelope(pi, "Totally Unrelated Institute", "5551234", "Namesake Award");
      }
      if (pi.includes("Ada Lovelace")) {
        return nsfEnvelope(pi, "Example University", "9998887", "Confirmed Grant");
      }
      return NO_AWARDS_ENVELOPE;
    });

    const text = await profile(s, "Example University");

    // Positive anchor: the genuinely confirmed PI DOES render its confirmed
    // count, using "confirmed" language (not the raw un-partitioned count).
    expect(text).toContain("Ada Lovelace");
    expect(text).toContain("1 confirmed NSF award(s)");

    // Absent assertions, paired with the positive anchor above proving the
    // rendering path fired: the namesake-only PI must NOT increment
    // `matches` or render any "N NSF award(s)" count for itself.
    expect(text).not.toMatch(/Wei Wang:\*\*\s*\d+\s*(confirmed\s+)?NSF award/);
    expect(text).not.toContain("5551234");
    expect(text).not.toContain("Namesake Award");
    expect(text).not.toContain("Totally Unrelated Institute");

    // The aggregate must count only the confirmed PI (1), not both PIs, and
    // must use "confirmed" language.
    expect(text).toMatch(/\*\*1\*\*\s+ACCESS PIs have confirmed NSF awards/);
    expect(text).not.toContain("ACCESS PIs have identifiable NSF awards");
  });
});
