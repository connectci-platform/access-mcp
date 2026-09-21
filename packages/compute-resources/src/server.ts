import {
  BaseAccessServer,
  handleApiError,
  sanitizeGroupId,
  resolveResourceId,
  projectFields,
  FIELDS_OF_SCIENCE,
  Tool,
  Resource,
  CallToolResult,
} from "@access-mcp/shared";
import {
  CallToolRequest,
  ReadResourceRequest,
  ReadResourceResult,
  GetPromptResult,
} from "@modelcontextprotocol/sdk/types.js";
import { createRequire } from "module";
const require = createRequire(import.meta.url);
const { version } = require("../package.json");

// Interfaces for search_resources tool arguments
interface SearchResourcesArgs {
  resource_id?: string;
  query?: string;
  resource_type?: string;
  has_gpu?: boolean;
  organization?: string;
  include_resource_ids?: boolean;
  fields?: string[];
}

// Interfaces for API response types
interface OrganizationResult {
  organization_id?: number;
  organization_name?: string;
}

interface ActiveGroup {
  info_groupid?: string;
  group_descriptive_name?: string;
  group_description?: string;
  rollup_organization_ids?: number[];
  rollup_feature_ids?: number[];
  rollup_info_resourceids?: string[];
  group_logo_url?: string;
}

interface ApiFeature {
  feature_id: number;
  feature_name: string;
  feature_category_id: number;
}

interface ApiFeatureCategory {
  feature_category_id: number;
  feature_category_name: string;
  feature_category_description?: string;
}

interface HardwareItem {
  cider_type?: string;
  resource_descriptive_name?: string;
  resource_description?: string;
  short_name?: string;
  info_resourceid?: string;
}

interface StructuredHardware {
  compute_nodes: HardwareEntry[];
  storage: HardwareEntry[];
  gpus: HardwareEntry[];
  memory: HardwareEntry[];
  other: HardwareEntry[];
}

interface HardwareEntry {
  name: string;
  type: string;
  details: string;
}

interface ComputeResource {
  id?: string;
  name?: string;
  description?: string;
  organization_ids?: number[];
  organization_names?: string[];
  features?: number[];
  feature_names?: string[];
  resources?: string[];
  logoUrl?: string;
  feature_categories?: Record<string, string[]>;
  accessAllocated?: boolean;
  hasGpu?: boolean;
  resourceTypes?: string[];
  resourceIds?: string[];
}

export class ComputeResourcesServer extends BaseAccessServer {
  constructor() {
    super("access-mcp-compute-resources", version, "https://operations-api.access-ci.org");
  }

  protected listingLinks(
    context: "list" | "search" | "details" = "list"
  ): Record<string, string> | undefined {
    if (context === "list" || context === "search") {
      return { see_all_url: "https://allocations.access-ci.org/resources" };
    }
    return undefined;
  }

