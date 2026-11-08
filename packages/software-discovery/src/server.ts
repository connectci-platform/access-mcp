import {
  BaseAccessServer,
  handleApiError,
  projectFields,
  normalizeGlobalResourceId,
  buildPagination,
  Resource,
  CallToolResult,
  type ToolWithAccess,
} from "@access-mcp/shared";
import {
  CallToolRequest,
  ReadResourceRequest,
  ReadResourceResult,
} from "@modelcontextprotocol/sdk/types.js";
import axios, { AxiosInstance } from "axios";
import { createRequire } from "module";
const require = createRequire(import.meta.url);
const { version } = require("../package.json");

interface SoftwareQueryParams {
  software?: string[];
  rps?: string[];
  columns?: string[];
  exclude?: boolean;
  fuzz_software?: boolean;
  fuzz_rp?: boolean;
  collapse_resource_groups?: boolean;
}

interface RpInfo {
  rp_name: string;
  rp_resource_id: string[];
  software_versions: string[]; // API returns sorted array, first item is latest
  rp_software_documentation?: string;
}

interface SoftwareItem {
  software_name: string;
  software_description?: string;
  software_web_page?: string;
  software_documentation?: string;
  software_use_link?: string;
  rps?: Record<string, RpInfo>;
  ai_description?: string;
  ai_general_tags?: string;
  ai_research_area?: string;
  ai_research_discipline?: string;
  ai_research_field?: string;
  ai_software_type?: string;
  ai_software_class?: string;
  ai_core_features?: string;
  ai_example_use?: string;
}

interface ApiResponse {
  data: SoftwareItem[];
}

interface TransformedSoftware {
  name: string;
  description: string | null;
  versions: string[];
  documentation: string | null;
  website: string | null;
  usage_link: string | null;
  available_on_resources: string[];
  resource_ids: string[];
  versions_by_resource?: Record<string, string[]>;
  ai_metadata?: {
    description: string | null;
    tags: string[];
    research_area: string | null;
    research_discipline: string | null;
    research_field: string | null;
    software_type: string | null;
    software_class: string | null;
    core_features: string | null;
    example_use: string | null;
  };
}

interface SoftwareComparison {
  software: string;
  found: boolean;
  available_on: string[];
  resource_count: number;
  resource_status: Record<string, ResourceStatus>;
}

type ResourceStatus = "listed" | "not_listed" | "not_indexed" | "lookup_failed";
type Coverage = "indexed" | "not_indexed" | "lookup_failed";

const GAP_NOTE =
  "not_listed means the package isn't in that resource's software list, not that it can't be used. " +
  "not_indexed means no software list exists for that resource, so nothing is known about its software. " +
  "lookup_failed means the check for that resource's list failed. " +
  "None of these mean the software is unavailable; point the user to the resource's documentation or support.";

/** "anvil.purdue.access-ci.org" and "Bridges2" read as "anvil" and "bridges2". */
function resourceKey(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .split(".")[0]
    .replace(/[^a-z0-9]/g, "");
}

/**
 * Whether a requested resource is one the index returned. Fuzzy resource
 * matching means "delta" brings back "deltaai" too, so a prefix either way
 * counts. The fullscreen client's grid uses the same rule.
 */
function sameResource(requested: string, found: string): boolean {
  const r = resourceKey(requested);
  const f = resourceKey(found);
  return r !== "" && (f === r || f.startsWith(r) || r.startsWith(f));
}

// Argument types for tool methods
interface SearchSoftwareArgs {
  query?: string;
  resource?: string;
  fuzzy?: boolean;
  include_ai_metadata?: boolean;
  limit?: number;
  offset?: number;
  fields?: string[];
}

interface ListAllSoftwareArgs {
  resource?: string;
  include_ai_metadata?: boolean;
  limit?: number;
  offset?: number;
  fields?: string[];
}

interface GetSoftwareDetailsArgs {
  software_name: string;
  resource?: string;
  fuzzy?: boolean;
}

