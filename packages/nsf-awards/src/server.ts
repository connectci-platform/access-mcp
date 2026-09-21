#!/usr/bin/env node

import {
  BaseAccessServer,
  projectFields,
  buildPagination,
  coerceOffset,
  MAX_LIMIT,
  fetchAllPages,
  Tool,
  Resource,
  CallToolResult,
} from "@access-mcp/shared";
import { createRequire } from "module";
const require = createRequire(import.meta.url);
const { version } = require("../package.json");

// The NSF API's totalCount saturates at exactly this value for large/loose
// queries — a display ceiling, not a real count. At that value it's a lower
// bound, not an exact total (see applySaturatedLowerBound below).
const NSF_TOTAL_COUNT_CEILING = 10000;

/**
 * Resolve the NSF `rpp` (rows-per-page) request size from the tool's
 * requested limit, clamped only by MAX_LIMIT — independent of totalCount, so
 * it can be computed before the fetch that will reveal totalCount.
 * buildPagination (called by the caller, after the fetch) is the source of
 * truth for the final `capped` pagination metadata; this only sizes the
 * upstream request.
 */
function resolveRpp(requestedLimit: number | undefined): number {
  const truncated = requestedLimit !== undefined ? Math.trunc(requestedLimit) : NaN;
  const asked = Number.isFinite(truncated) && truncated >= 1 ? truncated : 10;
  return Math.min(asked, MAX_LIMIT);
}

/**
 * buildPagination emits `total` (and computes has_more from it), which is
 * correct only for a real total. When the NSF API's totalCount has saturated
 * at its display ceiling, mutate the pagination object in place: drop the
 * (misleading) `total`, set `total_lower_bound`, and force `has_more` true —
 * there are at least this many, and we're nowhere near exhausting a
 * ceiling-saturated set within MAX_LIMIT.
 */
function applySaturatedLowerBound(
  pagination: { total?: number; total_lower_bound?: number; has_more: boolean },
  totalCount: number
): void {
  if (totalCount === NSF_TOTAL_COUNT_CEILING) {
    delete pagination.total;
    pagination.total_lower_bound = NSF_TOTAL_COUNT_CEILING;
    pagination.has_more = true;
  }
}

interface SearchNSFAwardsArgs {
  id?: string;
  query?: string;
  pi?: string;
  institution?: string;
  primary_only?: boolean;
  limit?: number;
  offset?: number;
  fields?: string[];
}

interface FiltersApplied {
  query: string | null;
  pi: string | null;
  institution: string | null;
  primary_only: boolean | null;
}

/**
 * Build the `filters_applied` disclosure object from an explicit per-branch
 * allowlist — NOT the router's raw args wholesale. The router's four
 * narrowing params (query/pi/institution/primary_only) are independent
 * optionals with no mutual exclusion in the schema, so a caller can pass
 * e.g. `{ pi, institution }` together; the router still dispatches to a
 * single branch (pi is checked first) that applies only ITS param. Building
 * from raw args would falsely disclose the sibling param as applied even
 * though that branch never read it. Each call site below passes only the
 * args its branch actually consults; every key not passed defaults to
 * `null` here, so the object still always carries the full four-key shape
 * (Phase 4b design §2/§3) — just with the unapplied siblings correctly
 * null instead of falsely populated. Mirrors allocations' per-branch
 * `buildFiltersApplied` allowlist fix (search_projects, same false-
 * disclosure class).
 */
function buildFiltersApplied(args: SearchNSFAwardsArgs): FiltersApplied {
  return {
    query: args.query ?? null,
    pi: args.pi ?? null,
    institution: args.institution ?? null,
    primary_only: args.primary_only ?? null,
  };
}