  protected getTools(): Tool[] {
    return [
      {
        name: "search_resources",
        description:
          "Search ACCESS-CI compute resources by name, type, or feature (ACCESS OnDemand, " +
          "Globus, preemption, NAIRR participation). Returns resource IDs for other services. " +
          "Returns {total, items}. Use it to enumerate or filter the catalog; treat every " +
          "field as incomplete rather than authoritative. Data comes from CiDeR, which " +
          "resource providers are responsible for updating and largely do not, so a missing " +
          "flag does not mean a resource lacks the feature. Verified 2026-09-20: the " +
          "OnDemand flags and support.access-ci.org/tools/ondemand disagree on five " +
          "resources, with errors on both sides, so neither settles the question alone. " +
          "has_gpu is unreliable too — it includes resources whose hardware payload has no " +
          "GPU block and excludes non-GPU accelerators such as Habana Gaudi. A display name " +
          "may carry a stale 'COMING SOON' or 'NO NEW ALLOCATIONS' label contradicting its " +
          "own accessAllocated flag. For hardware specifications prefer the per-resource " +
          "pages under https://support.access-ci.org/documentation/resources, which are " +
          "curated and corrected.",
        inputSchema: {
          type: "object",
          properties: {
            id: {
              type: "string",
              description: "Get specific resource (e.g., 'delta.ncsa.access-ci.org')",
            },
            query: {
              type: "string",
              description:
                "Search names, descriptions, organizations, and features. For specific hardware models (e.g., 'A100'), use get_resource_hardware instead.",
            },
            type: {
              type: "string",
              enum: ["Cloud", "GPU Compute", "Innovative / Novel Compute", "CPU Compute", "Service / Other", "Storage", "Commercial Cloud", "Sensors / Instruments"],
              description: "Filter by resource type",
            },
            has_gpu: {
              type: "boolean",
              description:
                "Filter by GPU: true = only GPU resources, false = only non-GPU resources. Omit to include all resources.",
            },
            organization: {
              type: "string",
              description: "Filter by org (NCSA, PSC, Purdue, SDSC, TACC)",
            },
            include_ids: {
              type: "boolean",
              description: "Include resource IDs for other services",
              default: true,
            },
            fields: {
              type: "array",
              items: { type: "string" },
              description:
                "Project the response down to only these fields. Dotted path syntax: 'total', 'items[].name', 'items[].resource_ids', 'metadata.pagination.has_more', etc. Use to reduce payload size when you only need specific fields. Omit to receive the full response. Only applies to listing results, not single-resource lookups.",
            },
          },
        },
        _meta: {
          supportsFieldProjection: true,
        },
      },
      {
        name: "get_resource_hardware",
        description:
          "Get a resource's hardware description from CiDeR (CPU, GPU, memory, storage). " +
          "KNOWN STALE — prefer https://support.access-ci.org/documentation/resources, which " +
          "is curated and corrected. CiDeR is updated by resource providers and often is not: " +
          "verified 2026-09-20, it reports Delta at 124 CPU nodes (actually 132), omits the " +
          "MI210 in Delta's AMD node, lists Bridges-2 as H100-only (it also has L40S and " +
          "V100), and returns no specifications at all for Stampede3, KyRIC, Voyager or " +
          "Neocortex. Where it does carry detail it can be the richer source, so treat what " +
          "it returns as one input rather than authoritative, and never fill a missing figure " +
          "from general knowledge of the hardware model.",
        inputSchema: {
          type: "object",
          properties: {
            id: {
              type: "string",
              description:
                "Resource name (e.g., 'Anvil', 'Delta') or full ID (e.g., 'anvil.purdue.access-ci.org')",
            },
          },
          required: ["id"],
        },
      },
    ];
  }

  protected getResources(): Resource[] {
    return [
      {
        uri: "accessci://compute-resources",
        name: "ACCESS-CI Compute Resources",
        description: "Information about ACCESS-CI compute resources, hardware, and software",
        mimeType: "application/json",
      },
      {
        uri: "accessci://compute-resources/capabilities-matrix",
        name: "Compute Resource Capabilities Matrix",
        description: "Comparison of different resource types and their ideal use cases",
        mimeType: "application/json",
      },
      {
        uri: "accessci://compute-resources/gpu-guide",
        name: "GPU Resource Selection Guide",
        description: "Guidance for selecting appropriate GPU resources for different workloads",
        mimeType: "text/markdown",
      },
      {
        uri: "accessci://compute-resources/resource-types",
        name: "Resource Type Taxonomy",
        description: "Classification of ACCESS-CI resource types and their characteristics",
        mimeType: "application/json",
      },
    ];
  }

  protected getPrompts() {
    return [
      {
        name: "recommend_compute_resource",
        description:
          "Get personalized recommendations for ACCESS-CI compute resources based on research needs",
        arguments: [
          {
            name: "research_area",
            description:
              "Your field of research (e.g., 'machine learning', 'molecular dynamics', 'climate modeling', 'genomics')",
            required: true,
          },
          {
            name: "compute_needs",
            description:
              "Describe your computational requirements in natural language (e.g., 'GPU for training transformers', 'high memory for genome assembly', '500TB storage for climate data', 'parallel CPU for CFD simulations')",
            required: true,
          },
          {
            name: "experience_level",
            description:
              "Optional: Your HPC experience level (e.g., 'beginner', 'intermediate', 'advanced'). Helps tailor recommendations to your familiarity with supercomputing.",
            required: false,
          },
          {
            name: "allocation_size",
            description:
              "Optional: Approximate allocation size needed (e.g., 'small pilot project', 'medium research project', 'large-scale production', or specific credit amount like '100000')",
            required: false,
          },
        ],
      },
    ];
  }

