import { describe, it, expect } from "vitest";
import { AllocationsServer } from "../server.js";

/**
 * Task 9 (NSF match accuracy): both `parseNSFResponse` and
 * `parseNSFResponseExact` treat `Title:` as an award-boundary RESET,
 * identical to `Award Number:`. Real NSF records emit BOTH an
 * `Award Number:` line and a `Title:` line per award. When both are
 * present, the `Title:` line resets `currentAward`, discarding whatever
 * was accumulated before it (the award number) — so the rendered blob
 * silently drops either the award number or the title.
 *
 * `Award Number:` is the true award delimiter (the caller counts awards
 * via `nsfResponse.match(/Award Number:/g)`). `Title:` is a within-award
 * field like `Principal Investigator:` / `Institution:` / `Amount:` and
 * should be appended, not treated as a boundary.
 */

type ParseFn = (nsfResponse: string, expectedPI: string) => { blob: string; institution: string }[];

function getParse(server: AllocationsServer, name: "parseNSFResponse" | "parseNSFResponseExact"): ParseFn {
  return (server as unknown as Record<string, ParseFn>)[name].bind(server);
}

describe("parseNSFResponse: Award Number: is the sole boundary, Title: is appended", () => {
  it("RED: a record with both Award Number and Title keeps BOTH in the blob", () => {
    const server = new AllocationsServer();
    const parse = getParse(server, "parseNSFResponse");
    const nsfResponse = [
      "Award Number: 1234567",
      "Title: Distinctive Grant Title",
      "Principal Investigator: Matthew Long",
      "Institution: Some University",
      "Amount: $100,000",
    ].join("\n");

    const awards = parse(nsfResponse, "Matthew Long");

    expect(awards).toHaveLength(1);
    expect(awards[0].blob).toContain("1234567");
    expect(awards[0].blob).toContain("Distinctive Grant Title");
  });

  it("a record with Award Number but no Title still parses (no regression)", () => {
    const server = new AllocationsServer();
    const parse = getParse(server, "parseNSFResponse");
    const nsfResponse = [
      "Award Number: 7654321",
      "Principal Investigator: Matthew Long",
      "Institution: Some University",
      "Amount: $100,000",
    ].join("\n");

    const awards = parse(nsfResponse, "Matthew Long");

    expect(awards).toHaveLength(1);
    expect(awards[0].blob).toContain("7654321");
  });

  it("two Award Number blocks still split into two awards", () => {
    const server = new AllocationsServer();
    const parse = getParse(server, "parseNSFResponse");
    const nsfResponse = [
      "Award Number: 1111111",
      "Title: First Grant Title",
      "Principal Investigator: Matthew Long",
      "Institution: Some University",
      "Amount: $100,000",
      "Award Number: 2222222",
      "Title: Second Grant Title",
      "Principal Investigator: Matthew Long",
      "Institution: Some University",
      "Amount: $200,000",
    ].join("\n");

    const awards = parse(nsfResponse, "Matthew Long");

    expect(awards).toHaveLength(2);
    expect(awards[0].blob).toContain("1111111");
    expect(awards[1].blob).toContain("2222222");
  });
});

describe("parseNSFResponseExact: Award Number: is the sole boundary, Title: is appended", () => {
  it("RED: a record with both Award Number and Title keeps BOTH in the blob", () => {
    const server = new AllocationsServer();
    const parse = getParse(server, "parseNSFResponseExact");
    const nsfResponse = [
      "Award Number: 1234567",
      "Title: Distinctive Grant Title",
      "Principal Investigator: Matthew Long",
      "Institution: Some University",
      "Amount: $100,000",
    ].join("\n");

    const awards = parse(nsfResponse, "Matthew Long");

    expect(awards).toHaveLength(1);
    expect(awards[0].blob).toContain("1234567");
    expect(awards[0].blob).toContain("Distinctive Grant Title");
  });
});