interface CompareSoftwareAvailabilityArgs {
  software_names: string[];
  resources?: string[];
}

export class SoftwareDiscoveryServer extends BaseAccessServer {
  private _sdsClient?: AxiosInstance;

  constructor() {
    super("access-mcp-software-discovery", version, "https://sds-ara-api.access-ci.org");
  }

  protected listingLinks(
    context: "list" | "search" | "details" = "list"
  ): Record<string, string> | undefined {
    if (context === "list" || context === "search") {
      return { see_all_url: "https://sds.access-ci.org/" };
    }
    return undefined;
  }

  protected get sdsClient(): AxiosInstance {
    if (!this._sdsClient) {
      const apiKey = process.env.SDS_API_KEY || process.env.VITE_SDS_API_KEY;

      this._sdsClient = axios.create({
        baseURL: "https://sds-ara-api.access-ci.org",
        timeout: 30000,
        headers: {
          "Content-Type": "application/json",
          "User-Agent": `access-mcp-software-discovery/${version}`,
          ...(apiKey ? { "X-API-Key": apiKey } : {}),
        },
        validateStatus: () => true,
      });
    }
    return this._sdsClient;
  }

  /**
   * Makes a query to the new SDS API v1
   */
  private async queryApi(params: SoftwareQueryParams): Promise<SoftwareItem[]> {
    const apiKey = process.env.SDS_API_KEY || process.env.VITE_SDS_API_KEY;

    if (!apiKey) {
      throw new Error("SDS API key not configured. Set SDS_API_KEY environment variable.");
    }

    const response = await this.sdsClient.post("/api/v1", params);

    // Treat 404 as "no results found" - the SDS API returns 404 when query/resource
    // combination yields no matches, rather than returning an empty result set
    if (response.status === 404) {
      return [];
    }

    if (response.status !== 200) {
      throw new Error(`SDS API error: ${response.status}`);
    }

    // Handle the new API response format: { data: [...] }
    const responseData = response.data as ApiResponse | SoftwareItem[];
    if ("data" in responseData && Array.isArray(responseData.data)) {
      return responseData.data;
    }
    return Array.isArray(responseData) ? responseData : [];
  }

