import { describe, it, expect } from "vitest";
import { AllocationsServer } from "../server.js";

/**
 * Task 9 (NSF match accuracy), re-scoped for the JSON envelope parser.
 *
 * The original Task 9 bug was specific to the OLD line-labeled text parser:
 * `Title:` was treated as an award-boundary reset identical to `Award
 * Number:`, so a real NSF record with both lines silently dropped the award
 * number. That bug is structurally impossible now — parseNSFResponse /
 * parseNSFResponseExact parse the real nsf-awards peer's JSON envelope
 * ({total, items, metadata}) and build one award per `items[]` entry, so
 * there is no line-scanning boundary logic left to regress.
 *
 * This file now guards the equivalent real-shape behavior: a parsed award's
 * blob carries BOTH its award number and its title (no field silently
 * dropped when both are present), and multiple items in one envelope
 * produce multiple distinct awards.
 */

type ParseFn = (nsfResponse: string, expectedPI: string) => { blob: string; institution: string }[];

function getParse(server: AllocationsServer, name: "parseNSFResponse" | "parseNSFResponseExact"): ParseFn {
  return (server as unknown as Record<string, ParseFn>)[name].bind(server);
}

function envelope(
  items: Array<{ awardNumber: string; title: string; principalInvestigator: string }>,
): string {
  return JSON.stringify({
    total: items.length,
    items: items.map((item) => ({
      ...item,
      institution: "Some University",
      totalIntendedAward: "$100,000",
    })),
    metadata: {},
  });
}

describe("parseNSFResponse: a parsed award carries both its award number and its title", () => {
  it("keeps BOTH the award number and the title in the blob", () => {
    const server = new AllocationsServer();
    const parse = getParse(server, "parseNSFResponse");
    const nsfResponse = envelope([
      { awardNumber: "1234567", title: "Distinctive Grant Title", principalInvestigator: "Matthew Long" },
    ]);

    const awards = parse(nsfResponse, "Matthew Long");

    expect(awards).toHaveLength(1);
    expect(awards[0].blob).toContain("1234567");
    expect(awards[0].blob).toContain("Distinctive Grant Title");
  });

  it("a record with an award number but no title still parses (no regression)", () => {
    const server = new AllocationsServer();
    const parse = getParse(server, "parseNSFResponse");
    const nsfResponse = JSON.stringify({
      total: 1,
      items: [
        {
          awardNumber: "7654321",
          institution: "Some University",
          principalInvestigator: "Matthew Long",
          totalIntendedAward: "$100,000",
        },
      ],
      metadata: {},
    });

    const awards = parse(nsfResponse, "Matthew Long");

    expect(awards).toHaveLength(1);
    expect(awards[0].blob).toContain("7654321");
  });

  it("two items in the envelope still split into two awards", () => {
    const server = new AllocationsServer();
    const parse = getParse(server, "parseNSFResponse");
    const nsfResponse = envelope([
      { awardNumber: "1111111", title: "First Grant Title", principalInvestigator: "Matthew Long" },
      { awardNumber: "2222222", title: "Second Grant Title", principalInvestigator: "Matthew Long" },
    ]);

    const awards = parse(nsfResponse, "Matthew Long");

    expect(awards).toHaveLength(2);
    expect(awards[0].blob).toContain("1111111");
    expect(awards[1].blob).toContain("2222222");
  });
});

describe("parseNSFResponseExact: a parsed award carries both its award number and its title", () => {
  it("keeps BOTH the award number and the title in the blob", () => {
    const server = new AllocationsServer();
    const parse = getParse(server, "parseNSFResponseExact");
    const nsfResponse = envelope([
      { awardNumber: "1234567", title: "Distinctive Grant Title", principalInvestigator: "Matthew Long" },
    ]);

    const awards = parse(nsfResponse, "Matthew Long");

    expect(awards).toHaveLength(1);
    expect(awards[0].blob).toContain("1234567");
    expect(awards[0].blob).toContain("Distinctive Grant Title");
  });
});
