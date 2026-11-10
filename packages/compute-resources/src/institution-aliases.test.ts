import { describe, it, expect, beforeEach, vi, Mock } from "vitest";
import { ComputeResourcesServer } from "./server.js";
import {
  matchesInstitution,
  normalizeInstitutionText,
  organizationAliases,
  resourceIdInstitutionLabel,
} from "./institution-aliases.js";
import {
  ciderCatalogResponse,
  ciderOrganizations,
  ciderOrganizationsResponse,
} from "./__tests__/fixtures/cider-institutions.js";

const org = (id: number) => {
  const record = ciderOrganizations.find((o) => o.organization_id === id);
  if (!record) throw new Error(`fixture has no organization ${id}`);
  return record;
};

describe("organizationAliases", () => {
  it("derives Texas A&M's short forms from its CiDeR record and the alias table", () => {
    const aliases = organizationAliases(org(467));
    expect(aliases).toContain("texas a and m university");
    expect(aliases).toContain("texas a and m u");
    expect(aliases).toContain("texas a and m");
    expect(aliases).toContain("tamu");
  });

  it("uses the record's abbreviation for the centers", () => {
    expect(organizationAliases(org(848))).toContain("psc");
    expect(organizationAliases(org(856))).toContain("sdsc");
    expect(organizationAliases(org(844))).toContain("ncsa");
    expect(organizationAliases(org(2058))).toContain("tacc");
  });

  it("gives a center its host university's names", () => {
    expect(organizationAliases(org(844))).toEqual(expect.arrayContaining(["illinois", "uiuc"]));
    expect(organizationAliases(org(2058))).toContain("ut austin");
  });

  it("drops the trailing U from a university abbreviation", () => {
    expect(organizationAliases(org(1869))).toContain("purdue");
    expect(organizationAliases(org(561))).toContain("indiana");
  });

  it("falls back to the alias table when only a name is known", () => {
    expect(
      organizationAliases({ organization_id: 467, organization_name: "Texas A&M University" })
    ).toContain("tamu");
  });
});

describe("resourceIdInstitutionLabel", () => {
  it("reads the institution label from a resource ID", () => {
    expect(resourceIdInstitutionLabel("aces.tamu.access-ci.org")).toBe("tamu");
    expect(resourceIdInstitutionLabel("anvil.purdue.access-ci.org")).toBe("purdue");
    expect(resourceIdInstitutionLabel("fabric.renci.org")).toBe("renci");
  });

  it("gives nothing for an ID without one", () => {
    expect(resourceIdInstitutionLabel("osg.access-ci.org")).toBeUndefined();
    expect(resourceIdInstitutionLabel(3)).toBeUndefined();
  });
});

describe("matchesInstitution", () => {
  const tamu = organizationAliases(org(467));

  it("matches a short form or the name, ignoring case and punctuation", () => {
    for (const term of [
      "TAMU",
      "tamu",
      "Texas A&M",
      "texas a & m",
      "Texas A and M",
      "Texas A&M University",
    ]) {
      expect(matchesInstitution(tamu, term), term).toBe(true);
    }
  });

  it("matches a whole-word part of a longer name", () => {
    expect(matchesInstitution(organizationAliases(org(848)), "Pittsburgh")).toBe(true);
  });

  it("ignores spacing differences", () => {
    const gatech = organizationAliases({
      organization_id: 560,
      organization_name: "Georgia Institute of Technology",
      organization_abbrev: "Georgia Tech",
      organization_url: "https://pace.gatech.edu",
    });
    expect(matchesInstitution(gatech, "GeorgiaTech")).toBe(true);
    expect(matchesInstitution(gatech, "gatech")).toBe(true);
  });

  it("does not match a short term inside a longer word", () => {
    expect(matchesInstitution(tamu, "am")).toBe(false);
    expect(matchesInstitution(organizationAliases(org(856)), "die")).toBe(false);
    expect(matchesInstitution(organizationAliases(org(476)), "te")).toBe(false);
  });

  it("normalizes & to and", () => {
    expect(normalizeInstitutionText("Texas A&M")).toBe("texas a and m");
  });
});

describe("search_resources by provider institution", () => {
  let server: ComputeResourcesServer;
  let get: Mock<(url: string) => Promise<{ status: number; data: unknown }>>;

  beforeEach(() => {
    server = new ComputeResourcesServer();
    get = vi.fn(async (url: string) =>
      url.includes("/organizations/")
        ? { status: 200, data: ciderOrganizationsResponse }
        : { status: 200, data: ciderCatalogResponse }
    );
    Object.defineProperty(server, "httpClient", {
      get: () => ({ get }),
      configurable: true,
    });
  });

  const search = async (args: Record<string, unknown>): Promise<string[]> => {
    const result = await server["handleToolCall"]({
      params: { name: "search_resources", arguments: args },
    });
    const data = JSON.parse(result.content[0].text);
    return data.items.map((r: { name: string }) => r.name).sort();
  };

  it("finds ACES and Launch for TAMU or Texas A&M, as query or organization", async () => {
    for (const term of ["TAMU", "Texas A&M", "texas a&m university"]) {
      expect(await search({ query: term }), term).toEqual(["ACES", "Launch"]);
      expect(await search({ organization: term }), term).toEqual(["ACES", "Launch"]);
    }
  });

  it("finds every resource of a center by its short name", async () => {
    expect(await search({ query: "SDSC" })).toEqual(["Expanse", "Voyager"]);
    expect(await search({ query: "NCSA" })).toEqual(["Delta", "DeltaAI"]);
    expect(await search({ query: "PSC" })).toEqual(["Bridges-2"]);
    expect(await search({ query: "TACC" })).toEqual(["Stampede3"]);
    expect(await search({ query: "Purdue" })).toEqual(["Anvil"]);
  });

  it("finds a center by its host university", async () => {
    expect(await search({ query: "UIUC" })).toEqual(["Delta", "DeltaAI"]);
  });

  it("combines an institution with other filters", async () => {
    expect(await search({ organization: "PSC", type: "Storage" })).toEqual(["Bridges-2"]);
    expect(await search({ organization: "TAMU", type: "Storage" })).toEqual([]);
  });

  it("still finds institutions when the organizations endpoint fails", async () => {
    get.mockImplementation(async (url: string) => {
      if (url.includes("/organizations/")) throw new Error("down");
      return {
        status: 200,
        data: { results: { ...ciderCatalogResponse.results, organizations: undefined } },
      };
    });
    expect(await search({ query: "TAMU" })).toEqual(["ACES", "Launch"]);
    expect(await search({ query: "PSC" })).toEqual(["Bridges-2"]);
  });
});