// Raw NSF API award response structure
interface RawNSFAward {
  id?: string;
  title?: string;
  abstractText?: string;
  piFirstName?: string;
  piLastName?: string;
  coPDPI?: string;
  poName?: string;
  awardeeName?: string;
  awardeeCity?: string;
  awardeeStateCode?: string;
  fundsObligatedAmt?: string;
  estimatedTotalAmt?: string;
  startDate?: string;
  expDate?: string;
  primaryProgram?: string;
  ueiNumber?: string;
  fundProgramName?: string;
}

interface NSFAward {
  awardNumber: string;
  title: string;
  institution: string;
  principalInvestigator: string;
  coPIs: string[];
  totalIntendedAward: string;
  totalAwardedToDate: string;
  startDate: string;
  endDate: string;
  abstract: string;
  primaryProgram: string;
  programOfficer: string;
  ueiNumber: string;
}

export class NSFAwardsServer extends BaseAccessServer {
  constructor() {
    super("access-mcp-nsf-awards", version, "https://api.nsf.gov");
  }

  protected getTools(): Tool[] {
    return [
      {
        name: "search_nsf_awards",
        description: "Search NSF awards and funding. Returns {total, items}.",
        inputSchema: {
          type: "object",
          properties: {
            id: {
              type: "string",
              description: "Award number (e.g., '2138259')",
            },
            query: {
              type: "string",
              description: "Search keywords in titles/abstracts",
            },
            pi: {
              type: "string",
              description: "Principal investigator name",
            },
            institution: {
              type: "string",
              description: "Institution name",
            },
            primary_only: {
              type: "boolean",
              description:
                "When searching by institution, only return awards where the institution is the PRIMARY recipient (excludes collaborative/co-PI awards from other institutions). Default: false",
              default: false,
            },
            limit: {
              type: "number",
              description: "Max results (default: 10)",
              default: 10,
            },
            offset: {
              type: "number",
              description: "Number of results to skip, for paging past the first `limit`. Default 0.",
              default: 0,
            },
            fields: {
              type: "array",
              items: { type: "string" },
              description:
                "Project the response down to only these fields. Dotted path syntax: 'total', 'items[].title', 'items[].principalInvestigator', 'metadata.pagination.has_more', etc. Use to reduce payload size when you only need specific fields. Omit to receive the full response. Only applies to listing results, not single-award lookups.",
            },
          },
        },
        _meta: {
          supportsFieldProjection: true,
        },
      },
    ];
  }

  protected getResources(): Resource[] {
    return [];
  }