  protected getTools(): ToolWithAccess[] {
    return [
      {
        name: "search_software",
        mutates: false,
        description:
          "Search software packages on ACCESS-CI HPC resources with fuzzy matching. Returns {total, items}.",
        inputSchema: {
          type: "object",
          properties: {
            query: {
              type: "string",
              description:
                "Software name to search (e.g., 'python', 'tensorflow', 'gromacs'). Fuzzy matching finds partial matches.",
            },
            resource: {
              type: "string",
              description:
                "Filter to resource (e.g., 'anvil', 'deltaai', 'expanse', 'bridges-2'). Note: not all resources are fully indexed — use compare_software_availability to check coverage.",
            },
            fuzzy: {
              type: "boolean",
              description: "Enable fuzzy/partial matching (default: true)",
              default: true,
            },
            include_ai_metadata: {
              type: "boolean",
              description: "Include AI metadata (tags, research area, software type)",
              default: false,
            },
            limit: {
              type: "number",
              description: "Max results (default: 100)",
              default: 100,
            },
            offset: {
              type: "number",
              description:
                "Number of results to skip, for paging past the first `limit`. Default 0.",
            },
            fields: {
              type: "array",
              items: { type: "string" },
              description:
                "Project the response down to only these fields. Dotted path syntax: 'total', 'items[].software_name', 'items[].rps', 'metadata.pagination.has_more', etc. Use to reduce payload size when you only need specific fields. Omit to receive the full response.",
            },
          },
          examples: [
            {
              name: "Search for Python",
              arguments: { query: "python", limit: 10 },
            },
            {
              name: "Find TensorFlow on Anvil",
              arguments: { query: "tensorflow", resource: "anvil" },
            },
            {
              name: "Search MPI libraries on DeltaAI",
              arguments: { query: "mpi", resource: "deltaai", limit: 20 },
            },
          ],
        },
        _meta: {
          supportsFieldProjection: true,
        },
      },
      {
        name: "list_all_software",
        mutates: false,
        description:
          "List all available software packages on ACCESS-CI resources. Returns {total, items}.",
        inputSchema: {
          type: "object",
          properties: {
            resource: {
              type: "string",
              description:
                "Filter to resource (e.g., 'anvil', 'deltaai', 'expanse', 'bridges-2'). Note: not all resources are fully indexed — use compare_software_availability to check coverage.",
            },
            include_ai_metadata: {
              type: "boolean",
              description: "Include AI metadata (default: false for compact output)",
              default: false,
            },
            limit: {
              type: "number",
              description: "Max results (default: 100)",
              default: 100,
            },
            offset: {
              type: "number",
              description:
                "Number of results to skip, for paging past the first `limit`. Default 0.",
            },
            fields: {
              type: "array",
              items: { type: "string" },
              description:
                "Project the response down to only these fields. Dotted path syntax: 'total', 'items[].software_name', 'metadata.pagination.has_more', etc. Use to reduce payload size when you only need specific fields. Omit to receive the full response.",
            },
          },
          examples: [
            {
              name: "List all software",
              arguments: { limit: 50 },
            },
            {
              name: "List software on DeltaAI",
              arguments: { resource: "deltaai", limit: 100 },
            },
          ],
        },
        _meta: {
          supportsFieldProjection: true,
        },
      },
      {
        name: "get_software_details",
        mutates: false,
        description:
          "Get detailed info about a specific software package including versions and availability. Returns {found, details, other_matches}.",
        inputSchema: {
          type: "object",
          properties: {
            software_name: {
              type: "string",
              description: "Software name (e.g., 'tensorflow', 'gromacs', 'python')",
            },
            resource: {
              type: "string",
              description:
                "Filter to resource (e.g., 'anvil', 'deltaai', 'expanse', 'bridges-2'). Note: not all resources are fully indexed — use compare_software_availability to check coverage.",
            },
            fuzzy: {
              type: "boolean",
              description: "Enable fuzzy matching (default: true)",
              default: true,
            },
          },
          required: ["software_name"],
          examples: [
            {
              name: "Get TensorFlow details",
              arguments: { software_name: "tensorflow" },
            },
            {
              name: "Get GROMACS on Expanse",
              arguments: { software_name: "gromacs", resource: "expanse" },
            },
          ],
        },
      },
      {
        name: "compare_software_availability",
        mutates: false,
        description:
          "Compare availability of multiple software packages across resources. Returns {comparison, summary, gap_note}. Each comparison row has resource_status per resource: listed, not_listed, not_indexed or lookup_failed. Only listed says the software is there; a gap never means it is unavailable.",
        inputSchema: {
          type: "object",
          properties: {
            software_names: {
              type: "array",
              items: { type: "string" },
              description: "Software packages to compare (e.g., ['tensorflow', 'pytorch'])",
            },
            resources: {
              type: "array",
              items: { type: "string" },
              description:
                "Resources to check (optional). If omitted, compares across all currently indexed resources only (not all ACCESS resources are indexed).",
            },
          },
          required: ["software_names"],
          examples: [
            {
              name: "Compare ML frameworks",
              arguments: { software_names: ["tensorflow", "pytorch", "cuda"] },
            },
            {
              name: "Check compilers on specific resources",
              arguments: {
                software_names: ["gcc", "intel", "nvhpc"],
                resources: ["anvil", "deltaai", "expanse"],
              },
            },
          ],
        },
      },
    ];
  }

  protected getResources(): Resource[] {
    return [
      {
        uri: "accessci://software-discovery",
        name: "ACCESS-CI Software Discovery Service",
        description: "Search and discover software packages available on ACCESS-CI resources",
        mimeType: "application/json",
      },
      {
        uri: "accessci://software/categories",
        name: "Software Filter Values",
        description: "Discover available filter values from actual software data",
        mimeType: "application/json",
      },
    ];
  }