  async handleToolCall(request: CallToolRequest): Promise<CallToolResult> {
    const { name, arguments: args } = request.params;
    const toolArgs = (args || {}) as Record<string, unknown>;

    try {
      switch (name) {
        case "search_resources":
          return await this.searchResourcesRouter({
            resource_id: toolArgs.id as string | undefined,
            query: toolArgs.query as string | undefined,
            resource_type: toolArgs.type as string | undefined,
            has_gpu: toolArgs.has_gpu as boolean | undefined,
            organization: toolArgs.organization as string | undefined,
            include_resource_ids: toolArgs.include_ids as boolean | undefined,
            fields: toolArgs.fields as string[] | undefined,
          });
        case "get_resource_hardware":
          return await this.getResourceHardware(toolArgs.id as string);
        default:
          return this.errorResponse(`Unknown tool: ${name}`);
      }
    } catch (error) {
      return this.errorResponse(handleApiError(error));
    }
  }

  /**
   * Router for consolidated search_resources tool
   * Routes to appropriate handler based on parameters
   */
  private async searchResourcesRouter(args: SearchResourcesArgs): Promise<CallToolResult> {
    // Get specific resource details by ID (lookup — fields ignored, not enveloped)
    if (args.resource_id) {
      return await this.getComputeResource(args.resource_id);
    }

    // No parameters = list all resources.
    // has_gpu uses explicit-undefined: `has_gpu: false` is a real filter
    // (find CPU-only resources) and must NOT fall through to the
    // unfiltered listing.
    if (
      !args.query &&
      !args.resource_type &&
      args.has_gpu === undefined &&
      !args.organization
    ) {
      return await this.listComputeResources(args.fields);
    }

    // Search/filter resources
    return await this.searchResources(args);
  }

  async handleResourceRead(request: ReadResourceRequest): Promise<ReadResourceResult> {
    const { uri } = request.params;

    if (uri === "accessci://compute-resources") {
      return this.createTextResource(
        uri,
        "ACCESS-CI Compute Resources API - Use the available tools to query compute resources, hardware specifications, and software availability."
      );
    }

    if (uri === "accessci://compute-resources/capabilities-matrix") {
      const matrix = {
        comparison_matrix: {
          "Machine Learning / AI": {
            primary: "GPU Compute",
            secondary: "CPU Compute",
            rationale:
              "GPUs provide massive parallelism for training neural networks. CPU systems useful for large datasets that don't fit in GPU memory.",
          },
          "Molecular Dynamics": {
            primary: "GPU Compute",
            secondary: "CPU Compute",
            rationale:
              "Modern MD codes (GROMACS, AMBER) are GPU-accelerated. CPU clusters still useful for older codes or ensemble simulations.",
          },
          "Genomics / Bioinformatics": {
            primary: "CPU Compute",
            secondary: "Storage",
            rationale:
              "Genome assembly requires large memory. High-throughput analysis benefits from many CPU cores.",
          },
          "Climate / Weather Modeling": {
            primary: "CPU Compute",
            secondary: "Storage",
            rationale:
              "Large-scale parallel codes optimized for CPU clusters. Massive data output requires substantial storage.",
          },
          "CFD / Engineering": {
            primary: "CPU Compute",
            secondary: "GPU Compute",
            rationale:
              "Traditional CFD codes use CPU clusters. Some modern codes support GPU acceleration.",
          },
          "Data Analytics": {
            primary: "CPU Compute",
            secondary: "Cloud",
            rationale:
              "Parallel data processing on CPU clusters. Cloud resources useful for flexible workloads.",
          },
          "Quantum Chemistry": {
            primary: "CPU Compute",
            secondary: "GPU Compute",
            rationale:
              "Ab initio calculations are CPU-intensive. Some modern codes support GPU acceleration.",
          },
        },
        selection_guide: {
          step_1:
            "Identify your primary computational pattern (CPU-bound, GPU-accelerated, memory-intensive, data-intensive)",
          step_2: "Match to resource type using the comparison matrix above",
          step_3: "Use search_resources tool to find specific systems with those capabilities",
          step_4: "Review hardware specs with get_resource_hardware tool",
          step_5: "Check software availability with software-discovery service",
        },
      };
      return this.createJsonResource(uri, matrix);
    }

    if (uri === "accessci://compute-resources/gpu-guide") {
      const guide = `# GPU Resource Selection Guide

GPU hardware changes frequently as ACCESS-CI systems are upgraded. Use the live tools for current information:

## Finding GPU Resources

1. **search_resources** with \`has_gpu: true\` — lists all GPU-enabled systems with their feature categories
2. **get_resource_hardware** with a resource ID — shows detailed GPU specs (model, memory, count per node)

## General GPU Selection Guidance

- **Large-scale deep learning / LLMs**: Look for systems with high GPU memory (40GB+) and multi-GPU nodes
- **Computer vision / CNNs**: Mid-range GPU memory is typically sufficient
- **Molecular dynamics**: Codes like GROMACS and AMBER benefit from GPU acceleration
- **Inference / deployment**: Smaller GPU configurations can be cost-effective
- **Visualization / rendering**: Look for systems with RTX or visualization-capable GPUs

## Multi-GPU Training

Most ACCESS GPU systems support:
- **Data parallelism**: Distribute batches across GPUs
- **Model parallelism**: Split model layers across GPUs
- **Pipeline parallelism**: Different model stages on different GPUs

Use **search_resources** with **has_gpu: true** to find GPU-enabled systems, then **get_resource_hardware** for detailed specs.
`;
      return this.createMarkdownResource(uri, guide);
    }

    if (uri === "accessci://compute-resources/resource-types") {
      return this.createJsonResource(uri, {
        description: "ACCESS-CI resource types derived from the Resource Type feature category in the API. Each resource may have multiple types.",
        resource_types: [
          { name: "Cloud", description: "Cloud computing environments for flexible, on-demand workloads" },
          { name: "GPU Compute", description: "Systems with GPU accelerators for parallel workloads" },
          { name: "Innovative / Novel Compute", description: "Specialized or experimental computing architectures" },
          { name: "CPU Compute", description: "Traditional CPU-based high-performance computing clusters" },
          { name: "Service / Other", description: "Supporting services, gateways, and other infrastructure" },
          { name: "Storage", description: "Large-scale data storage and management systems" },
          { name: "Commercial Cloud", description: "Commercial cloud provider resources available through ACCESS" },
          { name: "Sensors / Instruments", description: "Sensor networks and scientific instruments" },
        ],
      });
    }

    throw new Error(`Unknown resource: ${uri}`);
  }