  protected async handleToolCall(request: {
    method: "tools/call";
    params: { name: string; arguments?: Record<string, unknown> };
  }): Promise<CallToolResult> {
    const { name, arguments: args = {} } = request.params;
    const typedArgs = args as SearchNSFAwardsArgs;

    try {
      switch (name) {
        case "search_nsf_awards":
          return await this.searchNSFAwardsRouter(typedArgs);
        default:
          return this.errorResponse(`Unknown tool: ${name}`);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return this.errorResponse(message);
    }
  }

  protected async handleResourceRead(): Promise<never> {
    throw new Error("Resource reading not supported");
  }

  private async searchNSFAwardsRouter(args: SearchNSFAwardsArgs): Promise<CallToolResult> {
    if (args.id) {
      // Lookup — not enveloped for projection
      return await this.get_nsf_award({ award_number: args.id });
    }

    // filters_applied is built PER BRANCH below, from an explicit allowlist
    // of only the args that branch actually applies — NOT from the raw
    // `args` wholesale (see buildFiltersApplied's doc comment for why: the
    // three routing params aren't mutually exclusive in the schema, so a
    // caller can pass e.g. `{ pi, institution }` together and only one
    // branch runs).

    if (args.pi) {
      // pi branch applies pi ONLY (find_nsf_awards_by_pi never reads
      // institution/query/primary_only) — disclose pi alone.
      return await this.find_nsf_awards_by_pi({
        pi_name: args.pi,
        limit: args.limit,
        offset: args.offset,
        fields: args.fields,
        filtersApplied: buildFiltersApplied({ pi: args.pi }),
      });
    }

    if (args.institution) {
      // institution branch applies institution + primary_only (the only
      // branch that reads primary_only at all) — disclose both.
      const primaryOnly = args.primary_only || false;
      return await this.find_nsf_awards_by_institution({
        institution_name: args.institution,
        limit: args.limit,
        offset: args.offset,
        primary_only: primaryOnly,
        fields: args.fields,
        filtersApplied: buildFiltersApplied({
          institution: args.institution,
          primary_only: primaryOnly,
        }),
      });
    }

    if (args.query) {
      // keywords branch applies query ONLY (find_nsf_awards_by_keywords
      // never reads pi/institution/primary_only) — disclose query alone.
      return await this.find_nsf_awards_by_keywords({
        keywords: args.query,
        limit: args.limit,
        offset: args.offset,
        fields: args.fields,
        filtersApplied: buildFiltersApplied({ query: args.query }),
      });
    }

    return this.errorResponse("Provide id, query, pi, or institution");
  }

  private async find_nsf_awards_by_pi(args: {
    pi_name: string;
    limit?: number;
    offset?: number;
    fields?: string[];
    filtersApplied: FiltersApplied;
  }) {
    // Coerce offset via the shared helper BEFORE the fetch, so the NSF request
    // and the reported metadata use the identical value. Doing this after the
    // fetch let a negative offset reach the NSF URL unclamped (nsfOffset=-2)
    // while buildPagination reported offset:0 — a silent-wrong-fetch bug.
    const offset = coerceOffset(args.offset);
    const nsfOffset = offset + 1;
    // rpp is resolved from the MAX_LIMIT ceiling alone (totalCount doesn't
    // affect it), so we can fetch once at that rpp and hand the returned
    // totalCount to buildPagination for the authoritative pagination object.
    const rpp = resolveRpp(args.limit);
    const { awards, totalCount } = await this.searchNSFAwardsByPI(args.pi_name, rpp, nsfOffset);

    // buildPagination must run here (the caller), not inside searchNSFAwardsByPI —
    // that method's try/catch swallows thrown errors and returns an empty result,
    // which would eat buildPagination's "limit must be at least 1" throw instead
    // of letting it propagate to handleToolCall's error envelope.
    const pagination = buildPagination({
      requestedLimit: args.limit,
      offset,
      total: totalCount,
      defaultLimit: 10,
    });
    applySaturatedLowerBound(pagination, totalCount);

    const envelope = {
      total: totalCount,
      // Defensive: the upstream API is trusted to honor rpp, but slice to
      // pagination.limit so an over-returning response can't leak extra rows.
      items: awards.slice(0, pagination.limit),
      metadata: { pagination, filters_applied: args.filtersApplied },
    };
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(projectFields(envelope, args.fields)),
        },
      ],
    };
  }

  private async get_nsf_award(args: { award_number: string }) {
    const award = await this.fetchNSFAwardData(args.award_number);
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({ total: 1, items: [award] }),
        },
      ],
    };
  }

  private async find_nsf_awards_by_institution(args: {
    institution_name: string;
    limit?: number;
    offset?: number;
    primary_only?: boolean;
    fields?: string[];
    filtersApplied: FiltersApplied;
  }) {
    // Coerce offset via the shared helper BEFORE the fetch — see the comment in
    // find_nsf_awards_by_pi for why (silent-wrong-fetch otherwise).
    const offset = coerceOffset(args.offset);

    if (args.primary_only) {
      return this.findNSFAwardsByInstitutionPrimaryOnly(args, offset);
    }

    const nsfOffset = offset + 1;
    const rpp = resolveRpp(args.limit);
    const { awards: fetched, totalCount } = await this.searchNSFAwardsByInstitution(
      args.institution_name,
      rpp,
      nsfOffset
    );

    // buildPagination must run here (the caller), not inside
    // searchNSFAwardsByInstitution — that method's try/catch swallows thrown
    // errors and returns an empty result, which would eat buildPagination's
    // "limit must be at least 1" throw instead of letting it propagate to
    // handleToolCall's error envelope.
    const pagination = buildPagination({
      requestedLimit: args.limit,
      offset,
      total: totalCount,
      defaultLimit: 10,
    });
    applySaturatedLowerBound(pagination, totalCount);

    // Defensive: the upstream API is trusted to honor rpp, but slice to
    // pagination.limit so an over-returning response can't leak extra rows.
    const awards = fetched.slice(0, pagination.limit);

    const envelope = {
      total: totalCount,
      items: awards,
      metadata: { pagination, filters_applied: args.filtersApplied },
    };

    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(projectFields(envelope, args.fields)),
        },
      ],
    };
  }

  /**
   * primary_only must filter over the COMPLETE institution result set before
   * paginating, not just the caller's page: a primary-recipient award ranked
   * past a single fetch window would otherwise be sliced away before the
   * filter ever sees it (the filter-after-slice bug). fetchAllPages walks the
   * upstream to true completion at a fixed rpp so the filter runs over
   * everything, then the caller's offset/limit window is applied to the
   * filtered set.
   */
  private async findNSFAwardsByInstitutionPrimaryOnly(
    args: {
      institution_name: string;
      limit?: number;
      fields?: string[];
      filtersApplied: FiltersApplied;
    },
    offset: number
  ) {
    const fetchRpp = 500;
    const normalizedInstitution = this.normalizeInstitutionName(args.institution_name);

    // Captured from page 1's metadata.totalCount so the primary_only path can
    // apply the same saturation check as the single-fetch branches.
    // fetchAllPages returns only {records, pages, truncated} — pages is
    // Math.min(totalCount, CEILING)/fetchRpp rounded up, which loses the raw
    // totalCount needed to detect ceiling saturation, so it's captured here
    // instead of derived from the result.
    let fetchedTotalCount = 0;

    const result = await fetchAllPages<NSFAward>(
      async (page) => {
        const nsfOffset = (page - 1) * fetchRpp + 1;
        const { awards, totalCount } = await this.searchNSFAwardsByInstitution(
          args.institution_name,
          fetchRpp,
          nsfOffset
        );
        if (page === 1) {
          fetchedTotalCount = totalCount;
        }
        return {
          items: awards,
          totalPages: Math.ceil(Math.min(totalCount, NSF_TOTAL_COUNT_CEILING) / fetchRpp),
        };
      },
      (award) => award.awardNumber,
      { hardCap: Math.ceil(NSF_TOTAL_COUNT_CEILING / fetchRpp) }
    );

    const filtered = result.records.filter((award) => {
      const awardInstitution = this.normalizeInstitutionName(award.institution);
      return this.matchesInstitution(awardInstitution, [normalizedInstitution]);
    });

    const pagination: {
      limit: number;
      offset: number;
      total?: number;
      total_lower_bound?: number;
      has_more: boolean;
      capped?: true;
    } = buildPagination({
      requestedLimit: args.limit,
      offset,
      total: filtered.length,
      defaultLimit: 10,
    });
    // Same saturation check as the single-fetch branches: fetchedTotalCount is
    // the pre-filter NSF totalCount from page 1, so this demotes exactly when
    // the underlying set was ceiling-saturated — independent of `truncated`,
    // which can never fire here (totalPages is derived from
    // min(totalCount, CEILING), so it can never exceed hardCap).
    applySaturatedLowerBound(pagination, fetchedTotalCount);

    const awards = filtered.slice(offset, offset + pagination.limit);

    const envelope = {
      // Top-level `total` is a required number (UniversalResponse contract).
      // When saturated, pagination.total is demoted to undefined; mirror the
      // single-fetch branches' pattern (top-level total stays the raw
      // ceiling-saturated count) by falling back to total_lower_bound.
      total: pagination.total ?? (pagination.total_lower_bound as number),
      items: awards,
      metadata: { pagination, filters_applied: args.filtersApplied },
    };

    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(projectFields(envelope, args.fields)),
        },
      ],
    };
  }

  private async find_nsf_awards_by_keywords(args: {
    keywords: string;
    limit?: number;
    offset?: number;
    fields?: string[];
    filtersApplied: FiltersApplied;
  }) {
    // Coerce offset via the shared helper BEFORE the fetch — see the comment in
    // find_nsf_awards_by_pi for why (silent-wrong-fetch otherwise).
    const offset = coerceOffset(args.offset);
    const nsfOffset = offset + 1;
    const rpp = resolveRpp(args.limit);
    const { awards, totalCount } = await this.searchNSFAwardsByKeywords(args.keywords, rpp, nsfOffset);

    // buildPagination must run here (the caller), not inside
    // searchNSFAwardsByKeywords — that method's try/catch swallows thrown
    // errors and returns an empty result, which would eat buildPagination's
    // "limit must be at least 1" throw instead of letting it propagate to
    // handleToolCall's error envelope.
    const pagination = buildPagination({
      requestedLimit: args.limit,
      offset,
      total: totalCount,
      defaultLimit: 10,
    });
    applySaturatedLowerBound(pagination, totalCount);

    const envelope = {
      total: totalCount,
      // Defensive: the upstream API is trusted to honor rpp, but slice to
      // pagination.limit so an over-returning response can't leak extra rows.
      items: awards.slice(0, pagination.limit),
      metadata: { pagination, filters_applied: args.filtersApplied },
    };
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(projectFields(envelope, args.fields)),
        },
      ],
    };
  }

  private async fetchNSFAwardData(awardNumber: string): Promise<NSFAward> {
    const cleanAwardNumber = awardNumber.replace(/[^0-9]/g, "");

    const apiUrl = `https://api.nsf.gov/services/v1/awards.json?id=${cleanAwardNumber}&printFields=id,title,abstractText,piFirstName,piLastName,coPDPI,poName,awardeeName,awardeeCity,awardeeStateCode,fundsObligatedAmt,estimatedTotalAmt,startDate,expDate,primaryProgram,ueiNumber,fundProgramName`;

    const response = await fetch(apiUrl, { redirect: "follow" });
    if (!response.ok) {
      throw new Error(`NSF API request failed: ${response.status} ${response.statusText}`);
    }

    const data = await response.json();

    if (!data.response?.award || data.response.award.length === 0) {
      throw new Error(`No NSF award found with number: ${awardNumber}`);
    }

    const award = data.response.award[0];
    return this.parseNSFAward(award);
  }

  /**
   * Fetch a page of PI-search results, trying each name-matching strategy in
   * turn until one yields results. Returns the parsed awards for that page
   * plus the NSF API's totalCount for the winning strategy.
   */
  private async searchNSFAwardsByPI(
    piName: string,
    rpp: number,
    nsfOffset = 1
  ): Promise<{ awards: NSFAward[]; totalCount: number }> {
    // Use the correct NSF API parameter 'pdPIName' for PI name searches
    const searchStrategies = [
      {
        name: "Exact name match",
        params: `pdPIName=${encodeURIComponent(piName.replace(/\s+/g, "+"))}`,
      },
      {
        name: "Last name only",
        params: `pdPIName=${encodeURIComponent(piName.split(" ").pop()?.replace(/\s+/g, "+") || piName)}`,
      },
      {
        name: "First name only",
        params: `pdPIName=${encodeURIComponent(piName.split(" ")[0]?.replace(/\s+/g, "+") || piName)}`,
      },
    ];

    for (const strategy of searchStrategies) {
      try {
        const apiUrl = `https://api.nsf.gov/services/v1/awards.json?${strategy.params}&printFields=id,title,abstractText,piFirstName,piLastName,coPDPI,poName,awardeeName,awardeeCity,awardeeStateCode,fundsObligatedAmt,estimatedTotalAmt,startDate,expDate,primaryProgram,ueiNumber,fundProgramName&offset=${nsfOffset}&rpp=${rpp}`;

        const response = await fetch(apiUrl, { redirect: "follow" });
        if (!response.ok) {
          continue;
        }

        const data = await response.json();

        if (data.response?.award && data.response.award.length > 0) {
          const awards = data.response.award.map((award: RawNSFAward) => this.parseNSFAward(award));

          if (awards.length > 0) {
            return { awards, totalCount: data.response.metadata?.totalCount ?? awards.length };
          }
        }
      } catch (error) {
        continue;
      }
    }

    return { awards: [], totalCount: 0 };
  }

  private async searchNSFAwardsByPersonnel(personName: string, limit: number): Promise<NSFAward[]> {
    // Search both PI and Co-PI fields
    const awards: NSFAward[] = [];

    // First search as PI
    const { awards: piAwards } = await this.searchNSFAwardsByPI(personName, limit);
    awards.push(...piAwards);

    // Then search Co-PI field (if we need more results)
    if (awards.length < limit) {
      try {
        const apiUrl = `https://api.nsf.gov/services/v1/awards.json?coPDPI=${encodeURIComponent(personName)}&printFields=id,title,abstractText,piFirstName,piLastName,coPDPI,poName,awardeeName,awardeeCity,awardeeStateCode,fundsObligatedAmt,estimatedTotalAmt,startDate,expDate,primaryProgram,ueiNumber,fundProgramName&offset=1&rpp=${Math.min(limit - awards.length, 100)}`;

        const response = await fetch(apiUrl, { redirect: "follow" });
        if (response.ok) {
          const data = await response.json();

          if (data.response?.award && data.response.award.length > 0) {
            const copiAwards = data.response.award.map((award: RawNSFAward) =>
              this.parseNSFAward(award)
            );
            awards.push(...copiAwards);
          }
        }
      } catch (error) {
        // Continue with PI results only
      }
    }

    return awards.slice(0, limit);
  }

  private async searchNSFAwardsByInstitution(
    institutionName: string,
    rpp: number,
    nsfOffset = 1
  ): Promise<{ awards: NSFAward[]; totalCount: number }> {
    try {
      const apiUrl = `https://api.nsf.gov/services/v1/awards.json?awardeeName=${encodeURIComponent(institutionName)}&printFields=id,title,abstractText,piFirstName,piLastName,coPDPI,poName,awardeeName,awardeeCity,awardeeStateCode,fundsObligatedAmt,estimatedTotalAmt,startDate,expDate,primaryProgram,ueiNumber,fundProgramName&offset=${nsfOffset}&rpp=${rpp}`;

      const response = await fetch(apiUrl, { redirect: "follow" });
      if (!response.ok) {
        return { awards: [], totalCount: 0 };
      }

      const data = await response.json();

      if (data.response?.award && data.response.award.length > 0) {
        const awards = data.response.award.map((award: RawNSFAward) => this.parseNSFAward(award));
        return { awards, totalCount: data.response.metadata?.totalCount ?? awards.length };
      }

      return { awards: [], totalCount: data.response?.metadata?.totalCount ?? 0 };
    } catch (error) {
      return { awards: [], totalCount: 0 };
    }
  }

  private async searchNSFAwardsByKeywords(
    keywords: string,
    rpp: number,
    nsfOffset = 1
  ): Promise<{ awards: NSFAward[]; totalCount: number }> {
    try {
      const apiUrl = `https://api.nsf.gov/services/v1/awards.json?keyword=${encodeURIComponent(keywords)}&printFields=id,title,abstractText,piFirstName,piLastName,coPDPI,poName,awardeeName,awardeeCity,awardeeStateCode,fundsObligatedAmt,estimatedTotalAmt,startDate,expDate,primaryProgram,ueiNumber,fundProgramName&offset=${nsfOffset}&rpp=${rpp}`;

      const response = await fetch(apiUrl, { redirect: "follow" });
      if (!response.ok) {
        return { awards: [], totalCount: 0 };
      }

      const data = await response.json();

      if (data.response?.award && data.response.award.length > 0) {
        const awards = data.response.award.map((award: RawNSFAward) => this.parseNSFAward(award));
        return { awards, totalCount: data.response.metadata?.totalCount ?? awards.length };
      }

      return { awards: [], totalCount: data.response?.metadata?.totalCount ?? 0 };
    } catch (error) {
      return { awards: [], totalCount: 0 };
    }
  }

  private parseNSFAward(award: RawNSFAward): NSFAward {
    const coPIs =
      award.coPDPI && typeof award.coPDPI === "string"
        ? award.coPDPI.split(";").map((name: string) => name.trim())
        : [];

    return {
      awardNumber: award.id || "",
      title: award.title || "No title available",
      institution: award.awardeeName || "Unknown institution",
      principalInvestigator:
        `${award.piFirstName || ""} ${award.piLastName || ""}`.trim() || "Unknown PI",
      coPIs,
      totalIntendedAward: award.estimatedTotalAmt
        ? `$${parseInt(award.estimatedTotalAmt).toLocaleString()}`
        : "Amount not available",
      totalAwardedToDate: award.fundsObligatedAmt
        ? `$${parseInt(award.fundsObligatedAmt).toLocaleString()}`
        : "Amount not available",
      startDate: award.startDate || "Unknown",
      endDate: award.expDate || "Unknown",
      abstract: award.abstractText || "No abstract available",
      primaryProgram: award.primaryProgram || award.fundProgramName || "Unknown program",
      programOfficer: award.poName || "Unknown",
      ueiNumber: award.ueiNumber || "",
    };
  }

  private formatNSFAwardsResults(title: string, awards: NSFAward[], summary: string): string {
    let result = `🏆 **${title}**\n\n${summary}\n\n`;

    if (awards.length === 0) {
      result += "❌ **No awards found**\n\n";
      result += "**Suggestions:**\n";
      result += "• Try different name variations\n";
      result += "• Check spelling\n";
      result += "• Try searching by last name only\n";
      result += "• Use institution search instead\n";
      return result;
    }

    for (let i = 0; i < awards.length; i++) {
      const award = awards[i];
      result += `**${i + 1}. Award ${award.awardNumber}**\n`;
      result += `• **Title**: ${award.title}\n`;
      result += `• **PI**: ${award.principalInvestigator}\n`;
      result += `• **Institution**: ${award.institution}\n`;
      result += `• **Amount**: ${award.totalIntendedAward}\n`;
      result += `• **Period**: ${award.startDate} to ${award.endDate}\n`;
      result += `• **Program**: ${award.primaryProgram}\n`;

      if (award.coPIs.length > 0) {
        result += `• **Co-PIs**: ${award.coPIs.slice(0, 3).join("; ")}${award.coPIs.length > 3 ? " ..." : ""}\n`;
      }

      result += "\n";
    }

    result += `**💡 Next Steps:**\n`;
    result += `• Use \`get_nsf_award\` for detailed information about specific awards\n`;
    result += `• Cross-reference with XDMoD usage data for impact analysis\n`;

    return result;
  }

  private formatSingleNSFAward(award: NSFAward): string {
    let result = `🏆 **NSF Award ${award.awardNumber}**\n\n`;

    result += `**Project Information:**\n`;
    result += `• **Title**: ${award.title}\n`;
    result += `• **Principal Investigator**: ${award.principalInvestigator}\n`;
    result += `• **Institution**: ${award.institution}\n`;
    result += `• **Program Officer**: ${award.programOfficer}\n`;
    result += `• **Primary Program**: ${award.primaryProgram}\n\n`;

    result += `**Funding Details:**\n`;
    result += `• **Total Award Amount**: ${award.totalIntendedAward}\n`;
    result += `• **Amount Obligated**: ${award.totalAwardedToDate}\n`;
    result += `• **Project Period**: ${award.startDate} to ${award.endDate}\n\n`;

    if (award.coPIs.length > 0) {
      result += `**Co-Principal Investigators:**\n`;
      for (const copi of award.coPIs.slice(0, 10)) {
        result += `• ${copi}\n`;
      }
      if (award.coPIs.length > 10) {
        result += `• ... and ${award.coPIs.length - 10} more\n`;
      }
      result += "\n";
    }

    result += `**Abstract:**\n${award.abstract}\n\n`;

    result += `**Research Impact:**\n`;
    result += `• This NSF-funded research may utilize ACCESS-CI computational resources\n`;
    result += `• Use XDMoD to analyze computational usage patterns for this project\n`;
    result += `• Cross-reference PI/Co-PI names with XDMoD user data\n`;

    return result;
  }

  /**
   * Normalize institution names for better matching.
   * Handles common variations in punctuation, abbreviations, and formatting.
   */
  private normalizeInstitutionName(name: string): string {
    return (
      name
        // Normalize punctuation variations
        .replace(/,\s*(at|in|of)\s*/gi, " $1 ") // "Colorado, Boulder" → "Colorado at Boulder"
        .replace(/,\s+/g, " ") // Remove other commas
        .replace(/\s*-\s*/g, "-") // Normalize hyphens
        .replace(/\s*&\s*/g, " and ") // Normalize ampersands
        // Normalize institution type words
        .replace(/\b(University|College|Institute|School|Center|Laboratory|Lab)\b/gi, (match) => {
          const mappings: Record<string, string> = {
            university: "University",
            college: "College",
            institute: "Institute",
            school: "School",
            center: "Center",
            laboratory: "Laboratory",
            lab: "Laboratory",
          };
          return mappings[match.toLowerCase()] || match;
        })
        // Handle common abbreviations
        .replace(/\bU\b/g, "University")
        .replace(/\bUniv\b/gi, "University")
        .replace(/\bColl\b/gi, "College")
        .replace(/\bInst\b/gi, "Institute")
        // Normalize whitespace
        .replace(/\s+/g, " ")
        .trim()
    );
  }

  /**
   * Check if an institution name matches the search criteria.
   * Uses multi-tier matching strategy to avoid false positives.
   */
  private matchesInstitution(institutionText: string, searchVariants: string[]): boolean {
    const normalizedText = institutionText.toLowerCase();

    // Common words that should be ignored in word overlap matching
    const COMMON_INSTITUTION_WORDS = new Set([
      "university",
      "institute",
      "college",
      "school",
      "center",
      "academy",
      "polytechnic",
      "tech",
      "state",
      "national",
    ]);

    for (const variant of searchVariants) {
      const normalizedVariant = variant.toLowerCase();

      // Tier 1: Exact match (highest confidence)
      if (normalizedText === normalizedVariant) {
        return true;
      }

      // Tier 2: Full variant contained in text (with length check to avoid false positives)
      if (normalizedVariant.length > 8 && normalizedText.includes(normalizedVariant)) {
        return true;
      }

      // Tier 3: Check significant word overlap (excludes common words)
      const textWords = new Set(
        normalizedText.split(/\s+/).filter((w) => w.length > 3 && !COMMON_INSTITUTION_WORDS.has(w))
      );

      const variantWords = normalizedVariant
        .split(/\s+/)
        .filter((w) => w.length > 3 && !COMMON_INSTITUTION_WORDS.has(w));

      if (variantWords.length > 0 && textWords.size > 0) {
        const matchingWords = variantWords.filter((word) => textWords.has(word));
        const overlapRatio = matchingWords.length / variantWords.length;

        // Require EITHER high overlap (75%+) OR at least 2 matching significant words
        if (overlapRatio >= 0.75 || (matchingWords.length >= 2 && overlapRatio >= 0.5)) {
          return true;
        }
      }
    }

    return false;
  }
}