  protected async handleToolCall(request: CallToolRequest): Promise<CallToolResult> {
    const { name, arguments: args = {} } = request.params;

    try {
      switch (name) {
        case "search_software":
          return await this.searchSoftware(args as SearchSoftwareArgs);
        case "list_all_software":
          return await this.listAllSoftware(args as ListAllSoftwareArgs);
        case "get_software_details":
          return await this.getSoftwareDetails(args as unknown as GetSoftwareDetailsArgs);
        case "compare_software_availability":
          return await this.compareSoftwareAvailability(
            args as unknown as CompareSoftwareAvailabilityArgs
          );
        default:
          return this.errorResponse(`Unknown tool: ${name}`);
      }
    } catch (error) {
      return this.errorResponse(handleApiError(error));
    }
  }

  protected async handleResourceRead(request: ReadResourceRequest): Promise<ReadResourceResult> {
    const { uri } = request.params;

    switch (uri) {
      case "accessci://software-discovery":
        return {
          contents: [
            {
              uri,
              mimeType: "text/plain",
              text: "ACCESS-CI Software Discovery Service - Search and discover software packages available on ACCESS-CI resources. Uses the new SDS API v1 with fuzzy search support.",
            },
          ],
        };
      case "accessci://software/categories": {
        const filterValues = await this.discoverFilterValues();
        const content = filterValues.content[0];
        const text = content.type === "text" ? content.text : "";
        return {
          contents: [
            {
              uri,
              mimeType: "application/json",
              text,
            },
          ],
        };
      }
      default:
        throw new Error(`Unknown resource: ${uri}`);
    }
  }

  /**
   * Extract the unique resource names that actually appear in results.
   */
  private getMatchedResources(results: TransformedSoftware[]): string[] {
    const resources = new Set<string>();
    for (const item of results) {
      for (const r of item.available_on_resources) {
        resources.add(r);
      }
    }
    return [...resources].sort();
  }

  /**
   * Transform raw API response to enhanced format
   */
  private transformSoftwareItem(
    item: SoftwareItem,
    includeAiMetadata: boolean = true
  ): TransformedSoftware {
    // Extract resource information from the rps object
    const resources: string[] = [];
    const resourceIds: string[] = [];
    const versionsPerResource: Record<string, string[]> = {};

    if (item.rps) {
      for (const [rpKey, rpInfo] of Object.entries(item.rps)) {
        resources.push(rpInfo.rp_name || rpKey);
        if (rpInfo.rp_resource_id) {
          resourceIds.push(...rpInfo.rp_resource_id);
        }
        if (rpInfo.software_versions) {
          versionsPerResource[rpInfo.rp_name || rpKey] = rpInfo.software_versions;
        }
      }
    }

    // Collect all unique versions across resources
    // Note: API returns versions pre-sorted (best effort), first item is latest
    const allVersions: string[] = [];
    const seenVersions = new Set<string>();
    Object.values(versionsPerResource).forEach((versions) => {
      versions.forEach((v) => {
        if (v && !seenVersions.has(v)) {
          seenVersions.add(v);
          allVersions.push(v);
        }
      });
    });

    const result: TransformedSoftware = {
      name: item.software_name,
      description: item.software_description || null,
      versions: allVersions, // Preserve API sort order (first is latest)
      documentation: item.software_documentation || null,
      website: item.software_web_page || null,
      usage_link: item.software_use_link || null,
      available_on_resources: [...new Set(resources)],
      resource_ids: [...new Set(resourceIds)],
      versions_by_resource:
        Object.keys(versionsPerResource).length > 0 ? versionsPerResource : undefined,
    };

    if (includeAiMetadata) {
      result.ai_metadata = {
        description: item.ai_description || null,
        tags: item.ai_general_tags
          ? item.ai_general_tags
              .split(",")
              .map((t: string) => t.trim())
              .filter(Boolean)
          : [],
        research_area: item.ai_research_area || null,
        research_discipline: item.ai_research_discipline || null,
        research_field: item.ai_research_field || null,
        software_type: item.ai_software_type || null,
        software_class: item.ai_software_class || null,
        core_features: item.ai_core_features || null,
        example_use: item.ai_example_use || null,
      };
    }

    return result;
  }

