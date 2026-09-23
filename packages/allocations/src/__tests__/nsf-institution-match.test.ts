import { describe, it, expect } from "vitest";
import { AllocationsServer } from "../server.js";

/**
 * Task 3 (NSF match accuracy): the institution matcher is the sole
 * confident-tier discriminator — a name-only match is demoted to a lossy
 * secondary result unless institution-confirmed. The prior implementation
 * ran `.includes()` against the whole flattened award blob, which both (a)
 * had no punctuation normalization (NSF's hyphenated "University of
 * California-Berkeley" didn't match ACCESS's comma-form "University of
 * California, Berkeley") and (b) over-matched whenever a short institution
 * name is a substring of a different institution's legal name ("Purdue
 * University" ⊂ "Indiana University-Purdue University Fort Wayne"). This
 * guards the word-boundary/anchored replacement, `validateInstitutionMatch`,
 * called with the parser's now-isolated `institution` field (not the blob).
 */

type InstitutionMatcher = {
  validateInstitutionMatch: (nsfInstitution: string, accessInstitution: string) => boolean;
};

function validateInstitutionMatch(nsfInstitution: string, accessInstitution: string): boolean {
  const server = new AllocationsServer();
  return (server as unknown as InstitutionMatcher).validateInstitutionMatch.bind(server)(
    nsfInstitution,
    accessInstitution,
  );
}

describe("validateInstitutionMatch", () => {
  it("DOES match across punctuation-only differences (comma vs hyphen)", () => {
    expect(
      validateInstitutionMatch("University of California-Berkeley", "University of California, Berkeley"),
    ).toBe(true);
  });

  it("DOES match across ' at ' vs hyphen-only differences (Urbana-Champaign)", () => {
    expect(
      validateInstitutionMatch(
        "University of Illinois at Urbana-Champaign",
        "University of Illinois Urbana-Champaign",
      ),
    ).toBe(true);
  });

  it("matches on exact equality", () => {
    expect(validateInstitutionMatch("University of Texas Austin", "University of Texas Austin")).toBe(
      true,
    );
  });

  it("does NOT match a short institution name that is a substring of a different institution (Purdue)", () => {
    expect(
      validateInstitutionMatch("Indiana University-Purdue University Fort Wayne", "Purdue University"),
    ).toBe(false);
  });

  it("does NOT match a short institution name that is a substring of a different institution (Penn)", () => {
    expect(
      validateInstitutionMatch("Indiana University of Pennsylvania", "University of Pennsylvania"),
    ).toBe(false);
  });

  it("does NOT match a short institution name that is a substring of a different institution (Tennessee State)", () => {
    expect(
      validateInstitutionMatch("Middle Tennessee State University", "Tennessee State University"),
    ).toBe(false);
  });
});

describe("parseNSFResponse isolates the institution field from the blob", () => {
  it("returns an object per award with an isolated `.institution` and a full `.blob`", () => {
    const server = new AllocationsServer();
    const nsfResponse = [
      "Award Number: 1234567",
      "Principal Investigator: Matthew Long",
      "Institution: University of California-Berkeley",
      "Amount: $100,000",
    ].join("\n");

    const parse = (
      server as unknown as {
        parseNSFResponse: (
          nsfResponse: string,
          expectedPI: string,
        ) => Array<{ blob: string; institution: string }>;
      }
    ).parseNSFResponse.bind(server);

    const result = parse(nsfResponse, "Long, Matthew");
    expect(result).toHaveLength(1);
    expect(result[0].institution).toBe("University of California-Berkeley");
    expect(result[0].blob).toContain("Award Number: 1234567");
    expect(result[0].blob).toContain("Principal Investigator: Matthew Long");
    expect(result[0].blob).toContain("Institution: University of California-Berkeley");
    expect(result[0].blob).toContain("Amount: $100,000");
  });
});
