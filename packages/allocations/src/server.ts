import {
  BaseAccessServer,
  handleApiError,
  projectFields,
  FIELDS_OF_SCIENCE,
  ALLOCATION_TYPES,
  getFieldNames,
  Tool,
  CallToolResult,
  DrupalAuthProvider,
  getRequestContext,
  fetchAllPages,
  buildPagination,
} from "@access-mcp/shared";
import { CorpusCache, type CorpusSnapshot } from "./corpus-cache.js";
import { resolveInstitution, type AliasTable } from "./institution-resolver.js";
import { createRequire } from "module";
const require = createRequire(import.meta.url);
const { version } = require("../package.json");

/**
 * ACCESS-CI Allocations MCP Server
 *
 * IMPORTANT CONTEXT FOR AI ASSISTANTS:
 * - ACCESS Credits are computational resource credits, NOT monetary currency
 * - They represent computing time/resources allocated to researchers
 * - Should NEVER be displayed with dollar signs ($) or treated as money
 * - Similar to Service Units (SUs) - they're computational allocation units
 */

// Data interfaces based on API analysis
interface AllocationResource {
  resourceName: string;
  units: string | null;
  allocation: number | null;
  resourceId: number;
}

interface Project {
  projectId: number;
  requestNumber: string;
  requestTitle: string;
  pi: string;
  piInstitution: string;
  fos: string; // Field of Science
  abstract: string;
  allocationType: string;
  beginDate: string;
  endDate: string;
  resources: AllocationResource[];
}

interface ProjectsResponse {
  projects: Project[];
  pages: number;
  filters: Record<string, unknown>;
}

// One parsed NSF award. `blob` is the existing flat pipe-joined display
// string (Award | PI | Institution | Amount); `institution` is the ISOLATED
// `Institution:` field value (label stripped, trimmed), or "" if the award
// had no Institution line. The isolated field exists so
// validateInstitutionMatch can anchor on just the institution text instead
// of substring-matching the whole blob (which also contains the PI name,
// award title, and dollar amount — a much wider false-positive surface).
interface NSFAward {
  blob: string;
  institution: string;
}

interface SearchProjectsArgs {
  project_id?: number;
  similar_to?: number;
  similarity_keywords?: string;
  limit?: number;
  similarity_threshold?: number;
  include_same_field?: boolean;
  resource_name?: string;
  query?: string;
  field_of_science?: string;
  allocation_type?: string;
  date_range?: { start_date?: string; end_date?: string };
  min_allocation?: number;
  sort_by?: string;
  offset?: number;
  fields?: string[];
}

interface SearchProjectsFiltersApplied {
  query: string | null;
  field_of_science: string | null;
  resource_name: string | null;
  allocation_type: string | null;
  date_range: { start_date?: string; end_date?: string } | null;
  min_allocation: number | null;
}

/**
 * Build the `filters_applied` disclosure object from the router's original
 * args. All six narrowing params (query/field_of_science/resource_name/
 * allocation_type/date_range/min_allocation) are disclosed on EVERY
 * search_projects sub-handler — including branches that structurally never
 * consult a given param (e.g. listProjectsByField never applies
 * resource_name) — so a consumer sees an identical key set regardless of
 * which routing branch ran (Phase 4b design §2/§3, mirrors nsf-awards'
 * buildFiltersApplied). A key a branch DOES apply must always carry that
 * branch's actually-applied value, never null — see each sub-handler's
 * per-branch test.
 */
function buildFiltersApplied(args: SearchProjectsArgs): SearchProjectsFiltersApplied {
  return {
    query: args.query ?? null,
    field_of_science: args.field_of_science ?? null,
    resource_name: args.resource_name ?? null,
    allocation_type: args.allocation_type ?? null,
    date_range: args.date_range ?? null,
    min_allocation: args.min_allocation ?? null,
  };
}

interface AnalyzeFundingArgs {
  project_id?: number;
  institution?: string;
  pi_name?: string;
  field_of_science?: string;
  limit?: number;
}

/**
 * Acronyms and short forms -> the institution's full name. Used only to
 * pre-normalize a user's QUERY before resolving it against the controlled vocab
 * (acronyms like "TAMU"/"MIT" appear nowhere in the vocab, and a bare substring
 * match sends "MIT" to "Smith College"). The full-name target is matched against
 * the vocab after normalization, so punctuation differences (e.g. "University of
 * California, Berkeley") do not matter. This is NOT a variant generator: it never
 * swaps "University of X" with "X University".
 */
const ACCESS_INSTITUTION_ALIASES: AliasTable = {
  UIUC: "University of Illinois at Urbana-Champaign",
  MIT: "Massachusetts Institute of Technology",
  Caltech: "California Institute of Technology",
  CIT: "California Institute of Technology",
  CMU: "Carnegie Mellon University",
  "Georgia Tech": "Georgia Institute of Technology",
  GT: "Georgia Institute of Technology",
  "UC Berkeley": "University of California, Berkeley",
  Berkeley: "University of California, Berkeley",
  UCLA: "University of California, Los Angeles",
  UCSD: "University of California, San Diego",
  UCSB: "University of California, Santa Barbara",
  "CU Boulder": "University of Colorado Boulder",
  "UT Austin": "University of Texas at Austin",
  TAMU: "Texas A&M University",
  OSU: "Ohio State University",
  "Penn State": "Pennsylvania State University",
  PSU: "Pennsylvania State University",
  MSU: "Michigan State University",
  ASU: "Arizona State University",
  FSU: "Florida State University",
  Stanford: "Stanford University",
  Harvard: "Harvard University",
  Princeton: "Princeton University",
  Yale: "Yale University",
  Columbia: "Columbia University",
  UChicago: "University of Chicago",
};

export class AllocationsServer extends BaseAccessServer {
  private projectCache = new Map<number, ProjectsResponse>();
  private cacheTimestamps = new Map<number, number>();
  private readonly CACHE_TTL = 5 * 60 * 1000; // 5 minutes

  // Resident full-corpus cache: tools filter the COMPLETE project set so `total`
  // is a true count (the fix for the page-cap false-negatives, e.g. PNRP). See
  // corpus-cache.ts for the lifecycle contracts.
  private static readonly CORPUS_TTL_MS = 6 * 60 * 60 * 1000; // 6h (data is ~quarterly)
  private readonly corpus = new CorpusCache<Project>(() => this.fetchCorpus(), {
    ttlMs: AllocationsServer.CORPUS_TTL_MS,
    onError: (err) =>
      this.logger.error("Allocations corpus refresh failed; serving previous snapshot", {
        error: err instanceof Error ? err.message : String(err),
      }),
  });
  private refreshTimer?: ReturnType<typeof setTimeout>;

  constructor() {
    super("access-allocations", version, "https://allocations.access-ci.org");
  }

  /**
   * Fetch the complete current-projects corpus, projecting out the unused
   * `publications` field at ingest (nothing reads it — the Project interface
   * omits it). Its size is non-uniform: near-zero on the newest projects, up to
   * ~12KB on older ones with real publication lists, so dropping it mainly trims
   * the tail. Dedupe/over-range-guard live in fetchAllPages.
   */
  private async fetchCorpus(): Promise<CorpusSnapshot<Project>> {
    const { records, pages, truncated } = await fetchAllPages<Project, Project>(
      async (page) => {
        const url = `${this.baseURL}/current-projects.json?page=${page}`;
        const response = await fetch(url);
        if (!response.ok) {
          throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }
        const data = (await response.json()) as ProjectsResponse;
        return { items: data.projects, totalPages: data.pages };
      },
      (p) => p.projectId,
      { concurrency: 10 },
      (p) => this.projectRecord(p),
    );
    return { records, pages, truncated, fetchedAt: Date.now() };
  }

  /**
   * Keep the Project fields (incl. abstract, which search reads) and drop
   * anything extra the raw payload carries (notably the heavy `publications`
   * array). Applied both when building the corpus and when returning a record
   * from the live revalidation scan, so every project the tools see is the same
   * shape regardless of which path produced it.
   */
  /**
   * A project's ACCESS Credits allocation — the one comparable magnitude across
   * projects. Resource allocations carry heterogeneous, non-additive units
   * (ACCESS Credits, SUs, GB, Dollars, and "[Yes = 1, No = 0]" flags on support
   * line items), so summing `allocation` across a project's resources produces a
   * meaningless number. ~97% of current projects carry an ACCESS Credits line;
   * those without one (legacy SU/core-hour allocations) report 0 for ranking and
   * threshold purposes. Sum in case a project lists the credits unit more than once.
   */
  private accessCreditsAmount(p: Project): number {
    return p.resources
      .filter((r) => r.units === "ACCESS Credits")
      .reduce((sum, r) => sum + (r.allocation || 0), 0);
  }

  private projectRecord(p: Project): Project {
    return {
      projectId: p.projectId,
      requestNumber: p.requestNumber,
      requestTitle: p.requestTitle,
      pi: p.pi,
      piInstitution: p.piInstitution,
      fos: p.fos,
      abstract: p.abstract,
      allocationType: p.allocationType,
      beginDate: p.beginDate,
      endDate: p.endDate,
      resources: p.resources,
    };
  }

  /**
   * Return the complete corpus for filtering. Stale-while-revalidate: a warm
   * request is never blocked by a refresh.
   */
  private async ensureCorpus(): Promise<CorpusSnapshot<Project>> {
    return this.corpus.ensure();
  }

  /** Schedule the next background refresh AFTER the previous one settles (no overlap). */
  private scheduleCorpusRefresh(): void {
    this.refreshTimer = setTimeout(() => {
      void this.corpus
        .refresh()
        .catch(() => {}) // failures already logged via onError; keep-old handles it
        .finally(() => this.scheduleCorpusRefresh());
    }, AllocationsServer.CORPUS_TTL_MS);
    this.refreshTimer.unref?.();
  }

  async start(options?: { httpPort?: number }): Promise<void> {
    await super.start(options);
    // Eager warm, fire-and-forget with a catch (a floating rejection would crash
    // the process). A request that beats the warm awaits the single-flight fetch.
    void this.ensureCorpus().catch((err) =>
      this.logger.error("Allocations corpus warm-up failed", {
        error: err instanceof Error ? err.message : String(err),
      }),
    );
    this.scheduleCorpusRefresh();
  }