  private async searchSoftware(args: SearchSoftwareArgs): Promise<CallToolResult> {
    const {
      query,
      resource,
      fuzzy = true,
      include_ai_metadata = true,
      limit,
      offset,
      fields,
    } = args;

    // Build query params
    const params: SoftwareQueryParams = {};

    if (query) {
      params.software = [query];
      if (fuzzy) {
        params.fuzz_software = true;
      }
    } else {
      // Get all software if no query
      params.software = ["*"];
    }

    if (resource) {
      const normalizedResource = normalizeGlobalResourceId(resource);
      params.rps = [normalizedResource];
      if (fuzzy) {
        params.fuzz_rp = true;
      }
    }

    try {
      // API returns results pre-sorted: exact > starts-with > contains > other (alphabetically within each)
      const results = await this.queryApi(params);

      const pagination = buildPagination({
        requestedLimit: limit,
        offset: offset ?? 0,
        total: results.length,
        defaultLimit: 100,
      });

      // Apply pagination
      const limitedResults = results.slice(pagination.offset, pagination.offset + pagination.limit);

      // Transform results
      const transformedResults = limitedResults.map((item) =>
        this.transformSoftwareItem(item, include_ai_metadata)
      );

      const envelope = {
        total: results.length,
        items: transformedResults,
        metadata: {
          filters_applied: {
            query: query ?? null,
            resource: resource ?? null,
            fuzzy: fuzzy ?? null,
            ...(resource && normalizeGlobalResourceId(resource) !== resource
              ? { resource_normalized: normalizeGlobalResourceId(resource) }
              : {}),
          },
          ...(resource
            ? {
                aggregations: {
                  resource_matched: this.getMatchedResources(transformedResults),
                },
              }
            : {}),
          pagination,
          query_relevance: fuzzy ? ("loose_match" as const) : ("exact" as const),
        },
        documentation: {
          links: this.listingLinks("search"),
        },
      };

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(projectFields(envelope, fields)),
          },
        ],
      };
    } catch (error) {
      return this.errorResponse(handleApiError(error));
    }
  }

  private async listAllSoftware(args: ListAllSoftwareArgs): Promise<CallToolResult> {
    const { resource, include_ai_metadata = false, limit, offset, fields } = args;

    const params: SoftwareQueryParams = {
      software: ["*"],
    };

    if (resource) {
      const normalizedResource = normalizeGlobalResourceId(resource);
      params.rps = [normalizedResource];
      params.fuzz_rp = true;
    }

    try {
      const results = await this.queryApi(params);

      const pagination = buildPagination({
        requestedLimit: limit,
        offset: offset ?? 0,
        total: results.length,
        defaultLimit: 100,
      });

      // Apply pagination
      const limitedResults = results.slice(pagination.offset, pagination.offset + pagination.limit);

      // Transform results
      const transformedResults = limitedResults.map((item) =>
        this.transformSoftwareItem(item, include_ai_metadata)
      );

      const envelope = {
        total: results.length,
        items: transformedResults,
        metadata: {
          filters_applied: {
            resource: resource ?? null,
            ...(resource && normalizeGlobalResourceId(resource) !== resource
              ? { resource_normalized: normalizeGlobalResourceId(resource) }
              : {}),
          },
          ...(resource
            ? {
                aggregations: {
                  resource_matched: this.getMatchedResources(transformedResults),
                },
              }
            : {}),
          pagination,
        },
        documentation: {
          links: this.listingLinks("list"),
        },
      };

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(projectFields(envelope, fields)),
          },
        ],
      };
    } catch (error) {
      return this.errorResponse(handleApiError(error));
    }
  }

  private async getSoftwareDetails(args: GetSoftwareDetailsArgs): Promise<CallToolResult> {
    const { software_name, resource, fuzzy = true } = args;

    const params: SoftwareQueryParams = {
      software: [software_name],
      fuzz_software: fuzzy,
    };

    if (resource) {
      const normalizedResource = normalizeGlobalResourceId(resource);
      params.rps = [normalizedResource];
      params.fuzz_rp = true;
    }

    try {
      const results = await this.queryApi(params);

      if (results.length === 0) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                software_name,
                found: false,
                message: `No software found matching '${software_name}'${resource ? ` on resource '${resource}'` : ""}`,
                suggestion: "Try a different search term or enable fuzzy matching",
              }),
            },
          ],
        };
      }

      // API returns results pre-sorted: exact > starts-with > contains > other (alphabetically within each)
      // First result is the best match
      const bestMatch = this.transformSoftwareItem(results[0], true);

      // If there are multiple matches, include them
      const otherMatches = results.slice(1, 5).map((item) => ({
        name: item.software_name,
        resources: item.rps ? Object.values(item.rps).map((rp) => rp.rp_name) : [],
      }));

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              software_name,
              found: true,
              ...(resource ? { resource_matched: bestMatch.available_on_resources } : {}),
              details: bestMatch,
              other_matches: otherMatches.length > 0 ? otherMatches : undefined,
              metadata: {
                filters_applied: {
                  resource: resource ?? null,
                  fuzzy: fuzzy ?? null,
                  ...(resource && normalizeGlobalResourceId(resource) !== resource
                    ? { resource_normalized: normalizeGlobalResourceId(resource) }
                    : {}),
                },
              },
            }),
          },
        ],
      };
    } catch (error) {
      return this.errorResponse(handleApiError(error));
    }
  }

  private async compareSoftwareAvailability(
    args: CompareSoftwareAvailabilityArgs
  ): Promise<CallToolResult> {
    const { software_names, resources } = args;

    try {
      // Query for all requested software
      const params: SoftwareQueryParams = {
        software: software_names,
        fuzz_software: true,
      };

      if (resources && resources.length > 0) {
        params.rps = resources.map((r) => normalizeGlobalResourceId(r));
        params.fuzz_rp = true;
      }

      const results = await this.queryApi(params);

      // Build availability matrix
      const availabilityMap: Record<string, Set<string>> = {};
      const allResources = new Set<string>();

      for (const item of results) {
        const softwareName = item.software_name.toLowerCase();

        if (!availabilityMap[softwareName]) {
          availabilityMap[softwareName] = new Set();
        }

        // Extract resources from the rps object
        if (item.rps) {
          for (const rpInfo of Object.values(item.rps)) {
            const rpName = rpInfo.rp_name;
            if (rpName) {
              availabilityMap[softwareName].add(rpName);
              allResources.add(rpName);
            }
          }
        }
      }

      // A requested resource that none of the results came from either has no
      // software list at all or just lists none of these packages. Ask the
      // index which, so a gap is never read as "not available".
      const foundResources = Array.from(allResources).sort();
      const unmatched = (resources ?? []).filter(
        (r, i, all) =>
          !foundResources.some((f) => sameResource(r, f)) &&
          all.findIndex((o) => resourceKey(o) === resourceKey(r)) === i
      );
      const coverage = new Map<string, Coverage>(
        await Promise.all(
          unmatched.map(async (r): Promise<[string, Coverage]> => [r, await this.coverageOf(r)])
        )
      );
      const statusColumns = [...foundResources, ...unmatched];

      // Create comparison table
      const comparison: SoftwareComparison[] = [];

      for (const softwareName of software_names) {
        const softwareLower = softwareName.toLowerCase();

        // Priority matching: exact match first, then starts-with, then contains
        let foundKey = Object.keys(availabilityMap).find((k) => k === softwareLower);
        if (!foundKey) {
          foundKey = Object.keys(availabilityMap).find((k) => k.startsWith(softwareLower));
        }
        if (!foundKey) {
          foundKey = Object.keys(availabilityMap).find((k) => k.includes(softwareLower));
        }
        if (!foundKey) {
          foundKey = Object.keys(availabilityMap).find((k) => softwareLower.includes(k));
        }

        const listedOn = foundKey ? availabilityMap[foundKey] : new Set<string>();
        const resourceStatus: Record<string, ResourceStatus> = {};
        for (const column of statusColumns) {
          const checked = coverage.get(column);
          resourceStatus[column] = listedOn.has(column)
            ? "listed"
            : checked === undefined || checked === "indexed"
              ? "not_listed"
              : checked;
        }

        comparison.push({
          software: softwareName,
          found: !!foundKey,
          available_on: Array.from(listedOn),
          resource_count: listedOn.size,
          resource_status: resourceStatus,
        });
      }

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              requested_software: software_names,
              requested_resources: resources || "all",
              all_resources_found: foundResources,
              comparison,
              resources_not_indexed: unmatched.filter((r) => coverage.get(r) === "not_indexed"),
              resources_lookup_failed: unmatched.filter((r) => coverage.get(r) === "lookup_failed"),
              gap_note: GAP_NOTE,
              summary: {
                total_software_requested: software_names.length,
                software_found: comparison.filter((c) => c.found).length,
                software_not_found: comparison.filter((c) => !c.found).map((c) => c.software),
              },
            }),
          },
        ],
      };
    } catch (error) {
      return this.errorResponse(handleApiError(error));
    }
  }

  /** Whether the index holds any software list for a resource. */
  private async coverageOf(resource: string): Promise<Coverage> {
    try {
      const items = await this.queryApi({
        software: ["*"],
        rps: [normalizeGlobalResourceId(resource)],
        fuzz_rp: true,
      });
      return items.length > 0 ? "indexed" : "not_indexed";
    } catch {
      return "lookup_failed";
    }
  }

  private async discoverFilterValues(): Promise<CallToolResult> {
    try {
      // Get a sample of all software
      const results = await this.queryApi({
        software: ["*"],
      });

      // Extract unique values
      const researchAreas = new Set<string>();
      const tags = new Map<string, number>();
      const softwareTypes = new Set<string>();
      const resources = new Set<string>();

      for (const item of results) {
        // Collect research areas
        if (item.ai_research_area) researchAreas.add(item.ai_research_area);
        if (item.ai_research_discipline) researchAreas.add(item.ai_research_discipline);
        if (item.ai_research_field) researchAreas.add(item.ai_research_field);

        // Collect and count tags
        if (item.ai_general_tags) {
          const itemTags = item.ai_general_tags
            .split(",")
            .map((t) => t.trim())
            .filter(Boolean);
          for (const tag of itemTags) {
            tags.set(tag, (tags.get(tag) || 0) + 1);
          }
        }

        // Collect software types
        if (item.ai_software_type) softwareTypes.add(item.ai_software_type);
        if (item.ai_software_class) softwareTypes.add(item.ai_software_class);

        // Collect resources from the rps object
        if (item.rps) {
          for (const rpInfo of Object.values(item.rps)) {
            if (rpInfo.rp_name) resources.add(rpInfo.rp_name);
          }
        }
      }

      // Sort tags by frequency
      const sortedTags = Array.from(tags.entries())
        .sort((a, b) => b[1] - a[1])
        .slice(0, 30)
        .map(([tag, count]) => ({ value: tag, count }));

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                sample_size: results.length,
                discovered_values: {
                  research_areas: Array.from(researchAreas).sort(),
                  software_types: Array.from(softwareTypes).sort(),
                  top_tags: sortedTags,
                  resources: Array.from(resources).sort(),
                },
                api_info: {
                  version: "v1",
                  base_url: "https://sds-ara-api.access-ci.org",
                  supports_fuzzy_search: true,
                },
              },
              null,
              2
            ),
          },
        ],
      };
    } catch (error) {
      return this.errorResponse(handleApiError(error));
    }
  }
}