  async handleGetPrompt(request: {
    params: { name: string; arguments?: Record<string, string> };
  }): Promise<GetPromptResult> {
    const { name, arguments: args = {} } = request.params;

    if (name === "recommend_compute_resource") {
      const { research_area = "", compute_needs = "", allocation_size, experience_level } = args;

      const lowerNeeds = compute_needs.toLowerCase();
      const lowerResearch = research_area.toLowerCase();

      // Find matching field of science for domain context
      let matchedField = null;
      for (const [fieldName, fieldData] of Object.entries(FIELDS_OF_SCIENCE)) {
        const keywords = fieldData.keywords.map((k) => k.toLowerCase());
        if (
          keywords.some((k) => lowerResearch.includes(k) || lowerNeeds.includes(k)) ||
          lowerResearch.includes(fieldName.toLowerCase())
        ) {
          matchedField = fieldData;
          break;
        }
      }

      // Build context sections
      const contextSections = [];

      // Field of science context
      if (matchedField) {
        contextSections.push(`**Your Research Field**: ${matchedField.name}
- Typical Resources: ${matchedField.typical_resources.join(", ")}
- Common Software: ${matchedField.common_software.slice(0, 6).join(", ")}`);
      }

      // Construct the final prompt
      const promptText = `I need help selecting appropriate ACCESS-CI compute resources for my research.

**Research Area**: ${research_area}
**Computational Needs**: ${compute_needs}
${experience_level ? `**Experience Level**: ${experience_level}` : ""}
${allocation_size ? `**Allocation Size**: ${allocation_size}` : ""}

${contextSections.join("\n\n")}

---

To answer this request, use the following tools to gather live data:

1. **search_resources** — list all available ACCESS-CI resources and their types
2. **search_resources** with \`has_gpu: true\` — if GPU resources are relevant
3. **get_resource_hardware** — get detailed hardware specs for promising systems

Based on the live data and my requirements, please:

1. **Recommend 2-3 specific ACCESS systems** that best match my needs
2. **Explain the rationale** for each recommendation
3. **Suggest an allocation tier** (Discover: 1K-400K, Explore: 400K-1.5M, Accelerate: 1.5M-10M, Maximize: 10M+ credits)
4. **Recommend next steps** for getting started${experience_level === "beginner" ? ", keeping in mind I'm new to HPC" : ""}

Consider:
- Which resource types match my computational pattern
- Which systems have the specific capabilities I need
- What allocation size makes sense for my project scale
- Any relevant software that might be pre-installed`;

      return {
        description: `Personalized compute resource recommendation for ${research_area}`,
        messages: [
          {
            role: "user",
            content: {
              type: "text",
              text: promptText,
            },
          },
        ],
      };
    }

    throw new Error(`Unknown prompt: ${name}`);
  }