  async stop(): Promise<void> {
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
      this.refreshTimer = undefined;
    }
    await super.stop();
  }

  // Lazily-created Drupal auth provider for authenticated, per-user endpoints
  // (currently just get_rp_account). The public allocations tools do NOT use
  // this and stay unauthenticated. Mirrors the announcements server pattern.
  private drupalAuth?: DrupalAuthProvider;

  private getDrupalAuth(): DrupalAuthProvider {
    if (!this.drupalAuth) {
      const baseUrl = process.env.DRUPAL_API_URL;
      const username = process.env.DRUPAL_USERNAME;
      const password = process.env.DRUPAL_PASSWORD;
      if (!baseUrl || !username || !password) {
        throw new Error(
          "get_rp_account requires DRUPAL_API_URL, DRUPAL_USERNAME, and DRUPAL_PASSWORD environment variables"
        );
      }
      this.drupalAuth = new DrupalAuthProvider(baseUrl, username, password);
    }
    return this.drupalAuth;
  }

  private getActingUserAccessId(): string {
    const actingUser = getRequestContext()?.actingUser || process.env.ACTING_USER;
    if (!actingUser) {
      throw new Error(
        "Authentication required: No acting user specified.\n\n" +
          "Please authenticate with your ACCESS-CI credentials to use this tool. " +
          "If using Claude, add this server as an authenticated connector via Customize > Connectors."
      );
    }
    return actingUser;
  }

  /**
   * Wrap a Drupal response body as an MCP text content block. Guards against a
   * missing/undefined body: JSON.stringify(undefined) returns undefined (not a
   * string), which produces a content[0] with no `text` field and fails MCP
   * response validation. Emit an explicit message instead.
   */
  private jsonContent(data: unknown): CallToolResult {
    const text =
      data === undefined || data === null || data === ""
        ? "The request succeeded but returned no data. If this was a first-time query, the account data may still be syncing — try again in a few seconds."
        : JSON.stringify(data, null, 2);
    return { content: [{ type: "text", text }] };
  }

  /**
   * Drop the freshness-only `stale` flag from an rp-account body. It's a UI
   * signal for the website's account panel (background-refresh trigger) that an
   * LLM can't act on, is redundant with `synced_at`, and misreports when the
   * server's freshness cache marker is evicted. `synced_at` stays as the source
   * of truth. Account-existence state (`state`, `has_account`) is untouched.
   */
  private stripStale<T>(body: T): T {
    if (body && typeof body === "object") {
      delete (body as Record<string, unknown>).stale;
    }
    return body;
  }

  private async getRpAccount(resourceId: string, live: boolean): Promise<CallToolResult> {
    const actingUser = this.getActingUserAccessId();
    const auth = this.getDrupalAuth();
    const path = `/api/1.0/rp-account/by-resource/${encodeURIComponent(resourceId)}${live ? "?live=1" : ""}`;
    // Endpoint returns the account object at the top level (no data wrapper).
    const body = await auth.get(actingUser, path);
    return this.jsonContent(this.stripStale(body));
  }

  private async getMyRpAccounts(): Promise<CallToolResult> {
    const actingUser = this.getActingUserAccessId();
    const auth = this.getDrupalAuth();
    // Body is { accounts, state, synced_at } at the top level (no data wrapper).
    const body = await auth.get(actingUser, "/api/1.0/rp-accounts");
    return this.jsonContent(this.stripStale(body));
  }

  protected listingLinks(
    context: "list" | "search" | "details" = "list"
  ): Record<string, string> | undefined {
    if (context === "list" || context === "search") {
      return { see_all_url: "https://allocations.access-ci.org/current-projects" };
    }
    return undefined;
  }

  protected getTools(): Tool[] {
    return [
      {
        name: "search_projects",
        description: "Search ACCESS-CI research projects. Returns {total, items}.",
        inputSchema: {
          type: "object" as const,
          properties: {
            query: {
              type: "string",
              description:
                "Search query supporting operators: 'term1 AND term2', 'term1 OR term2', 'term1 NOT term2', exact phrases with quotes. Omit when using project_id or similar_to parameters.",
            },
            project_id: {
              type: "number",
              description:
                "Get detailed information for a specific project ID. When provided, returns full project details including complete abstract.",
            },
            field_of_science: {
              type: "string",
              description: "Filter by field of science (e.g., 'Computer Science', 'Physics')",
            },
            resource_name: {
              type: "string",
              description:
                "Filter projects using specific computational resources (e.g., 'NCSA Delta GPU', 'Purdue Anvil', 'ACCESS Credits')",
            },
            allocation_type: {
              type: "string",
              description:
                "Filter by allocation type. Valid values: 'Explore', 'Discover', 'Accelerate', 'Maximize', 'Ramp-Up'",
            },
            date_range: {
              type: "object" as const,
              description: "Filter by project date range",
              properties: {
                start_date: {
                  type: "string",
                  description: "Start date in YYYY-MM-DD format",
                  format: "date",
                },
                end_date: {
                  type: "string",
                  description: "End date in YYYY-MM-DD format",
                  format: "date",
                },
              },
            },
            min_allocation: {
              type: "number",
              description: "Minimum allocation amount filter",
            },
            similar_to: {
              type: "number",
              description:
                "Find projects similar to this project ID using semantic matching. Omit query parameter when using this.",
            },
            similarity_keywords: {
              type: "string",
              description:
                "Find projects similar to these keywords/research terms. Alternative to similar_to parameter.",
            },
            similarity_threshold: {
              type: "number",
              description:
                "Minimum similarity score (0.0-1.0) when using similar_to or similarity_keywords. Default: 0.3",
              default: 0.3,
              minimum: 0.0,
              maximum: 1.0,
            },
            include_same_field: {
              type: "boolean",
              description:
                "Whether to prioritize projects in the same field of science for similarity search (default: true)",
              default: true,
            },
            sort_by: {
              type: "string",
              description:
                "Sort results by: 'relevance', 'date_desc', 'date_asc', 'allocation_desc', 'allocation_asc', 'pi_name'",
              enum: [
                "relevance",
                "date_desc",
                "date_asc",
                "allocation_desc",
                "allocation_asc",
                "pi_name",
              ],
              default: "relevance",
            },
            limit: {
              type: "number",
              description: "Maximum number of results to return (default: 20, max: 500)",
              default: 20,
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
                "Project the response down to only these fields. Dotted path syntax: 'total', 'items[].requestTitle', 'items[].pi', 'metadata.pagination.has_more', etc. Use to reduce payload size when you only need specific fields. Omit to receive the full response. Only applies to listing results, not single-project lookups.",
            },
          },
          required: [],
          examples: [
            {
              name: "Search for machine learning projects",
              arguments: {
                query: "machine learning",
                limit: 10,
              },
            },
            {
              name: "Get specific project details",
              arguments: {
                project_id: 12345,
              },
            },
            {
              name: "List projects by field of science",
              arguments: {
                field_of_science: "Computer Science",
                limit: 20,
              },
            },
            {
              name: "Find projects using specific resource",
              arguments: {
                resource_name: "NCSA Delta GPU",
                limit: 15,
              },
            },
            {
              name: "Find similar projects",
              arguments: {
                similar_to: 12345,
                similarity_threshold: 0.7,
                limit: 10,
              },
            },
          ],
        },
        _meta: {
          supportsFieldProjection: true,
        },
      },
      {
        name: "analyze_funding",
        description:
          "Analyze NSF funding for ACCESS projects/institutions. Returns detailed markdown analysis.",
        inputSchema: {
          type: "object" as const,
          properties: {
            project_id: {
              type: "number",
              description:
                "Analyze funding for a specific ACCESS project ID. Returns NSF awards connected to the project's PI and institution.",
            },
            institution: {
              type: "string",
              description:
                "Generate a comprehensive funding profile for an institution (ACCESS allocations, NSF awards, top researchers, funding trends). Use the institution's full name. If the name is ambiguous — a system with several campuses (e.g. \"University of California\") or a shared word (e.g. \"Washington\") — the tool returns a list of candidate institutions; re-call with one specific name from that list.",
            },
            pi_name: {
              type: "string",
              description:
                "Find funded projects by principal investigator name. Cross-references ACCESS and NSF data.",
            },
            field_of_science: {
              type: "string",
              description: "Filter funded projects by field of science.",
            },
            limit: {
              type: "number",
              description:
                "Maximum number of projects/awards to return (default: 20 for institution analysis, 10 for others)",
              default: 10,
            },
          },
          required: [],
          examples: [
            {
              name: "Analyze funding for specific project",
              arguments: {
                project_id: 12345,
              },
            },
            {
              name: "Generate institutional funding profile",
              arguments: {
                institution: "University of Illinois at Urbana-Champaign",
                limit: 20,
              },
            },
            {
              name: "Find funded projects by PI",
              arguments: {
                pi_name: "John Smith",
              },
            },
            {
              name: "Find funded projects in a field",
              arguments: {
                field_of_science: "Computer Science",
                limit: 15,
              },
            },
          ],
        },
      },
      {
        name: "get_allocation_statistics",
        description:
          "Get allocation statistics (top fields of science, resources, institutions, and allocation types) as an exact census over all current ACCESS-CI projects. Returns aggregate counts.",
        inputSchema: {
          type: "object" as const,
          properties: {},
          required: [],
          examples: [
            {
              name: "Get allocation statistics",
              arguments: {},
            },
          ],
        },
      },
      {
        name: "get_rp_account",
        description:
          "Get the authenticated user's account and live balance on ONE resource provider (RP). Returns the RP display name, the user's rp_username, and their grants with current balances and units. Pass resource_id (ACCESS Global Resource ID, e.g. delta-gpu.ncsa.access-ci.org) — get it from get_my_rp_accounts (which lists the resources the user actually has), or from search_resources for an arbitrary resource. Use this for a fresh balance on a specific RP; use get_my_rp_accounts to see all accounts at once. Scoped to the authenticated acting user. Read-only.",
        inputSchema: {
          type: "object" as const,
          properties: {
            resource_id: {
              type: "string",
              description:
                "The ACCESS Global Resource ID of the resource provider (e.g. delta-gpu.ncsa.access-ci.org). Get it from the search_resources tool — each result carries its resource ids.",
            },
            live: {
              type: "boolean",
              description:
                "When true, overlay a real-time balance (slower, more current) instead of the default last-synced snapshot.",
              default: false,
            },
          },
          required: ["resource_id"],
          examples: [
            {
              name: "Get my account on an RP",
              arguments: { resource_id: "delta-gpu.ncsa.access-ci.org" },
            },
            {
              name: "Get my live balance on an RP",
              arguments: { resource_id: "delta-gpu.ncsa.access-ci.org", live: true },
            },
          ],
        },
      },
      {
        name: "get_my_rp_accounts",
        description:
          "List all resource-provider (RP) accounts for the authenticated user — every resource they have an allocation on, with cached balances. Returns one entry per RP: the resource_id (ACCESS Global Resource ID, e.g. delta-gpu.ncsa.access-ci.org), rp_display_name, rp_username, account state, and grants with balances and units. Start here to discover which resources the user has; then call get_rp_account with a resource_id for a live, up-to-the-minute balance on one of them. Balances here reflect the last sync (synced_at); a first-time query may return state \"syncing\" — ask again in a few seconds. Scoped to the authenticated acting user. Read-only.",
        inputSchema: { type: "object" as const, properties: {}, required: [] },
      },
    ];
  }

  protected getResources() {
    return [
      {
        uri: "accessci://allocations",
        name: "ACCESS-CI Research Projects and Allocations",
        description: "Current research projects, allocations, and resource utilization data",
        mimeType: "application/json",
      },
      {
        uri: "accessci://allocations/field-taxonomy",
        name: "Field of Science Taxonomy",
        description:
          "NSF field classification with typical resource requirements and allocation ranges for each field",
        mimeType: "application/json",
      },
      {
        uri: "accessci://allocations/allocation-types",
        name: "Allocation Types and Tiers",
        description:
          "Definitions of Discover, Explore, Accelerate, and Maximize allocation tiers with credit ranges and eligibility",
        mimeType: "application/json",
      },
      {
        uri: "accessci://allocations/search-guide",
        name: "Advanced Search Guide",
        description: "Guide for using boolean operators, exact phrases, and advanced search syntax",
        mimeType: "text/markdown",
      },
    ];
  }

  async handleToolCall(request: {
    method: "tools/call";
    params: { name: string; arguments?: Record<string, unknown> };
  }): Promise<CallToolResult> {
    const { name, arguments: args } = request.params;
    const toolArgs = (args || {}) as Record<string, unknown>;

    try {
      switch (name) {
        case "search_projects":
          return await this.searchProjectsRouter(toolArgs as SearchProjectsArgs);
        case "analyze_funding":
          return await this.analyzeFundingRouter(toolArgs as AnalyzeFundingArgs);
        case "get_allocation_statistics":
          return await this.getAllocationStatistics();
        case "get_rp_account":
          return await this.getRpAccount(
            toolArgs.resource_id as string,
            Boolean(toolArgs.live)
          );
        case "get_my_rp_accounts":
          return await this.getMyRpAccounts();
        default:
          throw new Error(`Unknown tool: ${name}`);
      }
    } catch (error) {
      // A persistent Drupal auth failure (an expired session the shared auth
      // layer could not recover, or a re-login that itself failed) gets the
      // structured envelope instead of the raw upstream text, e.g.
      // "Drupal API error: 307 Temporary Redirect".
      const authError = this.drupalAuthError(error);
      if (authError) return authError;
      return this.errorResponse(handleApiError(error));
    }
  }

  async handleResourceRead(request: { params: { uri: string } }) {
    const { uri } = request.params;

    if (uri === "accessci://allocations") {
      try {
        // Serve a page-1-equivalent preview from the resident corpus (the
        // resource is a sample of the full data, not a filtered query).
        const snapshot = await this.ensureCorpus();
        const data = {
          projects: snapshot.records.slice(0, 20),
          total: snapshot.records.length,
          pages: snapshot.pages,
          fetched_at: new Date(snapshot.fetchedAt).toISOString(),
        };
        return {
          contents: [
            {
              uri,
              mimeType: "application/json",
              text: JSON.stringify(data, null, 2),
            },
          ],
        };
      } catch (error) {
        throw new Error(`Failed to fetch allocations data: ${handleApiError(error)}`);
      }
    }

    if (uri === "accessci://allocations/field-taxonomy") {
      return this.createJsonResource(uri, {
        fields_of_science: FIELDS_OF_SCIENCE,
        available_fields: getFieldNames(),
        usage_notes: {
          purpose:
            "Understand typical resource requirements and software for different research fields",
          how_to_use:
            "Match your research area to a field to see typical resources and software",
        },
      });
    }

    if (uri === "accessci://allocations/allocation-types") {
      return this.createJsonResource(uri, {
        allocation_types: ALLOCATION_TYPES,
        quick_guide: {
          "Discover (Startup)": "1K-400K credits - For exploration and code development",
          "Explore (Standard)": "400K-1.5M credits - For established research projects",
          "Accelerate (Advanced)": "1.5M-10M credits - For large-scale research",
          "Maximize (Leadership)": "10M-50M credits - For transformative research",
        },
        choosing_a_tier: {
          step_1: "Estimate your computational needs based on your research field",
          step_2: "Check typical allocation ranges for your field in field-taxonomy",
          step_3: "Start with Discover if you're new or testing feasibility",
          step_4: "Move to higher tiers as your project scales and demonstrates need",
        },
      });
    }

    if (uri === "accessci://allocations/search-guide") {
      const guide = `# Advanced Search Guide for ACCESS Allocations

## Boolean Operators

### AND Operator
Requires **both** terms to be present in results.

**Examples**:
- \`machine learning AND gpu\` - Projects that mention both "machine learning" AND "gpu"
- \`climate AND simulation AND data\` - All three terms must be present

### OR Operator
Returns results with **either** term (or both).

**Examples**:
- \`genomics OR bioinformatics\` - Projects with either term
- \`tensorflow OR pytorch OR jax\` - Projects using any of these frameworks

### NOT Operator
Excludes results containing the specified term.

**Examples**:
- \`machine learning NOT tensorflow\` - ML projects that don't use TensorFlow
- \`physics NOT particle\` - Physics projects except particle physics

### Combining Operators
You can combine multiple operators in one query.

**Examples**:
- \`(machine learning OR deep learning) AND gpu NOT tensorflow\`
- \`climate AND (modeling OR simulation) NOT weather\`

## Exact Phrases

Use quotes for exact phrase matching.

**Examples**:
- \`"large language model"\` - Exact phrase match
- \`"genome assembly" AND "high memory"\` - Both exact phrases required

## Search Tips

### By Research Domain
- Use field-specific keywords from the field taxonomy
- Example: For Computer Science → \`"machine learning" OR "data science" OR HPC\`

### By Resource Type
- \`gpu\` - GPU-using projects
- \`"high memory"\` - Memory-intensive projects
- \`storage\` - Storage-heavy projects

### By Software
- \`gromacs\` - Molecular dynamics with GROMACS
- \`tensorflow OR pytorch\` - Deep learning frameworks
- \`"quantum espresso"\` - Quantum chemistry software

### By Allocation Size
Use the \`min_allocation\` parameter instead of search terms:
- \`min_allocation: 100000\` - Projects with ≥100K credits
- Combined: \`query: "machine learning", min_allocation: 500000\`

## Field of Science Filters

Instead of searching, use the \`field_of_science\` parameter:
- \`field_of_science: "Computer Science"\`
- \`field_of_science: "Biological Sciences"\`

Available fields: ${getFieldNames().join(", ")}

## Sorting Results

Use \`sort_by\` parameter:
- \`relevance\` - Best match for search terms (default)
- \`date_desc\` - Newest projects first
- \`allocation_desc\` - Largest allocations first
- \`pi_name\` - Alphabetical by PI

## Example Workflows

### Find Similar GPU Projects
\`\`\`
query: "(machine learning OR deep learning) AND gpu"
field_of_science: "Computer Science"
sort_by: "allocation_desc"
limit: 20
\`\`\`

### Genomics Projects with High Memory
\`\`\`
query: "genome assembly" OR metagenomics
min_allocation: 100000
sort_by: "date_desc"
\`\`\`

### Recent Climate Modeling Projects
\`\`\`
field_of_science: "Earth Sciences"
query: climate AND (modeling OR simulation)
date_range: {start_date: "2024-01-01"}
sort_by: "date_desc"
\`\`\`
`;
      return this.createMarkdownResource(uri, guide);
    }

    throw new Error(`Unknown resource: ${uri}`);
  }

  // Core API methods
  private async fetchProjects(page: number = 1): Promise<ProjectsResponse> {
    // Check cache first
    const cachedData = this.getCachedProjects(page);
    if (cachedData) {
      return cachedData;
    }

    const url = `${this.baseURL}/current-projects.json?page=${page}`;

    try {
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }
      const data = await response.json();

      // Cache the result
      this.cacheProjects(page, data);
      return data;
    } catch (error) {
      throw new Error(
        `Failed to fetch projects: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  private getCachedProjects(page: number): ProjectsResponse | null {
    const cached = this.projectCache.get(page);
    const timestamp = this.cacheTimestamps.get(page);

    if (cached && timestamp && Date.now() - timestamp < this.CACHE_TTL) {
      return cached;
    }

    // Clean up expired cache
    if (timestamp && Date.now() - timestamp >= this.CACHE_TTL) {
      this.projectCache.delete(page);
      this.cacheTimestamps.delete(page);
    }

    return null;
  }

  private cacheProjects(page: number, data: ProjectsResponse): void {
    this.projectCache.set(page, data);
    this.cacheTimestamps.set(page, Date.now());
  }


  /**
   * Router for consolidated search_projects tool
   * Routes to appropriate handler based on parameters
   */
  private async searchProjectsRouter(args: SearchProjectsArgs) {
    // Get specific project details (lookup — fields ignored, not enveloped)
    if (args.project_id) {
      return await this.getProjectDetails(args.project_id);
    }

    // Find similar projects
    if (args.similar_to || args.similarity_keywords) {
      return await this.findSimilarProjects(
        args.similar_to,
        args.similarity_keywords,
        args.limit,
        args.similarity_threshold,
        args.include_same_field,
        args.fields
      );
    }

    // filters_applied is built PER BRANCH below, from only the args that
    // branch actually consults — never from the router's raw args wholesale.
    // The schema declares all six narrowing params as independent optionals
    // (no mutual exclusion), so a caller can pass e.g. resource_name AND
    // field_of_science together; the router still dispatches on resource_name
    // alone (`if (args.resource_name && !args.query)`), landing on
    // listProjectsByResource, which never consults field_of_science or
    // allocation_type. Disclosing the caller's field_of_science there would
    // be a false disclosure — a filter shown as applied that never touched
    // the result set. Each branch below builds its own filters_applied from
    // exactly the params it reads, so an inapplicable key is always null
    // regardless of what the caller passed alongside the routing param.
    // Lookup and similar-projects branches above return before this point
    // and don't disclose filters_applied at all.

    // List projects by resource — applies resource_name, date_range,
    // min_allocation ONLY (verified: no field_of_science/allocation_type
    // read anywhere in listProjectsByResource).
    if (args.resource_name && !args.query) {
      return await this.listProjectsByResource(
        args.resource_name,
        args.limit,
        args.fields,
        args.date_range,
        args.min_allocation,
        args.sort_by,
        args.offset ?? 0,
        buildFiltersApplied({
          resource_name: args.resource_name,
          date_range: args.date_range,
          min_allocation: args.min_allocation,
        })
      );
    }

    // List projects by field — applies field_of_science, date_range,
    // min_allocation ONLY. The router guard already excludes resource_name/
    // allocation_type/query from reaching here, but building from an
    // explicit allowlist (not args) keeps that guarantee independent of the
    // guard's exact shape.
    if (args.field_of_science && !args.query && !args.resource_name && !args.allocation_type) {
      return await this.listProjectsByField(
        args.field_of_science,
        args.limit,
        args.fields,
        args.date_range,
        args.min_allocation,
        args.sort_by,
        args.offset ?? 0,
        buildFiltersApplied({
          field_of_science: args.field_of_science,
          date_range: args.date_range,
          min_allocation: args.min_allocation,
        })
      );
    }

    // List/filter projects by allocation_type — applies allocation_type
    // (always) and field_of_science (optionally, verified: consulted as
    // fosNeedle in listProjectsByAllocationType's filter), plus date_range/
    // min_allocation. resource_name never reaches here (router guard).
    if (args.allocation_type && !args.query && !args.resource_name) {
      return await this.listProjectsByAllocationType(
        args.allocation_type,
        args.field_of_science,
        args.limit,
        args.fields,
        args.date_range,
        args.min_allocation,
        args.sort_by,
        args.offset ?? 0,
        buildFiltersApplied({
          allocation_type: args.allocation_type,
          field_of_science: args.field_of_science,
          date_range: args.date_range,
          min_allocation: args.min_allocation,
        })
      );
    }

    // Standard search — applies query, field_of_science, allocation_type
    // (verified as hard filters inside calculateAdvancedSearchScore),
    // date_range, min_allocation (via applyCorpusFilters). resource_name is
    // NEVER consulted by this branch — including when the caller passes both
    // resource_name AND query, which still lands here (the router guard
    // `args.resource_name && !args.query` is false once query is set, so it
    // falls through past listProjectsByResource) — so resource_name must
    // always be null, regardless of what the caller passed.
    if (args.query) {
      return await this.searchProjects(
        args.query,
        args.field_of_science,
        args.allocation_type,
        args.limit,
        args.date_range,
        args.min_allocation,
        args.sort_by,
        args.fields,
        args.offset ?? 0,
        buildFiltersApplied({
          query: args.query,
          field_of_science: args.field_of_science,
          allocation_type: args.allocation_type,
          date_range: args.date_range,
          min_allocation: args.min_allocation,
        })
      );
    }

    // If no parameters provided, return error
    return this.errorResponse(
      "Please provide at least one search parameter: query, project_id, field_of_science, resource_name, allocation_type, similar_to, or similarity_keywords",
      { code: "invalid_request" }
    );
  }

  /**
   * Router for consolidated analyze_funding tool
   * Routes to appropriate handler based on parameters
   */
  private async analyzeFundingRouter(args: AnalyzeFundingArgs) {
    // Analyze specific project funding
    if (args.project_id) {
      return await this.analyzeProjectFunding(args.project_id);
    }

    // Generate institutional funding profile
    if (args.institution) {
      return await this.institutionalFundingProfile(args.institution, args.limit || 20);
    }

    // Find funded projects (with or without filters). An `institution` arg is
    // handled above by institutionalFundingProfile, so it never reaches here.
    return await this.findFundedProjects(args.pi_name, args.field_of_science, args.limit || 10);
  }

  /**
   * Apply the date-range/min-allocation corpus filters shared by every
   * search_projects routing branch. Extracted verbatim from the query
   * branch's inline filter block — same truthiness gates, same comparisons —
   * so `applied` only gains a key when the corresponding gate actually fires
   * (e.g. `minAllocation: 0` is treated as unset, matching the pre-extraction
   * behavior).
   */
  private applyCorpusFilters(
    records: Project[],
    filters: {
      dateRange?: { start_date?: string; end_date?: string };
      minAllocation?: number;
    }
  ): { filtered: Project[]; applied: Record<string, unknown> } {
    const { dateRange, minAllocation } = filters;
    const applied: Record<string, unknown> = {};

    if (dateRange) {
      applied.date_range = dateRange;
    }
    if (minAllocation) {
      applied.min_allocation = minAllocation;
    }

    const filtered = records.filter((project) => {
      // Date range filter
      if (dateRange) {
        const projectStart = new Date(project.beginDate);
        const projectEnd = new Date(project.endDate);

        if (dateRange.start_date) {
          const filterStart = new Date(dateRange.start_date);
          if (projectEnd < filterStart) return false;
        }

        if (dateRange.end_date) {
          const filterEnd = new Date(dateRange.end_date);
          if (projectStart > filterEnd) return false;
        }
      }

      // Minimum allocation filter — compare against the ACCESS Credits amount,
      // not a cross-unit sum (see accessCreditsAmount).
      if (minAllocation) {
        if (this.accessCreditsAmount(project) < minAllocation) return false;
      }

      return true;
    });

    return { filtered, applied };
  }

  private async searchProjects(
    query: string,
    fieldOfScience?: string,
    allocationType?: string,
    limit?: number,
    dateRange?: { start_date?: string; end_date?: string },
    minAllocation?: number,
    sortBy: string = "relevance",
    fields?: string[],
    offset: number = 0,
    filtersApplied?: SearchProjectsFiltersApplied
  ) {
    // Input validation
    if (!query || query.trim().length === 0) {
      throw new Error("Search query cannot be empty");
    }

    // Parse advanced search query
    const searchTerms = this.parseAdvancedQuery(query);

    // Score/filter over the COMPLETE corpus, not a page-capped window — a match
    // whose abstract sits past the old cap was previously invisible.
    const snapshot = await this.ensureCorpus();
    const allProjects = snapshot.records;

    // Apply filters
    const { filtered: filteredProjects } = this.applyCorpusFilters(allProjects, {
      dateRange,
      minAllocation,
    });

    // Score and filter projects based on search terms
    const scoredResults = filteredProjects
      .map((project) => ({
        project,
        score: this.calculateAdvancedSearchScore(
          project,
          searchTerms,
          fieldOfScience,
          allocationType
        ),
      }))
      .filter((item) => item.score > 0);

    // Apply sorting
    const sortedAll = this.applySorting(scoredResults, sortBy);
    const pagination = buildPagination({
      requestedLimit: limit,
      offset,
      total: sortedAll.length,
      defaultLimit: 20,
    });
    // Slice with pagination.offset (validated), not the raw offset param — a
    // negative/NaN offset must not reach Array.slice, which treats negative
    // indices as "from the end" and would silently hand back the tail of the
    // corpus as if it were an authoritative forward page.
    const sortedResults = sortedAll.slice(pagination.offset, pagination.offset + pagination.limit);

    // Return in universal {total, items} format
    const items = sortedResults.map(({ project, score }) => ({
      ...project,
      relevance_score: score > 0 ? score : undefined,
    }));

    // field_of_science / allocation_type are hard filters applied inside
    // calculateAdvancedSearchScore (a non-match scores 0 and is excluded), so
    // they must be disclosed here too — otherwise a caller sees a narrowed
    // result set with no filter reported, mirroring listProjectsByAllocationType.
    // Falls back to building from the raw params (rather than requiring a
    // caller-supplied object) so this method stays directly callable/testable.
    const resolvedFiltersApplied: SearchProjectsFiltersApplied =
      filtersApplied ??
      buildFiltersApplied({
        query,
        field_of_science: fieldOfScience,
        allocation_type: allocationType,
        date_range: dateRange,
        min_allocation: minAllocation,
      });

    const envelope = {
      total: sortedAll.length,
      items: items,
      metadata: {
        pagination,
        filters_applied: resolvedFiltersApplied,
        query_relevance: "loose_match" as const,
        fetched_at: new Date(snapshot.fetchedAt).toISOString(),
        ...(snapshot.truncated ? { corpus_truncated: true } : {}),
        ...(this.corpus.isStale() ? { stale: true } : {}),
      },
      documentation: {
        links: this.listingLinks("search"),
      },
    };

    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(projectFields(envelope, fields), null, 2),
        },
      ],
    };
  }

  // Parse advanced search query with operators
  private parseAdvancedQuery(query: string): {
    andTerms: string[];
    orTerms: string[];
    notTerms: string[];
    exactPhrases: string[];
    regularTerms: string[];
  } {
    const result = {
      andTerms: [] as string[],
      orTerms: [] as string[],
      notTerms: [] as string[],
      exactPhrases: [] as string[],
      regularTerms: [] as string[],
    };

    // Extract exact phrases first (quoted strings)
    const phraseRegex = /"([^"]*)"/g;
    let match;
    let queryWithoutPhrases = query;

    while ((match = phraseRegex.exec(query)) !== null) {
      result.exactPhrases.push(match[1]);
      queryWithoutPhrases = queryWithoutPhrases.replace(match[0], "");
    }

    // Parse remaining query for operators
    const tokens = queryWithoutPhrases.split(/\s+/).filter((token) => token.length > 0);
    let i = 0;

    while (i < tokens.length) {
      const token = tokens[i];

      if (token.toUpperCase() === "AND" && i + 1 < tokens.length) {
        result.andTerms.push(tokens[i + 1]);
        i += 2;
      } else if (token.toUpperCase() === "OR" && i + 1 < tokens.length) {
        result.orTerms.push(tokens[i + 1]);
        i += 2;
      } else if (token.toUpperCase() === "NOT" && i + 1 < tokens.length) {
        result.notTerms.push(tokens[i + 1]);
        i += 2;
      } else if (!["AND", "OR", "NOT"].includes(token.toUpperCase())) {
        result.regularTerms.push(token);
        i++;
      } else {
        i++;
      }
    }

    return result;
  }

  // Enhanced search scoring with advanced query support
  private calculateAdvancedSearchScore(
    project: Project,
    searchTerms: ReturnType<typeof this.parseAdvancedQuery>,
    fieldOfScience?: string,
    allocationType?: string
  ): number {
    let score = 0;

    // Field of science filter (required match)
    if (fieldOfScience && !project.fos.toLowerCase().includes(fieldOfScience.toLowerCase())) {
      return 0;
    }

    // Allocation type filter (required match)
    if (
      allocationType &&
      !project.allocationType.toLowerCase().includes(allocationType.toLowerCase())
    ) {
      return 0;
    }

    const projectText = (
      project.abstract +
      " " +
      project.requestTitle +
      " " +
      project.pi
    ).toLowerCase();
    const titleText = project.requestTitle.toLowerCase();

    // Handle NOT terms first (exclusions)
    for (const notTerm of searchTerms.notTerms) {
      if (projectText.includes(notTerm.toLowerCase())) {
        return 0; // Exclude if any NOT term is found
      }
    }

    // Exact phrases (highest weight)
    for (const phrase of searchTerms.exactPhrases) {
      if (projectText.includes(phrase.toLowerCase())) {
        score += titleText.includes(phrase.toLowerCase()) ? 15 : 5;
      }
    }

    // AND terms (all must be present)
    if (searchTerms.andTerms.length > 0) {
      const andMatches = searchTerms.andTerms.filter((term) =>
        projectText.includes(term.toLowerCase())
      );
      if (andMatches.length === searchTerms.andTerms.length) {
        score += 2 * andMatches.length;
      } else {
        return 0; // All AND terms must match
      }
    }

    // OR terms (any can be present)
    if (searchTerms.orTerms.length > 0) {
      const orMatches = searchTerms.orTerms.filter((term) =>
        projectText.includes(term.toLowerCase())
      );
      score += orMatches.length * 1.5;
    }

    // Regular terms with frequency-based scoring and multi-field bonus
    for (const term of searchTerms.regularTerms) {
      if (!this.isStopWord(term) && term.length > 2) {
        const termLower = term.toLowerCase();
        const abstractText = (project.abstract || "").toLowerCase();
        let fieldsMatched = 0;

        if (titleText.includes(termLower)) {
          score += 10;
          fieldsMatched++;
        }
        if (project.pi.toLowerCase().includes(termLower)) {
          score += 5;
          fieldsMatched++;
        }
        if (project.fos.toLowerCase().includes(termLower)) {
          score += 3;
          fieldsMatched++;
        }
        if (abstractText.includes(termLower)) {
          // Frequency-based scoring for abstract matches
          const occurrences = (abstractText.match(new RegExp(termLower.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi')) || []).length;
          score += Math.min(occurrences, 5); // Cap at 5 to prevent spam
          fieldsMatched++;
        }
        if (project.piInstitution.toLowerCase().includes(termLower)) {
          score += 0.5;
        }

        // Multi-field match bonus
        if (fieldsMatched > 1) {
          score += (fieldsMatched - 1) * 3;
        }
      }
    }

    return Math.min(score, 100); // Cap at reasonable maximum
  }

  // Apply sorting to search results
  private applySorting(
    scoredResults: Array<{ project: Project; score: number }>,
    sortBy: string
  ): Array<{ project: Project; score: number }> {
    switch (sortBy) {
      case "date_desc":
        return scoredResults.sort(
          (a, b) =>
            new Date(b.project.beginDate).getTime() - new Date(a.project.beginDate).getTime()
        );
      case "date_asc":
        return scoredResults.sort(
          (a, b) =>
            new Date(a.project.beginDate).getTime() - new Date(b.project.beginDate).getTime()
        );
      case "allocation_desc":
        return scoredResults.sort(
          (a, b) => this.accessCreditsAmount(b.project) - this.accessCreditsAmount(a.project)
        );
      case "allocation_asc":
        return scoredResults.sort(
          (a, b) => this.accessCreditsAmount(a.project) - this.accessCreditsAmount(b.project)
        );
      case "pi_name":
        return scoredResults.sort((a, b) => a.project.pi.localeCompare(b.project.pi));
      case "relevance":
      default:
        return scoredResults.sort((a, b) => b.score - a.score);
    }
  }

  private async getProjectDetails(projectId: number) {
    // Input validation
    if (!projectId || typeof projectId !== "number" || projectId <= 0) {
      throw new Error("Project ID must be a positive number");
    }

    const found = await this.findProjectById(projectId);
    if (found) {
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ total: 1, items: [found] }, null, 2),
          },
        ],
      };
    }

    return this.errorResponse(
      `Project with ID ${projectId} not found in current allocations.`,
      { code: "not_found" }
    );
  }

  /**
   * Look up a project by id in the complete corpus. D2 (freshness): the upstream
   * is real-time and page 1 is newest-first, so a project approved after the last
   * snapshot would be a false "not found". On a MISS against an expired snapshot,
   * revalidate with a bounded live page scan (newest pages first) before giving up.
   */
  private async findProjectById(projectId: number): Promise<Project | undefined> {
    const snapshot = await this.ensureCorpus();
    const hit = snapshot.records.find((p) => p.projectId === projectId);
    if (hit) return hit;

    // Miss. If the snapshot is still within its TTL, the project genuinely isn't
    // in the corpus — don't hit the network. (Expiry, not the hard staleness
    // ceiling: a project approved after a snapshot went stale must still resolve.)
    if (!this.corpus.isExpiredNow()) return undefined;

    // Expired miss: the project may be newer than the snapshot. Scan the first
    // few (newest-first) live pages before asserting non-existence. Project each
    // hit so it matches the corpus shape (no leaked `publications`).
    const REVALIDATE_PAGES = 3;
    for (let page = 1; page <= REVALIDATE_PAGES; page++) {
      try {
        const data = await this.fetchProjects(page);
        const p = data.projects.find((x) => x.projectId === projectId);
        if (p) return this.projectRecord(p);
        if (page >= data.pages) break;
      } catch {
        break; // upstream hiccup — fall through to not-found
      }
    }
    return undefined;
  }

  private async listProjectsByField(
    fieldOfScience: string,
    limit?: number,
    fields?: string[],
    dateRange?: { start_date?: string; end_date?: string },
    minAllocation?: number,
    sortBy: string = "relevance",
    offset: number = 0,
    filtersApplied?: SearchProjectsFiltersApplied,
  ) {
    // Input validation
    if (
      !fieldOfScience ||
      typeof fieldOfScience !== "string" ||
      fieldOfScience.trim().length === 0
    ) {
      throw new Error("Field of science must be a non-empty string");
    }

    // limit < 1 is validated centrally by buildPagination (via corpusListingEnvelope).

    const snapshot = await this.ensureCorpus();
    const needle = fieldOfScience.toLowerCase();
    const matched = snapshot.records.filter((project) => project.fos.toLowerCase().includes(needle));

    const { filtered } = this.applyCorpusFilters(matched, {
      dateRange,
      minAllocation,
    });
    const wrapped = filtered.map((project) => ({ project, score: 0 }));
    const sorted = this.applySorting(wrapped, sortBy).map((w) => w.project);

    const base = this.corpusListingEnvelope(sorted, snapshot, limit, offset);
    // This branch only ever applies field_of_science (+ date_range/min_allocation);
    // query/resource_name/allocation_type are structurally never consulted here
    // (the router only reaches this branch when those args are absent), so the
    // fallback builder is safe — it can't report a value this branch didn't apply.
    const resolvedFiltersApplied: SearchProjectsFiltersApplied =
      filtersApplied ??
      buildFiltersApplied({ field_of_science: fieldOfScience, date_range: dateRange, min_allocation: minAllocation });
    const envelope = {
      ...base,
      metadata: {
        filters_applied: resolvedFiltersApplied,
        ...base.metadata,
      },
    };

    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(projectFields(envelope, fields), null, 2),
        },
      ],
    };
  }

  /**
   * List projects by allocation type, optionally filtered by field of science
   */
  private async listProjectsByAllocationType(
    allocationType: string,
    fieldOfScience?: string,
    limit?: number,
    fields?: string[],
    dateRange?: { start_date?: string; end_date?: string },
    minAllocation?: number,
    sortBy: string = "relevance",
    offset: number = 0,
    filtersApplied?: SearchProjectsFiltersApplied,
  ) {
    // Input validation
    if (
      !allocationType ||
      typeof allocationType !== "string" ||
      allocationType.trim().length === 0
    ) {
      throw new Error("Allocation type must be a non-empty string");
    }

    // limit < 1 is validated centrally by buildPagination (via corpusListingEnvelope).

    const snapshot = await this.ensureCorpus();
    const typeNeedle = allocationType.toLowerCase();
    const fosNeedle = fieldOfScience?.toLowerCase();
    const matched = snapshot.records.filter((project) => {
      const typeMatch = project.allocationType.toLowerCase().includes(typeNeedle);
      const fieldMatch = !fosNeedle || project.fos.toLowerCase().includes(fosNeedle);
      return typeMatch && fieldMatch;
    });

    const { filtered } = this.applyCorpusFilters(matched, {
      dateRange,
      minAllocation,
    });
    const wrapped = filtered.map((project) => ({ project, score: 0 }));
    const sorted = this.applySorting(wrapped, sortBy).map((w) => w.project);

    const base = this.corpusListingEnvelope(sorted, snapshot, limit, offset);
    // This branch always applies allocation_type and optionally field_of_science
    // (+ date_range/min_allocation); query/resource_name are structurally never
    // consulted here (the router only reaches this branch when those args are
    // absent), so the fallback builder is safe.
    const resolvedFiltersApplied: SearchProjectsFiltersApplied =
      filtersApplied ??
      buildFiltersApplied({
        allocation_type: allocationType,
        field_of_science: fieldOfScience,
        date_range: dateRange,
        min_allocation: minAllocation,
      });
    const envelope = {
      ...base,
      metadata: {
        filters_applied: resolvedFiltersApplied,
        ...base.metadata,
      },
    };

    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(projectFields(envelope, fields), null, 2),
        },
      ],
    };
  }

  /**
   * Build a listing envelope from the COMPLETE filtered set. `total` is the true
   * match count over the whole corpus; `items` is the `[offset, offset+limit)`
   * window. Surfaces corpus freshness (fetchedAt) and, if the corpus was itself
   * truncated at hardCap, a truncated flag so a partial corpus is never reported
   * as complete.
   */
  private corpusListingEnvelope(
    matched: Project[],
    snapshot: CorpusSnapshot<Project>,
    requestedLimit: number | undefined,
    offset: number,
    defaultLimit: number = 20,
  ) {
    const pagination = buildPagination({ requestedLimit, offset, total: matched.length, defaultLimit });
    // Slice with pagination.offset (validated), not the raw offset param — see
    // the matching comment in searchProjects for why this matters.
    const items = matched.slice(pagination.offset, pagination.offset + pagination.limit);
    return {
      total: matched.length,
      items,
      metadata: {
        pagination,
        query_relevance: "loose_match" as const,
        fetched_at: new Date(snapshot.fetchedAt).toISOString(),
        ...(snapshot.truncated ? { corpus_truncated: true } : {}),
        ...(this.corpus.isStale() ? { stale: true } : {}),
      },
      documentation: {
        links: this.listingLinks("list"),
      },
    };
  }

  private async listProjectsByResource(
    resourceName: string,
    limit?: number,
    fields?: string[],
    dateRange?: { start_date?: string; end_date?: string },
    minAllocation?: number,
    sortBy: string = "relevance",
    offset: number = 0,
    filtersApplied?: SearchProjectsFiltersApplied,
  ) {
    // Input validation
    if (!resourceName || typeof resourceName !== "string" || resourceName.trim().length === 0) {
      throw new Error("Resource name must be a non-empty string");
    }

    // limit < 1 is validated centrally by buildPagination (via corpusListingEnvelope).

    // Filter the COMPLETE corpus so `total` is the true match count (past the
    // old 10-page cap, e.g. PNRP's projects that lived on later pages).
    const snapshot = await this.ensureCorpus();
    const needle = resourceName.toLowerCase();
    const matched = snapshot.records.filter((project) =>
      project.resources.some((resource) => resource.resourceName.toLowerCase().includes(needle)),
    );

    const { filtered } = this.applyCorpusFilters(matched, {
      dateRange,
      minAllocation,
    });
    const wrapped = filtered.map((project) => ({ project, score: 0 }));
    const sorted = this.applySorting(wrapped, sortBy).map((w) => w.project);

    const base = this.corpusListingEnvelope(sorted, snapshot, limit, offset);
    // This branch only ever applies resource_name (+ date_range/min_allocation);
    // query/field_of_science/allocation_type are structurally never consulted
    // here (the router only reaches this branch when query is absent), so the
    // fallback builder is safe.
    const resolvedFiltersApplied: SearchProjectsFiltersApplied =
      filtersApplied ??
      buildFiltersApplied({ resource_name: resourceName, date_range: dateRange, min_allocation: minAllocation });
    const envelope = {
      ...base,
      metadata: {
        filters_applied: resolvedFiltersApplied,
        ...base.metadata,
      },
    };

    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(projectFields(envelope, fields), null, 2),
        },
      ],
    };
  }

  private async getAllocationStatistics() {
    const fieldsMap = new Map<string, number>();
    const resourcesMap = new Map<string, number>();
    const institutionsMap = new Map<string, number>();
    const allocationTypesMap = new Map<string, number>();

    // Census over the complete corpus (not a recent-pages sample): exact counts.
    const snapshot = await this.ensureCorpus();
    const allProjects = snapshot.records;

    // Update statistics
    for (const project of allProjects) {
      fieldsMap.set(project.fos, (fieldsMap.get(project.fos) || 0) + 1);
      institutionsMap.set(
        project.piInstitution,
        (institutionsMap.get(project.piInstitution) || 0) + 1
      );
      allocationTypesMap.set(
        project.allocationType,
        (allocationTypesMap.get(project.allocationType) || 0) + 1
      );

      for (const resource of project.resources) {
        resourcesMap.set(resource.resourceName, (resourcesMap.get(resource.resourceName) || 0) + 1);
      }
    }

    // Format statistics
    const topFields = Array.from(fieldsMap.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10);

    const topResources = Array.from(resourcesMap.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10);

    const topInstitutions = Array.from(institutionsMap.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10);

    const allocationTypes = Array.from(allocationTypesMap.entries()).sort((a, b) => b[1] - a[1]);

    let statsText = `📊 **ACCESS-CI Allocation Statistics**\n`;
    statsText += snapshot.truncated
      ? `*(Analysis of ${allProjects.length} projects — corpus incomplete; counts are a lower bound)*\n\n`
      : `*(Census of all ${allProjects.length} current projects)*\n\n`;

    statsText += `**🔬 Top Fields of Science:**\n`;
    topFields.forEach(([field, count], i) => {
      statsText += `${i + 1}. ${field}: ${count} projects\n`;
    });

    statsText += `\n**💻 Most Requested Resources:**\n`;
    topResources.forEach(([resource, count], i) => {
      statsText += `${i + 1}. ${resource}: ${count} projects\n`;
    });

    statsText += `\n**🏛️ Top Institutions:**\n`;
    topInstitutions.forEach(([institution, count], i) => {
      statsText += `${i + 1}. ${institution}: ${count} projects\n`;
    });

    statsText += `\n**📈 Allocation Types:**\n`;
    allocationTypes.forEach(([type, count]) => {
      statsText += `• ${type}: ${count} projects\n`;
    });

    return {
      content: [
        {
          type: "text" as const,
          text: statsText,
        },
      ],
    };
  }

  private async findSimilarProjects(
    projectId?: number,
    keywords?: string,
    limit: number = 10,
    similarityThreshold: number = 0.3,
    includeSameField: boolean = true,
    fields?: string[]
  ) {
    let referenceProject: Project | null = null;
    let searchTerms: string = "";
    let referenceField: string = "";

    // Input validation
    if (limit > 50) limit = 50;
    if (similarityThreshold < 0) similarityThreshold = 0;
    if (similarityThreshold > 1) similarityThreshold = 1;

    // Get reference project if projectId provided
    if (projectId) {
      referenceProject = (await this.findProjectById(projectId)) || null;

      if (!referenceProject) {
        return this.errorResponse(
          `Project with ID ${projectId} not found in current allocations database.`,
          { code: "not_found" }
        );
      }

      // Extract sophisticated search terms from reference project
      searchTerms = this.extractKeyTermsFromProject(referenceProject);
      referenceField = referenceProject.fos;
    } else if (keywords) {
      searchTerms = keywords;
      referenceField = ""; // No specific field for keyword searches
    } else {
      return this.errorResponse(
        "Please provide either a project_id or keywords to find similar projects.",
        { code: "invalid_request" }
      );
    }

    // Score similarity over the COMPLETE corpus, not a 15-page window.
    const snapshot = await this.ensureCorpus();
    const allProjects = snapshot.records;

    // Calculate similarity scores for all projects
    const allScored = allProjects
      .filter((project) => !referenceProject || project.projectId !== referenceProject.projectId) // Exclude reference project
      .map((project) => ({
        project,
        similarity: this.calculateAdvancedSimilarity(
          project,
          searchTerms,
          referenceField,
          includeSameField
        ),
      }))
      .filter((item) => item.similarity >= similarityThreshold)
      .sort((a, b) => b.similarity - a.similarity);
    const scoredResults = allScored.slice(0, limit);

    // Return in universal {total, items} format with similarity scores
    const items = scoredResults.map(({ project, similarity }) => ({
      ...project,
      similarity_score: similarity,
    }));

    const envelope = {
      total: allScored.length,
      items: items,
      metadata: {
        pagination: {
          limit,
          offset: 0,
          has_more: allScored.length > items.length,
        },
        query_relevance: "loose_match" as const,
        fetched_at: new Date(snapshot.fetchedAt).toISOString(),
        ...(snapshot.truncated ? { corpus_truncated: true } : {}),
        ...(this.corpus.isStale() ? { stale: true } : {}),
      },
      documentation: {
        links: this.listingLinks("search"),
      },
    };

    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(projectFields(envelope, fields), null, 2),
        },
      ],
    };
  }

  // Extract sophisticated key terms from a project
  private extractKeyTermsFromProject(project: Project): string {
    // Combine title, abstract, and field for comprehensive term extraction
    const titleWords = project.requestTitle.toLowerCase().split(/\s+/);
    const abstractWords = project.abstract.toLowerCase().split(/\s+/);
    const fieldWords = project.fos.toLowerCase().split(/\s+/);

    // Weight terms: title (high), field (medium), abstract (medium)
    const termFrequency = new Map<string, number>();

    // Title terms get higher weight
    titleWords.forEach((word) => {
      if (word.length > 3 && !this.isStopWord(word)) {
        termFrequency.set(word, (termFrequency.get(word) || 0) + 3);
      }
    });

    // Field terms get medium-high weight
    fieldWords.forEach((word) => {
      if (word.length > 3 && !this.isStopWord(word)) {
        termFrequency.set(word, (termFrequency.get(word) || 0) + 2);
      }
    });

    // Abstract terms - focus on first 50 words (usually most relevant)
    abstractWords.slice(0, 50).forEach((word) => {
      if (word.length > 3 && !this.isStopWord(word)) {
        termFrequency.set(word, (termFrequency.get(word) || 0) + 1);
      }
    });

    // Return top weighted terms
    return Array.from(termFrequency.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([word]) => word)
      .join(" ");
  }

  // Advanced similarity calculation with multiple factors
  private calculateAdvancedSimilarity(
    project: Project,
    searchTerms: string,
    referenceField: string,
    includeSameField: boolean
  ): number {
    let similarity = 0;

    // Field of science similarity (high weight if same field)
    if (referenceField && includeSameField) {
      if (project.fos.toLowerCase() === referenceField.toLowerCase()) {
        similarity += 0.4; // 40% boost for same field
      } else if (
        project.fos.toLowerCase().includes(referenceField.toLowerCase()) ||
        referenceField.toLowerCase().includes(project.fos.toLowerCase())
      ) {
        similarity += 0.2; // 20% boost for related fields
      }
    }

    // Text similarity analysis
    const searchWords = searchTerms
      .toLowerCase()
      .split(/\s+/)
      .filter((word) => word.length > 3 && !this.isStopWord(word));

    if (searchWords.length === 0) return similarity;

    // Term matching with position-based weighting
    const titleText = project.requestTitle.toLowerCase();
    const abstractText = project.abstract.toLowerCase();

    let titleMatches = 0;
    let abstractMatches = 0;
    const totalTerms = searchWords.length;

    searchWords.forEach((term) => {
      if (titleText.includes(term)) {
        titleMatches++;
        similarity += 0.15; // Title matches are very valuable
      } else if (abstractText.includes(term)) {
        abstractMatches++;
        similarity += 0.05; // Abstract matches are good
      }
    });

    // Bonus for multiple term clusters
    const termCoverage = (titleMatches + abstractMatches) / totalTerms;
    if (termCoverage > 0.5) {
      similarity += 0.1 * termCoverage; // Bonus for good term coverage
    }

    // Resource type similarity (same computational needs might indicate similar research)
    // This is more sophisticated than basic keyword matching
    const resourceSimilarity = this.calculateResourceSimilarity(project, searchTerms);
    similarity += resourceSimilarity * 0.1;

    // PI institution clustering (same institution might indicate similar research environment)
    // This is a weak signal but can be useful for collaboration discovery

    return Math.min(similarity, 1.0); // Cap at 1.0
  }

  // Calculate resource-based similarity
  private calculateResourceSimilarity(project: Project, searchTerms: string): number {
    // Check if resource needs align with search context
    const resourceTypes = project.resources.map((r) => r.resourceName.toLowerCase());
    const searchLower = searchTerms.toLowerCase();

    let resourceScore = 0;

    // GPU resources for AI/ML research
    if (
      (searchLower.includes("machine") ||
        searchLower.includes("neural") ||
        searchLower.includes("deep")) &&
      resourceTypes.some((r) => r.includes("gpu"))
    ) {
      resourceScore += 0.5;
    }

    // HPC resources for simulation/modeling
    if (
      (searchLower.includes("simulation") ||
        searchLower.includes("modeling") ||
        searchLower.includes("computational")) &&
      resourceTypes.some((r) => r.includes("cpu") || r.includes("core"))
    ) {
      resourceScore += 0.3;
    }

    // Storage for data-intensive research
    if (
      (searchLower.includes("data") ||
        searchLower.includes("analysis") ||
        searchLower.includes("dataset")) &&
      resourceTypes.some((r) => r.includes("storage"))
    ) {
      resourceScore += 0.2;
    }

    return Math.min(resourceScore, 1.0);
  }

  private isStopWord(word: string): boolean {
    // Standard English stop words commonly used in text analysis
    const stopWords = [
      "the",
      "a",
      "an",
      "and",
      "or",
      "but",
      "in",
      "on",
      "at",
      "to",
      "for",
      "of",
      "with",
      "by",
      "is",
      "are",
      "was",
      "were",
      "be",
      "been",
      "have",
      "has",
      "had",
      "do",
      "does",
      "did",
      "will",
      "would",
      "could",
      "should",
      "may",
      "might",
      "must",
      "can",
      "cannot",
      "i",
      "you",
      "he",
      "she",
      "it",
      "we",
      "they",
      "me",
      "him",
      "her",
      "us",
      "them",
      "my",
      "your",
      "his",
      "her",
      "its",
      "our",
      "their",
      "this",
      "that",
      "these",
      "those",
      "all",
      "any",
      "each",
      "every",
      "some",
      "many",
      "much",
      "more",
      "most",
      "other",
      "than",
      "then",
      "when",
      "where",
      "why",
      "how",
      "what",
      "which",
      "who",
      "whom",
      "from",
      "into",
      "over",
      "under",
      "above",
      "below",
      "up",
      "down",
      "out",
      "off",
      "through",
      "during",
      "before",
      "after",
      "between",
      "among",
      "within",
      "without",
    ];
    return stopWords.includes(word.toLowerCase());
  }

  // Helper Methods

  // Formatting helpers
  private formatAllocation(allocation: number, units: string | null, resourceName: string): string {
    // Smart formatting for different resource types
    // IMPORTANT: ACCESS Credits are computational credits, NOT monetary values
    // They should never be displayed with dollar signs or currency formatting
    if (!allocation || !units) {
      return "";
    }

    // ACCESS Credits should never have dollar signs
    if (
      units.toLowerCase().includes("access credits") ||
      resourceName.toLowerCase().includes("access credits")
    ) {
      return `${allocation.toLocaleString()} ACCESS Credits`;
    }

    // Handle specific unit types
    switch (units.toLowerCase()) {
      case "su":
      case "sus":
        return `${allocation.toLocaleString()} SUs (Service Units)`;
      case "gpu hours":
        return `${allocation.toLocaleString()} GPU Hours`;
      case "core-hours":
        return `${allocation.toLocaleString()} Core-Hours`;
      case "gb":
        return `${allocation.toLocaleString()} GB`;
      case "tb":
        return `${allocation.toLocaleString()} TB`;
      default:
        // For unknown units, avoid currency formatting
        return `${allocation.toLocaleString()} ${units}`;
    }
  }

  // NSF Integration Methods

  /**
   * Normalize a PI name for NSF `personnel` queries. ACCESS stores `project.pi`
   * as "Last, First" (comma format). Measured against the live NSF API: comma
   * format triggers a loose tokenized search that floods results with unrelated
   * namesakes and can push the real person off the result cap; clean "First Last"
   * returns the correct person, and NSF's personnel search is order-insensitive
   * for clean two-token names. Already-clean or single-token names pass through
   * unchanged.
   */
  private normalizePIQuery(pi: string): string {
    const trimmed = pi.trim();
    const commaIndex = trimmed.indexOf(",");
    if (commaIndex === -1) {
      return trimmed.replace(/\s+/g, " ");
    }
    const last = trimmed.slice(0, commaIndex).trim();
    const first = trimmed.slice(commaIndex + 1).trim();
    if (!last || !first) {
      return trimmed.replace(/\s+/g, " ").replace(/,\s*$/, "").replace(/^,\s*/, "");
    }
    return `${first} ${last}`.replace(/\s+/g, " ");
  }

  private async analyzeProjectFunding(projectId: number) {
    try {
      // Get the ACCESS project details from the complete corpus (D2 revalidation
      // for a just-approved project is handled inside findProjectById).
      const accessProject = (await this.findProjectById(projectId)) || null;

      if (!accessProject) {
        return {
          content: [
            {
              type: "text" as const,
              text: `ACCESS project ${projectId} not found in current allocations database.`,
            },
          ],
        };
      }

      // Step 1: Get multiple name variations for better matching
      const piNameVariations = this.generatePINameVariations(accessProject.pi);

      // Step 2: Search NSF database with exact name matching
      const nsfSearchResults = new Map<string, string>();
      const relevantAwards: NSFAward[] = [];

      for (const nameVariation of piNameVariations) {
        try {
          const nsfData = (await this.callRemoteServer("nsf-awards", "search_nsf_awards", {
            personnel: this.normalizePIQuery(nameVariation),
            limit: 3,
          })) as { content?: Array<{ text?: string }> };
          const nsfResponse = this.formatNsfResponse(nsfData);

          if (
            nsfResponse &&
            !nsfResponse.includes("Error") &&
            !nsfResponse.includes("not available")
          ) {
            nsfSearchResults.set(nameVariation, nsfResponse);

            // Parse and filter for exact matches
            const exactMatches = this.parseNSFResponseExact(nsfResponse, accessProject.pi);
            relevantAwards.push(...exactMatches);
          }

          // Rate limiting
          await new Promise((resolve) => setTimeout(resolve, 150));
        } catch (error) {
          console.warn(`Error searching NSF for name variation "${nameVariation}":`, error);
        }
      }

      // Step 3: Cross-validate with institution matching. Match against the
      // award's ISOLATED institution field, not the flattened blob — the
      // blob also contains the PI name/title/amount, which widens the
      // false-positive surface for a substring-style match.
      const institutionValidatedAwards = relevantAwards.filter((award) =>
        this.validateInstitutionMatch(award.institution, accessProject.piInstitution)
      );

      // Step 4: Analyze temporal alignment (operates on the display blob —
      // it regex-extracts years from the full award text).
      const temporalAnalysis = this.analyzeTemporalAlignment(
        institutionValidatedAwards.map((award) => award.blob),
        accessProject.beginDate,
        accessProject.endDate
      );

      // Step 5: Generate comprehensive analysis
      let result = `🔗 **Comprehensive Funding Analysis**\n`;
      result += `**ACCESS Project ${projectId}**\n\n`;

      result += `**📋 Project Details:**\n`;
      result += `• **Title:** ${accessProject.requestTitle}\n`;
      result += `• **PI:** ${accessProject.pi} (${accessProject.piInstitution})\n`;
      result += `• **Field:** ${accessProject.fos}\n`;
      result += `• **Period:** ${accessProject.beginDate} to ${accessProject.endDate}\n`;
      result += `• **Resources:** ${this.summarizeResources(accessProject.resources)}\n\n`;

      result += `**🔍 NSF Award Search Strategy:**\n`;
      result += `• **Name Variations Searched:** ${piNameVariations.join(", ")}\n`;
      result += `• **Total NSF Responses:** ${nsfSearchResults.size}\n`;
      result += `• **Raw Awards Found:** ${relevantAwards.length}\n`;
      result += `• **Institution-Validated Awards:** ${institutionValidatedAwards.length}\n\n`;

      if (institutionValidatedAwards.length > 0) {
        result += `**🏆 Validated NSF Awards:**\n`;
        institutionValidatedAwards.forEach((award, index) => {
          result += `${index + 1}. ${award.blob}\n`;
        });
        result += `\n`;

        result += `**⏰ Temporal Analysis:**\n${temporalAnalysis}\n\n`;

        result += `**🎯 Funding Integration Insights:**\n`;
        result += `• **Strong Correlation:** ${institutionValidatedAwards.length} validated NSF award(s) for this PI\n`;
        result += `• **Research Continuity:** NSF funding supports computational research on ACCESS\n`;
        result += `• **Resource Optimization:** Federal investment leverages cyberinfrastructure\n`;
        result += `• **Impact Multiplier:** Combined funding amplifies research potential\n`;
      } else {
        result += `**🏆 NSF Award Analysis:**\n`;
        if (relevantAwards.length > 0) {
          result += `Found ${relevantAwards.length} potential awards but none passed institution validation:\n`;
          relevantAwards.slice(0, 3).forEach((award, index) => {
            result += `${index + 1}. ${award.blob}\n`;
          });
          result += `\n**⚠️ Validation Issues:**\n`;
          result += `• Institution names may differ between ACCESS and NSF systems\n`;
          result += `• PI may have moved institutions since award\n`;
          result += `• Awards may be under different name formats\n`;
        } else {
          result += `No NSF awards found for PI "${accessProject.pi}" variations.\n\n`;
          result += `**💡 Possible Explanations:**\n`;
          result += `• PI may have NSF funding under different name format\n`;
          result += `• Research may be funded by other federal agencies (DOE, NIH, etc.)\n`;
          result += `• Early career researcher or industry collaboration\n`;
          result += `• Exploratory ACCESS allocation for preliminary work\n`;
        }

        result += `\n**🔬 Alternative Analysis:**\n`;
        result += `• **Field-based Assessment:** Compare with other ${accessProject.fos} projects\n`;
        result += `• **Resource Utilization:** Analyze computational requirements vs. allocation\n`;
        result += `• **Institution Profile:** Review overall ${accessProject.piInstitution} funding patterns\n`;
      }

      return {
        content: [
          {
            type: "text" as const,
            text: result,
          },
        ],
      };
    } catch (error) {
      const authError = this.drupalAuthError(error);
      if (authError) return authError;
      return this.errorResponse(`Error analyzing project funding: ${handleApiError(error)}`);
    }
  }

  /**
   * Generate comprehensive PI name variations to handle different name formats.
   * Handles: format variations, middle initials, hyphenated names, suffixes, etc.
   *
   * CRITICAL FIX: Enhanced to handle more name format variations
   */
  private generatePINameVariations(piName: string): string[] {
    const variations = [piName];

    // Remove common suffixes for matching (Jr., Sr., II, III, etc.)
    const suffixes = /\b(Jr\.?|Sr\.?|II|III|IV|PhD|Ph\.D\.)\s*$/i;
    const nameWithoutSuffix = piName.trim().replace(suffixes, "").trim();
    if (nameWithoutSuffix !== piName.trim()) {
      variations.push(nameWithoutSuffix);
    }

    // Handle common name formats
    const parts = nameWithoutSuffix.split(/\s+/);

    if (parts.length >= 2) {
      const firstName = parts[0];
      const lastName = parts[parts.length - 1];
      const middleParts = parts.slice(1, -1);

      // Basic format variations
      variations.push(
        `${lastName}, ${firstName}`, // Last, First
        `${firstName} ${lastName}`, // First Last (no middle)
        `${lastName}, ${firstName[0]}.`, // Last, F.
        `${firstName[0]}. ${lastName}` // F. Last
      );

      // Handle hyphenated last names (e.g., "Mary Smith-Jones")
      if (lastName.includes("-")) {
        const hyphenParts = lastName.split("-");
        // Try each part separately
        for (const part of hyphenParts) {
          variations.push(
            `${firstName} ${part}`,
            `${part}, ${firstName}`,
            `${firstName[0]}. ${part}`
          );
        }
        // Try without hyphen
        const lastNameNoHyphen = hyphenParts.join("");
        variations.push(`${firstName} ${lastNameNoHyphen}`, `${lastNameNoHyphen}, ${firstName}`);
        // Try with space instead of hyphen
        const lastNameWithSpace = hyphenParts.join(" ");
        variations.push(`${firstName} ${lastNameWithSpace}`, `${lastNameWithSpace}, ${firstName}`);
      }

      // Handle hyphenated first names (e.g., "Mary-Ann Smith")
      if (firstName.includes("-")) {
        const hyphenParts = firstName.split("-");
        // Try each part separately
        for (const part of hyphenParts) {
          variations.push(`${part} ${lastName}`, `${lastName}, ${part}`, `${part[0]}. ${lastName}`);
        }
        // Try without hyphen
        const firstNameNoHyphen = hyphenParts.join("");
        variations.push(`${firstNameNoHyphen} ${lastName}`, `${lastName}, ${firstNameNoHyphen}`);
      }

      // Handle middle names/initials
      if (middleParts.length > 0) {
        const middleInitial = middleParts[0].charAt(0);
        const middleName = middleParts[0];

        variations.push(
          `${firstName} ${middleInitial}. ${lastName}`,
          `${firstName} ${middleInitial} ${lastName}`,
          `${lastName}, ${firstName} ${middleInitial}.`,
          `${lastName}, ${firstName} ${middleInitial}`,
          `${firstName[0]}. ${middleInitial}. ${lastName}`,
          `${firstName[0]}${middleInitial}. ${lastName}`,
          // Full middle name variations
          `${firstName} ${middleName} ${lastName}`,
          `${lastName}, ${firstName} ${middleName}`,
          // No middle name/initial
          `${firstName} ${lastName}`,
          `${lastName}, ${firstName}`
        );

        // If multiple middle names/initials
        if (middleParts.length > 1) {
          const allMiddleInitials = middleParts.map((p) => p.charAt(0)).join(". ") + ".";
          variations.push(
            `${firstName} ${allMiddleInitials} ${lastName}`,
            `${lastName}, ${firstName} ${allMiddleInitials}`
          );
        }
      }

      // Handle initials-only formats (e.g., "J.R. Smith" → "JR Smith", "J R Smith")
      const firstInitial = firstName.charAt(0);
      if (middleParts.length > 0) {
        const middleInitial = middleParts[0].charAt(0);
        variations.push(
          `${firstInitial}${middleInitial} ${lastName}`,
          `${firstInitial} ${middleInitial} ${lastName}`,
          `${firstInitial}.${middleInitial}. ${lastName}`
        );
      }

      // Common database format variations
      variations.push(
        `${lastName} ${firstName}`, // Last First (no comma)
        `${lastName} ${firstName[0]}`, // Last F (no punctuation)
        `${lastName}, ${firstName[0]}` // Last, F (no period)
      );
    }

    // Remove duplicates and empty strings
    return [...new Set(variations.filter((v) => v && v.trim().length > 0))];
  }

  // Token/word-boundary PI name match: every token of accessPi must appear as
  // a WHOLE token in nsfPiName, order-insensitive. Replaces raw substring
  // matching, which both (a) forward-matches "Matthew Long" against "Matthew
  // Longstreet" and (b) reverse-matches a short/initial NSF PI string like
  // "Li" against every "Wanlu Li" variation. Guards the reverse direction by
  // requiring the ACCESS-side token set to be non-empty and, since it's the
  // side we tokenize and require full containment of, a bare initial ("Li",
  // "W Li") on the NSF side naturally fails because it lacks the "wanlu"
  // token this predicate demands.
  private piNameMatches(nsfPiName: string, accessPi: string): boolean {
    const tokenize = (name: string): string[] =>
      name
        .toLowerCase()
        .replace(/[.,]/g, " ")
        .split(/\s+/)
        .filter((t) => t.length > 0);

    const nsfTokens = new Set(tokenize(nsfPiName));
    const accessTokens = tokenize(accessPi);

    if (accessTokens.length === 0 || nsfTokens.size === 0) {
      return false;
    }

    return accessTokens.every((token) => nsfTokens.has(token));
  }

  // Isolate the value of a NSF response "Institution:" line — strip the
  // label and surrounding whitespace so callers can match against just the
  // institution text, not the whole pipe-joined award blob.
  private isolateInstitution(line: string): string {
    return line.replace(/.*Institution:\s*/i, "").trim();
  }

  // Enhanced NSF response parsing with exact matching
  private parseNSFResponseExact(nsfResponse: string, expectedPI: string): NSFAward[] {
    if (!nsfResponse || nsfResponse.includes("not available") || nsfResponse.includes("Error")) {
      return [];
    }

    const awards: NSFAward[] = [];
    const lines = nsfResponse.split("\n");

    let currentAward = "";
    let currentPI = "";
    let currentInstitutionLine = "";
    let currentInstitution = "";
    let isExactPIMatch = false;

    for (const line of lines) {
      if (line.includes("Award Number:") || line.includes("Title:")) {
        // Process previous award
        if (currentAward && isExactPIMatch) {
          awards.push({
            blob: `${currentAward} | ${currentPI} | ${currentInstitutionLine}`,
            institution: currentInstitution,
          });
        }

        // Start new award
        currentAward = line.trim();
        currentPI = "";
        currentInstitutionLine = "";
        currentInstitution = "";
        isExactPIMatch = false;
      } else if (line.includes("Principal Investigator:")) {
        currentPI = line.trim();
        // Token/word-boundary name match (not raw substring — see
        // piNameMatches). Match against the raw NSF PI name portion of the
        // line; name-variation generation is retained upstream for query
        // construction, not needed here since piNameMatches already handles
        // token order and comma/period punctuation.
        const nsfPiName = line.replace(/.*Principal Investigator:\s*/i, "");
        isExactPIMatch = this.piNameMatches(nsfPiName, expectedPI);
      } else if (line.includes("Institution:")) {
        currentInstitutionLine = line.trim();
        currentInstitution = this.isolateInstitution(line);
      } else if (line.includes("Amount:") && currentAward) {
        currentAward += " | " + line.trim();
      }
    }

    // Don't forget the last award
    if (currentAward && isExactPIMatch) {
      awards.push({
        blob: `${currentAward} | ${currentPI} | ${currentInstitutionLine}`,
        institution: currentInstitution,
      });
    }

    return awards.slice(0, 5); // Limit to 5 most relevant
  }

  // Discriminating institution match: neither a hard equality check (which
  // misses punctuation-only differences between NSF and ACCESS spellings,
  // e.g. NSF's hyphenated "University of California-Berkeley" vs ACCESS's
  // comma-form "University of California, Berkeley") nor plain token-set
  // containment (which over-matches — "Purdue University"'s tokens
  // {purdue, university} are a subset of "Indiana University-Purdue
  // University Fort Wayne"'s tokens) is sufficient alone. This normalizes
  // punctuation (lowercase; hyphen/comma -> space; " at " stripped; collapse
  // whitespace) and then requires either normalized full-string equality OR
  // bidirectional equality of the DISTINCTIVE token sets (a small STOPWORDS
  // set dropped from both sides). Requiring the distinctive tokens to match
  // as a SET in both directions — not one-way containment — is what breaks
  // the over-match guards: "Middle" and "Indiana"/"Fort Wayne" are
  // distinctive tokens present on the NSF side but absent from the ACCESS
  // side, so the sets differ and the match fails, while the rescue cases
  // (pure punctuation differences) leave both sides with identical
  // distinctive-token sets.
  //
  // STOPWORDS discipline: a token belongs in STOPWORDS only if it NEVER
  // distinguishes two real institutions — "university"/"of"/"the"/"at"
  // qualify (no real institution pair differs solely by one having "the" or
  // "of" and the other not, in a way that matters here). "state" and
  // "college" do NOT qualify and must stay OUT: they are load-bearing in
  // whole families of distinct real institutions ("Ohio State University" vs
  // "Ohio University", "Michigan State" vs "University of Michigan",
  // "Boston College" vs "Boston University"). Dropping a distinguishing
  // token lets two different schools collapse onto the same distinctive-
  // token set and wrongly compare equal — the dangerous direction, since it
  // promotes a wrong award into the confident/primary tier.
  private validateInstitutionMatch(nsfInstitution: string, accessInstitution: string): boolean {
    const normalize = (s: string): string =>
      s
        .toLowerCase()
        .replace(/\bat\b/g, " ")
        .replace(/[-,]/g, " ")
        .replace(/\s+/g, " ")
        .trim();

    const nsfNormalized = normalize(nsfInstitution);
    const accessNormalized = normalize(accessInstitution);
    if (!nsfNormalized || !accessNormalized) {
      return false;
    }
    if (nsfNormalized === accessNormalized) {
      return true;
    }

    const STOPWORDS = new Set(["university", "of", "the", "at"]);
    const distinctiveTokens = (normalized: string): Set<string> =>
      new Set(normalized.split(" ").filter((t) => t.length > 0 && !STOPWORDS.has(t)));

    const nsfDistinctive = distinctiveTokens(nsfNormalized);
    const accessDistinctive = distinctiveTokens(accessNormalized);
    if (nsfDistinctive.size === 0 || accessDistinctive.size === 0) {
      return false;
    }
    if (nsfDistinctive.size !== accessDistinctive.size) {
      return false;
    }
    for (const token of nsfDistinctive) {
      if (!accessDistinctive.has(token)) {
        return false;
      }
    }
    return true;
  }

  // Analyze temporal alignment between NSF awards and ACCESS project
  private analyzeTemporalAlignment(
    nsfAwards: string[],
    accessStart: string,
    accessEnd: string
  ): string {
    if (nsfAwards.length === 0) {
      return "No awards to analyze for temporal alignment.";
    }

    let analysis = "";
    const accessStartYear = new Date(accessStart).getFullYear();
    const accessEndYear = new Date(accessEnd).getFullYear();

    nsfAwards.forEach((award, index) => {
      // Try to extract dates from award text (this is approximate since NSF format varies)
      const yearMatches = award.match(/(\d{4})/g);
      if (yearMatches && yearMatches.length > 0) {
        const awardYears = yearMatches
          .map((y) => parseInt(y))
          .filter((y) => y >= 2000 && y <= 2030);
        const overlap = awardYears.some((year) => year >= accessStartYear && year <= accessEndYear);

        analysis += `• **Award ${index + 1}:** `;
        if (overlap) {
          analysis += `✅ Temporal overlap detected (${awardYears.join(", ")})\n`;
        } else {
          analysis += `⚠️ No clear temporal overlap (${awardYears.join(", ")} vs ${accessStartYear}-${accessEndYear})\n`;
        }
      } else {
        analysis += `• **Award ${index + 1}:** Unable to extract award dates for comparison\n`;
      }
    });

    return analysis;
  }

  private async findFundedProjects(piName?: string, fieldOfScience?: string, limit: number = 10) {
    // Input validation
    if (limit < 1 || limit > 50) {
      throw new Error("Limit must be between 1 and 50");
    }

    if (piName && piName.trim().length < 3) {
      throw new Error("PI name must be at least 3 characters");
    }

    // Note: an `institution` argument is handled upstream by
    // institutionalFundingProfile (analyzeFundingRouter), so it never reaches
    // this method; the institution path is not duplicated here.
    try {
      // Step 1: Get ACCESS projects
      let accessProjects: Project[] = [];
      let searchQuery = "";
      const searchMetadata = {
        piNameVariations: [] as string[],
      };

      if (piName) {
        // Generate name variations for better matching
        searchMetadata.piNameVariations = this.generatePINameVariations(piName);

        // Search for projects by PI name, filtering by field if specified
        accessProjects = await this.searchProjectsByPIName(piName, fieldOfScience, limit * 2);
        searchQuery += `PI: ${piName}`;
        if (fieldOfScience) searchQuery += `, Field: ${fieldOfScience}`;
      } else if (fieldOfScience) {
        // This should work correctly now
        accessProjects = await this.getProjectsByField(fieldOfScience, limit * 2);
        searchQuery += `Field: ${fieldOfScience}`;
      } else {
        accessProjects = await this.getTopProjects(limit);
        searchQuery = "Top ACCESS projects across all fields";
      }

      // Step 2: For each ACCESS project PI, find corresponding NSF awards
      const fundedProjectCorrelations = await this.crossReferenceWithNSF(accessProjects, limit);

      // Step 3: Build comprehensive result
      let result = `🎯 **Funded Projects Analysis**\n\n`;
      result += `**Search Criteria:** ${searchQuery}\n`;
      result += `**Projects Found:** ${accessProjects.length} ACCESS projects\n`;

      // Add search metadata if available
      if (searchMetadata.piNameVariations.length > 0) {
        result += `**Name Variations Tried:** ${Math.min(searchMetadata.piNameVariations.length, 5)} format(s)\n`;
      }
      result += `\n`;

      if (fundedProjectCorrelations.length === 0) {
        result += `**🏛️ ACCESS Projects (${fieldOfScience || "All Fields"}):**\n`;
        result += this.formatProjectSummaries(accessProjects.slice(0, limit));
        result += `\n\n**🏆 NSF Funding Status:**\n`;
        result += `✅ **No NSF awards found** for these PIs after trying multiple name format variations.\n\n`;
        result += `**💡 What this means:**\n`;
        result += `• Advanced name matching tried multiple formats (First Last, Last First, with/without initials, etc.)\n`;
        result += `• Results are filtered to primary institutions only (collaborations excluded)\n`;
        result += `• If you expected to find awards, this could indicate:\n`;
        result += `  - PIs may have NSF funding under different name spellings\n`;
        result += `  - Projects funded by other federal agencies (DOE, NIH, NASA, etc.)\n`;
        result += `  - Exploratory/startup allocations without federal grant backing\n`;
        result += `  - Early-career researchers or industry collaborations\n`;
        result += `  - Institution name changes or department-level variations\n\n`;
        result += `**🔍 Troubleshooting Tips:**\n`;
        result += `• Try searching by individual PI name for detailed matching\n`;
        result += `• Use analyze_project_funding() with specific project ID for detailed analysis\n`;
        result += `• Check if institution appears under different official names\n`;
      } else {
        result += `**🔗 Cross-Referenced Funded Projects:**\n\n`;
        let confirmedProjectCount = 0;
        fundedProjectCorrelations.forEach((correlation, index) => {
          result += `**${index + 1}. ${correlation.accessProject.requestTitle}**\n`;
          result += `• **ACCESS PI:** ${correlation.accessProject.pi} (${correlation.accessProject.piInstitution})\n`;
          result += `• **Field:** ${correlation.accessProject.fos}\n`;
          result += `• **Resources:** ${this.summarizeResources(correlation.accessProject.resources)}\n`;
          result += this.renderNSFFundingTiers(correlation);
          if (correlation.confirmedAwards.length > 0) {
            confirmedProjectCount++;
          }
          result += `\n`;
        });

        result += `**📊 Correlation Insights:**\n`;
        result += `• **${confirmedProjectCount}** projects with confirmed NSF funding\n`;
        result += `• Cross-platform funding indicates sustained research programs\n`;
        result += `• ACCESS resources support federally-funded computational research\n`;
        result += `• Strong correlation suggests effective resource allocation\n`;
      }

      return {
        content: [
          {
            type: "text" as const,
            text: result,
          },
        ],
      };
    } catch (error) {
      const authError = this.drupalAuthError(error);
      if (authError) return authError;
      return this.errorResponse(`Error finding funded projects: ${handleApiError(error)}`);
    }
  }

  // Renders one correlation's confirmedAwards/nameOnlyAwards as two
  // structurally separate blocks — the laundering-defense surface. The LLM
  // consumer of this text launders hedges ("possible match" -> "is
  // funded"), so the defense is structural, not wording:
  //
  //  - PRIMARY (confirmed) block is the ONLY place award identifiers,
  //    institutions, or numbers appear. It only renders when
  //    confirmedAwards is non-empty, and its header names the ACCESS PI and
  //    the confirmed award's institution — a confident claim, because it IS
  //    confirmed (Task 3's validateInstitutionMatch discriminated it).
  //  - SECONDARY (name-only) block is deliberately LOSSY: a single fixed
  //    conclusion sentence, never interpolated with the count, titles,
  //    award numbers, or institutions of the name-only awards. Below the
  //    suppress cap (SUPPRESS_CAP name-only awards or fewer) it still
  //    states the same "treat as no confirmed funding" conclusion; above
  //    the cap it collapses to a single fixed suppression string with zero
  //    award data. Either way, no per-award content ever reaches this
  //    block — lossy is the point.
  //  - CONFIRMED = 0 (the common case) degrades the header to a safe,
  //    unhedged "no confirmed funding" message and never emits a
  //    "0 confirmed, N possible" style count — a count is itself a
  //    re-laundering vector ("2 possible matches" reads as evidence).
  private renderNSFFundingTiers(correlation: {
    accessProject: Project;
    confirmedAwards: NSFAward[];
    nameOnlyAwards: NSFAward[];
  }): string {
    const SUPPRESS_CAP = 3;
    let out = "";

    if (correlation.confirmedAwards.length > 0) {
      const confirmedInstitution = correlation.confirmedAwards[0].institution;
      out += `• **NSF award(s) confirmed for ${correlation.accessProject.pi} at ${confirmedInstitution}:**\n`;
      correlation.confirmedAwards.forEach((award) => {
        out += `  - ${award.blob}\n`;
      });
    } else {
      out += `• **No confirmed NSF funding found for this PI.**\n`;
    }

    if (correlation.nameOnlyAwards.length > SUPPRESS_CAP) {
      out += `• common name — namesake matches suppressed\n`;
    } else if (correlation.nameOnlyAwards.length > 0) {
      out += `• These are unconfirmed namesake matches only (different institution). Treat as no confirmed NSF funding for this PI.\n`;
    }

    return out;
  }

  // Helper method to get projects by field directly
  private async getProjectsByField(fieldOfScience: string, limit: number): Promise<Project[]> {
    const { records } = await this.ensureCorpus();
    return records
      .filter((project) => project.fos.toLowerCase().includes(fieldOfScience.toLowerCase()))
      .slice(0, limit);
  }

  // Helper method to get top projects
  private async getTopProjects(limit: number): Promise<Project[]> {
    const { records } = await this.ensureCorpus();
    return records.slice(0, limit);
  }

  // Helper method to search projects by PI name
  private async searchProjectsByPIName(
    piName: string,
    fieldOfScience?: string,
    limit: number = 20
  ): Promise<Project[]> {
    const { records } = await this.ensureCorpus();
    return records
      .filter((project) => {
        const piMatch = project.pi.toLowerCase().includes(piName.toLowerCase());
        const fieldMatch =
          !fieldOfScience || project.fos.toLowerCase().includes(fieldOfScience.toLowerCase());
        return piMatch && fieldMatch;
      })
      .slice(0, limit);
  }

  // Core cross-referencing logic.
  //
  // Confirmed matches (validateInstitutionMatch true) are the primary,
  // authoritative tier; name-only matches are a lossy secondary tier. We
  // must not let `limit` cut the batch scan or the correlations array
  // before confirmed-vs-name-only ranking happens, or a name-only match
  // earlier in `accessProjects` order can consume a slot and starve a
  // later institution-confirmed match out of the results entirely. So:
  // scan ALL projects (no early exit on correlations.length < limit),
  // partition each project's awards into confirmedAwards/nameOnlyAwards,
  // rank institution-confirmed correlations before name-only ones, THEN
  // slice to `limit`.
  private async crossReferenceWithNSF(
    accessProjects: Project[],
    limit: number
  ): Promise<
    Array<{
      accessProject: Project;
      confirmedAwards: NSFAward[];
      nameOnlyAwards: NSFAward[];
    }>
  > {
    const correlations: Array<{
      accessProject: Project;
      confirmedAwards: NSFAward[];
      nameOnlyAwards: NSFAward[];
    }> = [];

    // Process projects in batches to avoid overwhelming the NSF server.
    // No limit-based early exit here: ranking confirmed-before-name-only
    // must see every candidate before the batch limit is applied below.
    const batchSize = 5;
    for (let i = 0; i < accessProjects.length; i += batchSize) {
      const batch = accessProjects.slice(i, i + batchSize);

      for (const project of batch) {
        try {
          // Search for NSF awards by PI name
          const nsfData = (await this.callRemoteServer("nsf-awards", "search_nsf_awards", {
            personnel: this.normalizePIQuery(project.pi),
            limit: 3,
          })) as { content?: Array<{ text?: string }> };
          const nsfResponse = this.formatNsfResponse(nsfData);

          // Parse NSF response to extract award summaries
          const nsfAwards = this.parseNSFResponse(nsfResponse, project.pi);

          if (nsfAwards.length > 0) {
            // Partition before any slicing: confirmed matches must not be
            // pushed out by name-only ones even within a single PI's awards.
            const confirmedAwards = nsfAwards.filter((award) =>
              this.validateInstitutionMatch(award.institution, project.piInstitution)
            );
            const nameOnlyAwards = nsfAwards.filter(
              (award) => !this.validateInstitutionMatch(award.institution, project.piInstitution)
            );
            correlations.push({
              accessProject: project,
              confirmedAwards,
              nameOnlyAwards,
            });
          }

          // Add small delay to be respectful to NSF server
          if (i % 3 === 0) {
            await new Promise((resolve) => setTimeout(resolve, 100));
          }
        } catch (error) {
          console.warn(`Error checking NSF funding for ${project.pi}:`, error);
        }
      }
    }

    // Rank institution-confirmed correlations before name-only ones, THEN
    // cut to `limit` — so a name-only match never starves a confirmed
    // match out of the returned set. Array.sort is stable (ES2019+), so
    // relative project order is preserved within each tier.
    const ranked = correlations
      .slice()
      .sort((a, b) => {
        const aConfirmed = a.confirmedAwards.length > 0 ? 0 : 1;
        const bConfirmed = b.confirmedAwards.length > 0 ? 0 : 1;
        return aConfirmed - bConfirmed;
      });

    return ranked.slice(0, limit);
  }

  // Parse NSF server response and extract relevant awards
  private parseNSFResponse(nsfResponse: string, expectedPI: string): NSFAward[] {
    if (!nsfResponse || nsfResponse.includes("not available") || nsfResponse.includes("Error")) {
      return [];
    }

    const awards: NSFAward[] = [];
    const lines = nsfResponse.split("\n");

    let currentAward = "";
    let currentInstitution = "";
    let isRelevant = false;

    for (const line of lines) {
      if (line.includes("Award Number:") || line.includes("Title:")) {
        if (currentAward && isRelevant) {
          awards.push({ blob: currentAward, institution: currentInstitution });
        }
        currentAward = line.trim();
        currentInstitution = "";
        isRelevant = false;
      } else if (line.includes("Principal Investigator:")) {
        currentAward += " | " + line.trim();
        // Token/word-boundary name match (not raw substring — see
        // piNameMatches). The prior gate matched on ANY name-part as a
        // substring, which floods on both forward ("Matthew Long" inside
        // "Matthew Longstreet") and reverse (any short surname-only NSF PI
        // string) substrings.
        const nsfPiName = line.replace(/.*Principal Investigator:\s*/i, "");
        isRelevant = this.piNameMatches(nsfPiName, expectedPI);
      } else if (line.includes("Institution:") && currentAward) {
        currentAward += " | " + line.trim();
        currentInstitution = this.isolateInstitution(line);
      } else if (line.includes("Amount:") && currentAward) {
        currentAward += " | " + line.trim();
        if (isRelevant) {
          awards.push({ blob: currentAward, institution: currentInstitution });
          currentAward = "";
          currentInstitution = "";
          isRelevant = false;
        }
      }
    }

    return awards.slice(0, 3); // Limit to 3 most relevant awards
  }

  // Helper methods for formatting
  private formatProjectSummaries(projects: Project[]): string {
    return projects
      .map((project, index) => {
        const resources = this.summarizeResources(project.resources);
        return `${index + 1}. **${project.requestTitle}** (${project.pi}, ${project.piInstitution})\n   Resources: ${resources}`;
      })
      .join("\n");
  }

  private summarizeResources(resources: AllocationResource[]): string {
    if (resources.length === 0) return "None specified";
    return (
      resources
        .slice(0, 2)
        .map((r) => {
          const allocation = this.formatAllocation(r.allocation || 0, r.units, r.resourceName);
          return allocation || r.resourceName;
        })
        .join(", ") + (resources.length > 2 ? ` +${resources.length - 2} more` : "")
    );
  }

  /**
   * The controlled institution vocabulary: the distinct piInstitution values in
   * the resident corpus. Every project's institution is a verbatim member, so
   * this is the exact set to resolve a query against — and it only ever contains
   * institutions that actually have projects. Derived from the corpus already in
   * memory (no extra fetch).
   */
  private async institutionVocab(): Promise<string[]> {
    const { records } = await this.ensureCorpus();
    return [...new Set(records.map((p) => p.piInstitution))];
  }

  /**
   * Name forms to query the NSF award API with. NSF awardee names are free text
   * with no controlled vocabulary, so we try light punctuation normalizations of
   * the canonical name: comma-stripped, hyphen-stripped, and "at"-stripped.
   * These bridge only punctuation differences — they do NOT reach NSF's
   * acronym awardee spellings (e.g. "UC Berkeley"), so NSF recall is
   * best-effort (tracked as a follow-up). Deliberately does NOT generate the
   * "University of X" <-> "X University" swap, which manufactures matches to
   * genuinely different institutions.
   */
  private nsfQueryVariants(canonical: string): string[] {
    const variants = new Set<string>([canonical]);
    // "University of California, Berkeley" -> "University of California Berkeley"
    variants.add(canonical.replace(/,\s*/g, " ").replace(/\s+/g, " ").trim());
    // "University of Texas at Austin" -> "University of Texas Austin"
    variants.add(canonical.replace(/\s+at\s+/gi, " "));
    // "University of Illinois Urbana-Champaign" -> "University of Illinois Urbana Champaign"
    variants.add(canonical.replace(/-/g, " ").replace(/\s+/g, " ").trim());
    return [...variants].filter((v) => v.length > 0);
  }

  /**
   * A query matched several institutions and no single one exactly. Return the
   * candidate list so the caller (the tool-calling agent) re-queries a specific
   * institution rather than the tool profiling the wrong one.
   */
  private institutionDisambiguation(query: string, candidates: string[]) {
    let text = `Multiple institutions match "${query}". Please specify one of:\n`;
    for (const c of candidates) text += `• ${c}\n`;
    if (candidates.length === 0) {
      text = `No ACCESS institution matches "${query}". Check the spelling, or try the full institution name.\n`;
    }
    return { content: [{ type: "text" as const, text }] };
  }

  /**
   * A funding profile for one institution, resolved against the controlled vocab.
   * An exact/unambiguous query is profiled; an ambiguous one (e.g. "Texas A&M"
   * matching several campuses) returns a disambiguation list so the caller picks
   * a specific campus rather than the tool guessing and reporting the wrong one.
   */
  private async institutionalFundingProfile(institutionName: string, limit: number = 20) {
    // Input validation
    if (
      !institutionName ||
      typeof institutionName !== "string" ||
      institutionName.trim().length === 0
    ) {
      throw new Error("Institution name must be a non-empty string");
    }

    if (limit < 1 || limit > 100) {
      throw new Error("Limit must be between 1 and 100");
    }

    try {
      // Step 1: Resolve the free-text query to a canonical vocabulary entry.
      const resolution = resolveInstitution(
        institutionName,
        await this.institutionVocab(),
        ACCESS_INSTITUTION_ALIASES,
      );
      if (!resolution.resolved) {
        return this.institutionDisambiguation(institutionName, resolution.candidates);
      }
      const canonical = resolution.resolved;

      // Step 2: Exact-join the corpus on the resolved institution.
      const { records } = await this.ensureCorpus();
      const accessProjects = records
        .filter((p) => p.piInstitution === canonical)
        .slice(0, limit * 2);

      // Step 3: Get NSF awards for the resolved institution. NSF awardee names
      // are free text (no controlled vocab), so query a few name variants — but
      // NOT the "University of X" <-> "X University" swap, which manufactures
      // cross-institution false positives.
      const nsfVariants = this.nsfQueryVariants(canonical);
      const nsfAwardsByVariant = new Map<string, string>();
      let totalNSFAwards = 0;

      for (const variant of nsfVariants.slice(0, 3)) {
        try {
          // Use primary_only parameter - filtering now handled by NSF server
          const nsfData = (await this.callRemoteServer("nsf-awards", "search_nsf_awards", {
            institution: variant,
            limit: Math.ceil(limit / 2),
            primary_only: true, // Filter at source for cleaner architecture
          })) as { content?: Array<{ text?: string }> };
          const nsfResponse = this.formatNsfResponse(nsfData);

          if (
            nsfResponse &&
            !nsfResponse.includes("Error") &&
            !nsfResponse.includes("not available")
          ) {
            nsfAwardsByVariant.set(variant, nsfResponse);
            const awardCount = (nsfResponse.match(/Award Number:/g) || []).length;
            totalNSFAwards += awardCount;
          }
        } catch (error) {
          console.warn(`Error fetching NSF data for variant "${variant}":`, error);
        }
      }

      // Step 4: Cross-reference ACCESS PIs with NSF awards
      const piCrossReference = await this.crossReferenceInstitutionPIs(accessProjects);

      // Step 5: Build comprehensive result
      let result = `🏛️ **Institutional Funding Profile: ${institutionName}**\n\n`;

      // Institution matching info
      result += `**🎯 Institution Matching:**\n`;
      result += `• **Resolved To:** ${canonical}\n\n`;

      // ACCESS Projects Section
      result += `**📊 ACCESS Computational Allocations (${accessProjects.length} projects):**\n`;
      if (accessProjects.length > 0) {
        result += this.formatInstitutionalAccessProjects(accessProjects.slice(0, limit));

        // Resource summary
        const resourceStats = this.analyzeInstitutionalResources(accessProjects);
        result += `\n**Resource Portfolio:**\n${resourceStats}\n`;
      } else {
        result += `No current ACCESS projects found for ${canonical}.\n`;
      }

      // NSF Awards Section (CRITICAL FIX: Now filtered by primary institution only)
      result += `\n**🏆 NSF Research Portfolio (${totalNSFAwards} primary awards found):**\n`;
      result += `*Note: Only showing awards where ${institutionName} is the PRIMARY recipient institution*\n\n`;

      if (nsfAwardsByVariant.size > 0) {
        for (const [variant, awards] of nsfAwardsByVariant) {
          result += `\n*${variant}:*\n${awards}\n`;
        }
      } else {
        result += `✅ **No NSF awards found where "${institutionName}" is the primary recipient.**\n\n`;
        result += `**💡 What this means:**\n`;
        result += `• These results are filtered to show ONLY awards where this institution is the primary recipient\n`;
        result += `• Collaborations and co-PI mentions are excluded to ensure accuracy\n`;
        result += `• If you expected to see awards, this could indicate:\n`;
        result += `  - Awards under department/college names instead of university name\n`;
        result += `  - Recent institutional name changes or mergers\n`;
        result += `  - Awards may be under affiliated research centers\n\n`;
        result += `**🔍 Alternative Search Options:**\n`;
        result += `• Search by specific PI names from ACCESS projects\n`;
        result += `• Try department-specific searches (e.g., "Computer Science Dept, ${institutionName}")\n`;
        result += `• Check for institution name variations in NSF databases\n`;
      }

      // Cross-reference analysis
      result += `\n**🔗 Cross-Platform Analysis:**\n`;
      if (piCrossReference.matches > 0) {
        result += `• **${piCrossReference.matches}** ACCESS PIs have identifiable NSF awards\n`;
        result += `• **Strong institutional research profile** with federal funding\n`;
        result += `• ACCESS resources effectively supporting NSF-funded research\n`;
        result += piCrossReference.details;
      } else {
        result += `• No direct PI matches found between ACCESS and NSF databases\n`;
        result += `• This may indicate:\n`;
        result += `  - Different name formats between systems\n`;
        result += `  - Recent hiring/institutional changes\n`;
        result += `  - Computational vs. experimental research focus\n`;
      }

      // Strategic insights
      result += `\n**📈 Strategic Insights:**\n`;
      result += `• **Computational Capacity:** ${accessProjects.length} active ACCESS allocations\n`;
      result += `• **Federal Funding:** ${totalNSFAwards} NSF awards across institution variants\n`;
      result += `• **Research Diversity:** ${this.getUniqueFieldsCount(accessProjects)} fields of science represented\n`;
      result += `• **Resource Utilization:** Multi-resource computational research programs\n`;

      return {
        content: [
          {
            type: "text" as const,
            text: result,
          },
        ],
      };
    } catch (error) {
      const authError = this.drupalAuthError(error);
      if (authError) return authError;
      return this.errorResponse(
        `Error generating institutional funding profile: ${handleApiError(error)}`
      );
    }
  }

  private formatInstitutionalAccessProjects(projects: Project[]): string {
    const grouped = new Map<string, Project[]>();
    projects.forEach((project) => {
      const field = project.fos;
      if (!grouped.has(field)) grouped.set(field, []);
      grouped.get(field)!.push(project);
    });

    let result = "";
    Array.from(grouped.entries())
      .slice(0, 5)
      .forEach(([field, fieldProjects]) => {
        result += `\n**${field} (${fieldProjects.length} projects):**\n`;
        fieldProjects.slice(0, 3).forEach((project) => {
          const resources = this.summarizeResources(project.resources);
          result += `• ${project.requestTitle} (${project.pi}) - ${resources}\n`;
        });
        if (fieldProjects.length > 3) {
          result += `  ... and ${fieldProjects.length - 3} more projects\n`;
        }
      });

    return result;
  }

  private analyzeInstitutionalResources(projects: Project[]): string {
    const resourceCounts = new Map<string, number>();

    projects.forEach((project) => {
      project.resources.forEach((resource) => {
        resourceCounts.set(
          resource.resourceName,
          (resourceCounts.get(resource.resourceName) || 0) + 1
        );
      });
    });

    const topResources = Array.from(resourceCounts.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5);

    let result = "";
    topResources.forEach(([resource, count]) => {
      result += `• **${resource}:** ${count} allocations\n`;
    });

    return result;
  }

  private async crossReferenceInstitutionPIs(accessProjects: Project[]): Promise<{
    matches: number;
    details: string;
  }> {
    let matches = 0;
    let details = "\n**PI Cross-Reference Details:**\n";

    for (const project of accessProjects.slice(0, 10)) {
      // Limit to first 10 for performance
      try {
        const nsfData = (await this.callRemoteServer("nsf-awards", "search_nsf_awards", {
          personnel: this.normalizePIQuery(project.pi),
          limit: 2,
        })) as { content?: Array<{ text?: string }> };
        const nsfResponse = this.formatNsfResponse(nsfData);

        if (
          nsfResponse &&
          !nsfResponse.includes("Error") &&
          !nsfResponse.includes("not available")
        ) {
          const relevantAwards = this.parseNSFResponse(nsfResponse, project.pi);
          if (relevantAwards.length > 0) {
            matches++;
            details += `• **${project.pi}:** ${relevantAwards.length} NSF award(s) - ${project.fos}\n`;
          }
        }

        // Small delay to be respectful
        if (matches % 3 === 0) {
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
      } catch (error) {
        console.warn(`Error cross-referencing ${project.pi}:`, error);
      }
    }

    return { matches, details };
  }

  private getUniqueFieldsCount(projects: Project[]): number {
    const fields = new Set(projects.map((p) => p.fos));
    return fields.size;
  }

  // Helper method to format NSF server responses
  private formatNsfResponse(response: { content?: Array<{ text?: string }> }): string {
    if (response.content && response.content[0] && response.content[0].text) {
      return response.content[0].text;
    }
    return JSON.stringify(response);
  }

}
