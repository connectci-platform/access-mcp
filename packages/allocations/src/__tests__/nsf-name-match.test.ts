import { describe, it, expect } from "vitest";
import { AllocationsServer } from "../server.js";

/**
 * Task 2 (NSF match accuracy): the loose relevance gate in `parseNSFResponse`
 * (`expectedParts.some(part => part.length > 2 && piInResponse.includes(part))`)
 * and the bidirectional `includes()` in `parseNSFResponseExact` both match on
 * raw substrings, not name tokens. That produces two failure modes measured
 * against the live NSF API: a forward substring flood ("Matthew Long" matches
 * "Matthew Longstreet", "Long, Matthew" matches "Christy Long") and a reverse
 * substring flood (a short/initials-only NSF PI string like "Li" matches every
 * "Wanlu Li" variation). This guards the token/word-boundary replacement,
 * `piNameMatches`.
 */

type PIMatcher = { piNameMatches: (nsfPiName: string, accessPi: string) => boolean };

function piNameMatches(nsfPiName: string, accessPi: string): boolean {
  const server = new AllocationsServer();
  return (server as unknown as PIMatcher).piNameMatches.bind(server)(nsfPiName, accessPi);
}

describe("piNameMatches", () => {
  it("does NOT match on a forward substring (Matthew Long vs Matthew Longstreet)", () => {
    expect(piNameMatches("Matthew Longstreet", "Matthew Long")).toBe(false);
  });

  it("does NOT match on a reverse substring / initials-only NSF PI (Li vs Wanlu Li)", () => {
    expect(piNameMatches("Li", "Wanlu Li")).toBe(false);
    expect(piNameMatches("W. Li", "Wanlu Li")).toBe(false);
  });

  it("DOES match an exact name", () => {
    expect(piNameMatches("Matthew Long", "Matthew Long")).toBe(true);
  });

  it("is token-order-insensitive", () => {
    expect(piNameMatches("Matthew Long", "Long, Matthew")).toBe(true);
    expect(piNameMatches("Matthew Long", "Long Matthew")).toBe(true);
  });

  it("does NOT match a namesake with a different first name (Matthew Long vs Christy Long)", () => {
    expect(piNameMatches("Christy Long", "Matthew Long")).toBe(false);
  });
});

describe("parseNSFResponse uses token/word-boundary matching, not substring", () => {
  it("rejects a namesake ('Long, Matthew' must not match 'Christy Long')", () => {
    const server = new AllocationsServer();
    const nsfResponse = [
      "Award Number: 1234567",
      "Principal Investigator: Christy Long",
      "Institution: Some University",
      "Amount: $100,000",
    ].join("\n");

    const parse = (
      server as unknown as {
        parseNSFResponse: (nsfResponse: string, expectedPI: string) => string[];
      }
    ).parseNSFResponse.bind(server);

    expect(parse(nsfResponse, "Long, Matthew")).toEqual([]);
  });

  it("rejects a forward-substring namesake ('Matthew Long' must not match 'Matthew Longstreet')", () => {
    const server = new AllocationsServer();
    const nsfResponse = [
      "Award Number: 1234567",
      "Principal Investigator: Matthew Longstreet",
      "Institution: Some University",
      "Amount: $100,000",
    ].join("\n");

    const parse = (
      server as unknown as {
        parseNSFResponse: (nsfResponse: string, expectedPI: string) => string[];
      }
    ).parseNSFResponse.bind(server);

    expect(parse(nsfResponse, "Matthew Long")).toEqual([]);
  });

  it("accepts a true match", () => {
    const server = new AllocationsServer();
    const nsfResponse = [
      "Award Number: 1234567",
      "Principal Investigator: Matthew Long",
      "Institution: Some University",
      "Amount: $100,000",
    ].join("\n");

    const parse = (
      server as unknown as {
        parseNSFResponse: (nsfResponse: string, expectedPI: string) => string[];
      }
    ).parseNSFResponse.bind(server);

    expect(parse(nsfResponse, "Long, Matthew")).toHaveLength(1);
  });
});

describe("parseNSFResponseExact uses token/word-boundary matching, not bidirectional substring", () => {
  it("rejects reverse-substring ('Li' must not match 'Wanlu Li')", () => {
    const server = new AllocationsServer();
    const nsfResponse = [
      "Award Number: 1234567",
      "Principal Investigator: Li",
      "Institution: Some University",
      "Amount: $100,000",
    ].join("\n");

    const parse = (
      server as unknown as {
        parseNSFResponseExact: (nsfResponse: string, expectedPI: string) => string[];
      }
    ).parseNSFResponseExact.bind(server);

    expect(parse(nsfResponse, "Wanlu Li")).toEqual([]);
  });

  it("rejects forward-substring ('Matthew Long' must not match 'Matthew Longstreet')", () => {
    const server = new AllocationsServer();
    const nsfResponse = [
      "Award Number: 1234567",
      "Principal Investigator: Matthew Longstreet",
      "Institution: Some University",
      "Amount: $100,000",
    ].join("\n");

    const parse = (
      server as unknown as {
        parseNSFResponseExact: (nsfResponse: string, expectedPI: string) => string[];
      }
    ).parseNSFResponseExact.bind(server);

    expect(parse(nsfResponse, "Matthew Long")).toEqual([]);
  });

  it("accepts a true match", () => {
    const server = new AllocationsServer();
    const nsfResponse = [
      "Award Number: 1234567",
      "Principal Investigator: Matthew Long",
      "Institution: Some University",
      "Amount: $100,000",
    ].join("\n");

    const parse = (
      server as unknown as {
        parseNSFResponseExact: (nsfResponse: string, expectedPI: string) => string[];
      }
    ).parseNSFResponseExact.bind(server);

    expect(parse(nsfResponse, "Long, Matthew")).toHaveLength(1);
  });
});