  /**
   * Static mapping of known organization IDs to names.
   * This serves as a fallback when the API doesn't return organization info.
   *
   * These names are fetched from /wh2/cider/v1/organizations/ endpoint.
   * Mapping updated: 2025-10-21 via scripts/fetch-organizations-working-endpoint.js
   *
   * Note: API should be preferred (see listComputeResources method), this is only
   * used if API fetch fails. Allows new organizations to be discovered automatically.
   */
  private readonly KNOWN_ORGANIZATIONS: Record<number, string> = {
    // Major HPC Centers
    844: "National Center for Supercomputing Applications",
    856: "San Diego Supercomputer Center",
    848: "Pittsburgh Supercomputing Center",
    2058: "Texas Advanced Computing Center",

    // Universities
    467: "Texas A&M University",
    476: "University of Texas at Austin",
    561: "Indiana University",
    563: "University of Kentucky",
    1869: "Purdue University",
    178: "Northwestern University",
    471: "Texas Tech University",
    14449: "Institute for Advanced Computational Science at Stony Brook University",

    // Research Infrastructure & Projects
    2000: "Renaissance Computing Institute",
    653: "NSF National Center for Atmospheric Research",
    2440: "OSG Consortium",
    4659: "Science Gateways Center of Excellence",
    12964: "Open Storage Network",
    16235: "ACCESS Support",
    19169: "CloudBank",
  };

  /**
   * Common organization abbreviations for better search UX
   * Includes HPC centers, universities, and research institutions
   */
  private readonly ORG_ABBREVIATIONS: Record<string, string[]> = {
    // Major HPC/Supercomputing Centers
    NCSA: ["National Center for Supercomputing Applications", "Illinois"],
    SDSC: ["San Diego Supercomputer Center"],
    PSC: ["Pittsburgh Supercomputing Center"],
    TACC: ["Texas Advanced Computing Center"],
    NCAR: [
      "NSF National Center for Atmospheric Research",
      "National Center for Atmospheric Research",
    ],
    NERSC: ["National Energy Research Scientific Computing Center"],
    ALCF: ["Argonne Leadership Computing Facility"],
    OLCF: ["Oak Ridge Leadership Computing Facility"],

    // Universities (common abbreviations)
    IU: ["Indiana University"],
    UK: ["University of Kentucky"],
    TAMU: ["Texas A&M University", "Texas A&M"],
    UT: ["University of Texas at Austin"],
    TTU: ["Texas Tech University"],
    OSU: ["Ohio State University"],
    ASU: ["Arizona State University"],
    FSU: ["Florida State University"],
    PSU: ["Pennsylvania State University", "Penn State"],
    MSU: ["Michigan State University"],
    USC: ["University of Southern California"],
    UCLA: ["University of California, Los Angeles"],
    UIUC: ["University of Illinois at Urbana-Champaign", "Illinois"],
    MIT: ["Massachusetts Institute of Technology"],
    CU: ["University of Colorado"],
    "CU Boulder": ["University of Colorado Boulder"],
    UChicago: ["University of Chicago"],

    // Research Computing Consortia & Networks
    OSG: ["OSG Consortium", "Open Science Grid"],
    OSN: ["Open Storage Network"],
    SGCI: ["Science Gateways Center of Excellence", "Science Gateways Community Institute"],
    RENCI: ["Renaissance Computing Institute"],
    ACCESS: ["ACCESS Support", "Advanced Cyberinfrastructure Coordination Ecosystem"],
    XSEDE: ["Extreme Science and Engineering Discovery Environment"], // Legacy
  };

  private buildFeatureLookups(apiResults: {
    features?: ApiFeature[];
    feature_categories?: ApiFeatureCategory[];
  }): {
    featureMap: Map<number, { name: string; categoryName: string }>;
  } {
    const categoryMap = new Map<number, string>();
    for (const cat of apiResults.feature_categories || []) {
      categoryMap.set(cat.feature_category_id, cat.feature_category_name);
    }
    const featureMap = new Map<number, { name: string; categoryName: string }>();
    for (const feat of apiResults.features || []) {
      const categoryName = categoryMap.get(feat.feature_category_id) || "Unknown";
      featureMap.set(feat.feature_id, { name: feat.feature_name, categoryName });
    }
    return { featureMap };
  }

  private resolveFeatures(
    featureIds: number[],
    featureMap: Map<number, { name: string; categoryName: string }>
  ): { names: string[]; categories: Record<string, string[]> } {
    const names: string[] = [];
    const categories: Record<string, string[]> = {};
    for (const id of featureIds) {
      const feat = featureMap.get(id);
      if (feat) {
        names.push(feat.name);
        if (!categories[feat.categoryName]) {
          categories[feat.categoryName] = [];
        }
        categories[feat.categoryName].push(feat.name);
      }
    }
    return { names, categories };
  }

  private deriveResourceTypes(
    featureIds: number[],
    featureMap: Map<number, { name: string; categoryName: string }>
  ): string[] {
    return featureIds
      .filter((id) => {
        const feat = featureMap.get(id);
        return feat?.categoryName === "Resource Type";
      })
      .map((id) => featureMap.get(id)!.name);
  }

  private async listComputeResources(fields?: string[]) {
    // Get all active resource groups
    const response = await this.httpClient.get(
      "/wh2/cider/v1/access-active-groups/type/resource-catalog.access-ci.org/"
    );

    // Also try to get organization information
    const orgMapping: Map<number, string> = new Map();

    // First, add known static mappings as fallback
    Object.entries(this.KNOWN_ORGANIZATIONS).forEach(([id, name]) => {
      orgMapping.set(parseInt(id), name);
    });

    // Then try to fetch live organization data (will override static mappings)
    // NOTE: Using /organizations/ endpoint (not /access-active-groups/type/organizations.access-ci.org/
    // which returns 0 results). See ACCESS_CI_API_ISSUE_ORGANIZATIONS.md for details.
    try {
      const orgResponse = await this.httpClient.get("/wh2/cider/v1/organizations/");
      if (orgResponse.status === 200 && orgResponse.data?.results) {
        orgResponse.data.results.forEach((org: OrganizationResult) => {
          if (org.organization_id && org.organization_name) {
            orgMapping.set(org.organization_id, org.organization_name);
          }
        });
      }
    } catch (e) {
      // If organizations endpoint fails, we'll use the static mapping
      console.warn("Could not fetch organization names from API, using fallback mapping");
    }

    // Check if the response has the expected structure
    if (!response.data || !response.data.results || !response.data.results.active_groups) {
      throw new Error(`Unexpected API response structure. Got: ${JSON.stringify(response.data)}`);
    }

    const { featureMap } = this.buildFeatureLookups(response.data.results);

    const computeResources = response.data.results.active_groups
      .filter((group: ActiveGroup) => {
        // Filter for compute resources (category 1 = "Compute & Storage Resources")
        return (
          group.rollup_info_resourceids &&
          group.rollup_feature_ids &&
          !group.rollup_feature_ids.includes(137)
        );
      })
      .map((group: ActiveGroup) => {
        // Map organization IDs to names if available
        const organizationNames = (group.rollup_organization_ids || []).map(
          (id: number) => orgMapping.get(id) || id.toString()
        );

        const featureIds = group.rollup_feature_ids || [];
        const resolved = this.resolveFeatures(featureIds, featureMap);
        const resourceTypes = this.deriveResourceTypes(featureIds, featureMap);

        return {
          id: group.info_groupid,
          name: group.group_descriptive_name,
          description: group.group_description,
          organization_ids: group.rollup_organization_ids,
          organization_names: organizationNames,
          features: group.rollup_feature_ids,
          feature_names: resolved.names,
          feature_categories: resolved.categories,
          resources: group.rollup_info_resourceids,
          logoUrl: group.group_logo_url,
          accessAllocated: group.rollup_feature_ids?.includes(139) ?? false,
          // Add computed fields for easier filtering
          hasGpu: this.detectGpuCapability(group),
          resourceTypes,
          // Include the actual resource IDs that other ACCESS-CI services can use
          resourceIds: group.rollup_info_resourceids || [],
        };
      });

    const envelope = {
      total: computeResources.length,
      items: computeResources,
      metadata: {
        pagination: {
          limit: computeResources.length,
          offset: 0,
          has_more: false,
        },
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
  }

  private async getComputeResource(resourceId: string) {
    const sanitizedId = sanitizeGroupId(resourceId);

    // Get detailed resource information
    const response = await this.httpClient.get(
      `/wh2/cider/v1/access-active/info_groupid/${sanitizedId}/?format=json`
    );

    // Check for errors
    if (response.status !== 200) {
      return this.errorResponse(
        `Resource not found: '${resourceId}'`,
        { hint: "Use 'search_resources' to find valid resource IDs. Resource IDs typically look like 'delta.ncsa.access-ci.org' or 'bridges2.psc.access-ci.org'" }
      );
    }

    // Check if results exist and are valid
    if (!response.data || !response.data.results || response.data.results.length === 0) {
      return this.errorResponse(
        `Resource not found: '${resourceId}'`,
        { hint: "Use 'search_resources' to find valid resource IDs" }
      );
    }

    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(response.data.results, null, 2),
        },
      ],
    };
  }

  private async getResourceHardware(inputId: string) {
    // Resolve human-readable name to full resource ID if needed
    const resolved = await resolveResourceId(inputId, async (query) => {
      const result = await this.searchResources({ query });
      const content = result.content[0];
      if (content.type !== "text") return [];
      const data = JSON.parse(content.text);
      return (data.items || []).map((item: ComputeResource) => ({
        id: item.id || "",
        name: item.name || "",
      }));
    });

    if (!resolved.success) {
      return this.errorResponse(resolved.error, { hint: resolved.suggestion });
    }
    const resourceId = resolved.id;

    const resourceData = await this.getComputeResource(resourceId);

    // Check if getComputeResource returned an error
    // Parse the content to check if it's an error response
    const firstContent = resourceData.content[0];
    if (firstContent.type !== "text") {
      return resourceData; // Return as-is if not text content
    }
    const parsedData = JSON.parse(firstContent.text);
    if (parsedData.error) {
      return resourceData; // Return the error response as-is
    }

    // Extract hardware-related information
    const fullData = parsedData;
    const hardwareInfo = fullData.filter(
      (item: HardwareItem) =>
        item.cider_type === "Compute" ||
        item.cider_type === "Storage" ||
        item.resource_descriptive_name?.toLowerCase().includes("node") ||
        item.resource_descriptive_name?.toLowerCase().includes("core") ||
        item.resource_descriptive_name?.toLowerCase().includes("memory") ||
        item.resource_descriptive_name?.toLowerCase().includes("gpu")
    );

    // Structure the hardware data for easier consumption
    const structuredHardware = this.structureHardwareInfo(hardwareInfo);

    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(
            {
              resource_id: resourceId,
              hardware: structuredHardware,
              raw_hardware_items: hardwareInfo, // Keep raw data for reference
              documentation: {
                note: "Hardware specifications are derived from the resource catalog API",
                details_url: `https://operations-api.access-ci.org/wh2/cider/v1/access-active/info_groupid/${resourceId}`,
              },
            },
            null,
            2
          ),
        },
      ],
    };
  }

  /**
   * Structure raw hardware items into organized categories.
   *
   * Uses short_name and info_resourceid for reliable categorization since these
   * fields follow consistent naming conventions (e.g., "Bridges-2 GPU",
   * "bridges2-gpu.psc.access-ci.org").
   */
  private structureHardwareInfo(hardwareItems: HardwareItem[]): Partial<StructuredHardware> {
    const structured: StructuredHardware = {
      compute_nodes: [],
      storage: [],
      gpus: [],
      memory: [],
      other: [],
    };

    for (const item of hardwareItems) {
      // Use short_name and info_resourceid for categorization - these are more reliable
      // than resource_descriptive_name which can have ambiguous text like "CPU/GPU cluster"
      const shortName = item.short_name?.toLowerCase() || "";
      const resourceId = item.info_resourceid?.toLowerCase() || "";
      const type = item.cider_type;


      const entry: HardwareEntry = {
        name: item.resource_descriptive_name || "",
        type: item.cider_type || "",
        details: item.resource_description || "",
      };

      // Categorize using the reliable short_name and resource ID patterns
      // GPU: short_name contains "GPU" (e.g., "Bridges-2 GPU", "Delta GPU")
      //      or resourceId contains "-gpu" (e.g., "bridges2-gpu.psc.access-ci.org")
      if (shortName.includes("gpu") || resourceId.includes("-gpu")) {
        structured.gpus.push(entry);
      }
      // Memory: short_name ends with "EM" or contains "Memory"
      //         or resourceId contains "-em" (Extreme Memory)
      else if (
        shortName.endsWith(" em") ||
        shortName.includes("memory") ||
        resourceId.includes("-em.")
      ) {
        structured.memory.push(entry);
      }
      // Storage: cider_type is Storage, or short_name/resourceId indicates storage
      else if (
        type === "Storage" ||
        shortName.includes("storage") ||
        shortName.includes("ocean") ||
        resourceId.includes("-ocean") ||
        resourceId.includes("storage")
      ) {
        structured.storage.push(entry);
      }
      // Compute: cider_type is Compute (covers RM/regular compute nodes)
      else if (type === "Compute") {
        structured.compute_nodes.push(entry);
      }
      // Other: anything that doesn't fit above
      else {
        structured.other.push(entry);
      }
    }

    // Remove empty categories and return
    const result: Partial<StructuredHardware> = {};
    for (const [key, value] of Object.entries(structured)) {
      if (value.length > 0) {
        result[key as keyof StructuredHardware] = value;
      }
    }

    return result;
  }

  private detectGpuCapability(group: ActiveGroup): boolean {
    if (group.rollup_feature_ids?.includes(134)) {
      return true;
    }
    const description = (group.group_description || "").toLowerCase();
    return description.includes("gpu");
  }

  private async searchResources(args: {
    query?: string;
    resource_type?: string;
    has_gpu?: boolean;
    organization?: string;
    include_resource_ids?: boolean;
    fields?: string[];
  }) {
    const { query, resource_type, has_gpu, organization, include_resource_ids = true, fields } = args;

    // Get all resources first
    const allResourcesResult = await this.listComputeResources();
    const firstContent = allResourcesResult.content[0];
    if (firstContent.type !== "text") {
      return allResourcesResult; // Return as-is if not text content
    }
    const allResourcesData = JSON.parse(firstContent.text);
    let resources = allResourcesData.items || [];

    // Apply filters
    if (query) {
      const searchTerm = query.toLowerCase();
      resources = resources.filter(
        (resource: ComputeResource) =>
          resource.name?.toLowerCase().includes(searchTerm) ||
          resource.description?.toLowerCase().includes(searchTerm) ||
          (Array.isArray(resource.organization_names) &&
            resource.organization_names.some(
              (org: string) => typeof org === "string" && org.toLowerCase().includes(searchTerm)
            )) ||
          (Array.isArray(resource.feature_names) &&
            resource.feature_names.some(
              (feat: string) => typeof feat === "string" && feat.toLowerCase().includes(searchTerm)
            ))
      );
    }

    if (resource_type) {
      resources = resources.filter(
        (resource: ComputeResource) => resource.resourceTypes?.includes(resource_type) ?? false
      );
    }

    // Only filter by GPU when has_gpu is explicitly true or false (not null/undefined)
    if (has_gpu === true || has_gpu === false) {
      resources = resources.filter((resource: ComputeResource) => resource.hasGpu === has_gpu);
    }

    // Organization filter (ENHANCED: works with partial names, abbreviations, and searches known orgs)
    if (organization) {
      const orgLower = organization.toLowerCase();
      const orgUpper = organization.toUpperCase();

      // Check if input is an abbreviation and expand it to full names
      const searchTerms = [orgLower];
      if (this.ORG_ABBREVIATIONS[orgUpper]) {
        searchTerms.push(...this.ORG_ABBREVIATIONS[orgUpper].map((n) => n.toLowerCase()));
      }

      // Find matching organization IDs from known organizations using all search terms
      const matchingKnownOrgIds = Object.entries(this.KNOWN_ORGANIZATIONS)
        .filter(([_, name]) => searchTerms.some((term) => name.toLowerCase().includes(term)))
        .map(([id, _]) => parseInt(id));

      resources = resources.filter((resource: ComputeResource) => {
        if (!Array.isArray(resource.organization_names)) {
          return false;
        }

        // Check if any organization name matches any of our search terms
        const nameMatch = resource.organization_names.some(
          (org: string) =>
            typeof org === "string" && searchTerms.some((term) => org.toLowerCase().includes(term))
        );

        if (nameMatch) {
          return true;
        }

        // Also check if the organization IDs match known organizations
        // (This handles cases where organization_names contains IDs as strings)
        if (matchingKnownOrgIds.length > 0 && resource.organization_ids) {
          const hasMatchingId = matchingKnownOrgIds.some((knownId) =>
            resource.organization_ids?.includes(knownId)
          );
          if (hasMatchingId) {
            return true;
          }
        }

        return false;
      });
    }

    // Add resource IDs if requested
    if (include_resource_ids) {
      resources = resources.map((resource: ComputeResource) => ({
        ...resource,
        resource_ids: resource.resourceIds,
      }));
    }

    const envelope = {
      total: resources.length,
      items: resources,
      metadata: {
        pagination: {
          limit: resources.length,
          offset: 0,
          has_more: false,
        },
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
  }
}
