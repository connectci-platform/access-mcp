import {
  BaseAccessServer,
  handleApiError,
  projectFields,
  FIELDS_OF_SCIENCE,
  Resource,
  CallToolResult,
  type ToolWithAccess,
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
import { buildComparison, ResourceDocumentation } from "./resource-documentation.js";
import { FILTER_KEYS, RESOURCE_TYPES, searchResources, type SearchFilters } from "./resource-search.js";

const DOCUMENTATION_URL = "https://support.access-ci.org/documentation/resources";

export class ComputeResourcesServer extends BaseAccessServer {
  private readonly documentation = new ResourceDocumentation((url) => this.httpClient.get(url));

  constructor() {
    super("access-mcp-compute-resources", version, "https://support.access-ci.org");
  }

  protected listingLinks(
    context: "list" | "search" | "details" = "list"
  ): Record<string, string> | undefined {
    return context === "details" ? undefined : { see_all_url: DOCUMENTATION_URL };
  }

  protected getTools(): ToolWithAccess[] {
    return [
      {
        name: "search_resources",
        mutates: false,
        description:
          "Find ACCESS resources from their documentation at " +
          "https://support.access-ci.org/documentation/resources. Returns {total, items}, " +
          "each with id (its global resource ID), accelerators, max_node_memory_gb, " +
          "max_cores_per_node, max_wall_time_hours, ondemand_url, transfer_methods and " +
          "citation_url. To find the largest, compare these fields across items. " +
          "With no filters it lists every documented resource. Hardware filters (has_gpu, " +
          "gpu_type, min_gpu_memory_gb, min_memory_gb, min_cores_per_node, cpu_type, " +
          "min_wall_time_hours) must all hold on one queue, and matching_queues shows which " +
          "queues do and what they have. Resources the documentation doesn't cover for a " +
          "filter are listed in `unchecked` with the filters it couldn't decide, rather " +
          "than counted as not matching, and " +
          "`unavailable` lists any whose page couldn't be read, so never say a resource " +
          "lacks something because it isn't in items. Only documented resources are " +
          "searched, so a resource that isn't found may be undocumented or no longer part " +
          "of ACCESS; don't describe its hardware from its name, point to the resource " +
          "provider instead. Query words match whole words and must all appear, so prefer filters for " +
          "hardware. Use get_resource for one resource's full detail and compare_resources " +
          "to set two or three side by side.",
        inputSchema: {
          type: "object",
          properties: {
            query: {
              type: "string",
              description:
                "Words that must all appear, as whole words or word beginnings, in a resource's name, group, organization, description, CPU or GPU models, queue names, datasets or top software (e.g. 'Delta', 'H100', 'AlphaFold'). Prefer the hardware filters to describing hardware in words.",
            },
            type: {
              type: "string",
              description: "Resource type: 'Compute' or 'Storage'",
            },
            organization: {
              type: "string",
              description:
                "Organization name or abbreviation (e.g. 'NCSA', 'Purdue', 'TACC'). A center's university also works, such as 'University of Illinois' for NCSA or 'Carnegie Mellon' for PSC",
            },
            status: {
              type: "string",
              description: "'production', 'pre-production' or 'post-production'",
            },
            has_gpu: {
              type: "boolean",
              description:
                "true: a queue has GPUs or other accelerators (Habana Gaudi, NEC Vector Engine). false: queues are documented and none has one.",
            },
            gpu_type: {
              type: "string",
              description: "Accelerator model text on a queue, e.g. 'H100', 'A100', 'Gaudi'",
            },
            min_gpu_memory_gb: {
              type: "number",
              description: "Minimum memory per GPU, in GB, on a GPU queue",
            },
            min_memory_gb: {
              type: "number",
              description: "Minimum RAM per node, in GB",
            },
            min_cores_per_node: {
              type: "number",
              description: "Minimum CPU cores per node",
            },
            cpu_type: {
              type: "string",
              description: "CPU model text on a queue, e.g. 'EPYC', 'Sapphire Rapids', 'Grace'",
            },
            min_wall_time_hours: {
              type: "number",
              description: "Minimum maximum job length a queue allows, in hours",
            },
            dataset: {
              type: "string",
              description: "Name of a dataset hosted on the resource, e.g. 'AlphaFold', 'COCO'",
            },
            ondemand: {
              type: "boolean",
              description: "true keeps resources with a documented Open OnDemand portal",
            },
            transfer_method: {
              type: "string",
              description: "Documented file transfer method, e.g. 'Globus', 'rsync', 'S3'",
            },
            fields: {
              type: "array",
              items: { type: "string" },
              description:
                "Project the response down to only these fields. Dotted path syntax: 'total', 'items[].name', 'items[].max_cores_per_node', 'items[].matching_queues', 'unchecked'. Omit to receive the full response.",
            },
          },
        },
        _meta: {
          supportsFieldProjection: true,
        },
      },
      {
        name: "get_resource",
        mutates: false,
        description:
          "Get a resource's documented details from " +
          "https://support.access-ci.org/documentation/resources: login, file transfer, " +
          "storage, queues, datasets, software and support links. Use it after search_resources " +
          "for the full detail on one resource, and cite citation_url. Accepts a name or global resource ID. A name covering several " +
          "resources, such as 'Delta', returns `matches` instead; call again with one of " +
          "them. A null value means the documentation doesn't cover it, not that the resource " +
          "lacks it or that anything is wrong. Resources work in different ways (batch " +
          "clusters, VMs, containers, storage, networks), so don't assume any of them has " +
          "queues, SSH or wait times. Describe what is documented, point to citation_url, and " +
          "never fill a gap from general knowledge. details_available false means only the " +
          "listing could be read. wait_times gives hours per queue and an as_of date when " +
          "there is reliable data; never estimate one. It is only the latest snapshot: for " +
          "wait times, job counts or usage over a period or by month, use XDMoD's " +
          "get_chart_data instead, and don't say a wait-time trend isn't tracked because " +
          "wait_times is null.",
        inputSchema: {
          type: "object",
          properties: {
            resource: {
              type: "string",
              description:
                "Resource name (e.g., 'ACES', 'Delta GPU') or global resource ID (e.g., 'delta-gpu.ncsa.access-ci.org')",
            },
            fields: {
              type: "array",
              items: { type: "string" },
              description:
                "Project the response down to only these fields. Dotted path syntax: 'name', 'citation_url', 'queues[].name', 'login.ssh_hosts'. Use to reduce payload size when you only need specific sections. Omit to receive the full response.",
            },
          },
          required: ["resource"],
        },
        _meta: {
          supportsFieldProjection: true,
        },
      },
      {
        name: "compare_resources",
        mutates: false,
        description:
          "Compare two or three resources from their documentation: access requirements, " +
          "login, transfer methods, queues, wait times, storage and software links, with a " +
          "citation_url for each. Accepts names or global resource IDs. `unresolved` lists names that " +
          "didn't settle on one resource, with `matches` to choose from when a name covers " +
          "several, such as 'Delta'. A null value means the documentation doesn't cover it, " +
          "not that the resource lacks it, so don't present a null next to a value as a " +
          "difference between resources. Resources work in different ways (batch clusters, " +
          "VMs, containers, storage, networks). Never estimate a wait time. Wait times here are " +
          "the latest snapshot; use XDMoD's get_chart_data to compare wait times or usage " +
          "over time. Use get_resource " +
          "for the full detail on one resource.",
        inputSchema: {
          type: "object",
          properties: {
            resources: {
              type: "array",
              items: { type: "string" },
              minItems: 2,
              maxItems: 3,
              description: "Two or three resource names or global resource IDs",
            },
          },
          required: ["resources"],
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
          return await this.search(toolArgs);
        case "get_resource":
          return await this.getResource(
            toolArgs.resource as string | undefined,
            toolArgs.fields as string[] | undefined
          );
        case "compare_resources":
          return await this.compareResources(toolArgs.resources as string[] | undefined);
        default:
          return this.errorResponse(`Unknown tool: ${name}`);
      }
    } catch (error) {
      return this.errorResponse(handleApiError(error));
    }
  }

  private async search(args: Record<string, unknown>): Promise<CallToolResult> {
    if (args.ondemand === false) {
      return this.errorResponse(
        "ondemand only accepts true: the documentation can't show that a resource has no OnDemand portal"
      );
    }
    const filters = Object.fromEntries(
      FILTER_KEYS.flatMap((key) => {
        const value = args[key];
        return value === undefined || value === null || value === "" ? [] : [[key, value]];
      })
    ) as SearchFilters;

    const result = searchResources(await this.documentation.all(), filters);
    const unknownType =
      filters.type && !RESOURCE_TYPES.some((type) => type.toLowerCase() === filters.type!.trim().toLowerCase());
    const hint = result.items.length > 0
      ? undefined
      : unknownType
        ? `type is one of ${RESOURCE_TYPES.join(" or ")}. For GPU or CPU systems use has_gpu.`
        : filters.query
          ? "No documented resource matches every word in query. If it names a resource, " +
            "ACCESS has no documentation for it: it may not be documented yet or may no longer " +
            "be an ACCESS resource. Say so and point to the resource provider rather than " +
            "describing its hardware. To search by hardware, use fewer words or filters such " +
            "as has_gpu, gpu_type or min_memory_gb."
          : undefined;

    const envelope = {
      total: result.items.length,
      items: result.items,
      unchecked: result.unchecked,
      ...(result.unavailable.length > 0 && { unavailable: result.unavailable }),
      ...(hint && { hint }),
      metadata: {
        filters_applied: Object.fromEntries(FILTER_KEYS.map((key) => [key, filters[key] ?? null])),
      },
      documentation: { links: this.listingLinks(Object.keys(filters).length ? "search" : "list") },
    };
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(projectFields(envelope, args.fields as string[] | undefined)),
        },
      ],
    };
  }

  private async getResource(input: string | undefined, fields?: string[]) {
    if (!input?.trim()) {
      return this.errorResponse("Provide a resource name or global resource ID");
    }

    const { resource, matches } = await this.documentation.resolve(input);
    if (matches?.length === 0) {
      return this.errorResponse(`Resource not found: '${input}'`, {
        hint: `Use search_resources, or the name shown at ${DOCUMENTATION_URL}`,
      });
    }

    const result = resource
      ? projectFields(await this.documentation.describe(resource), fields)
      : { resource: input, matches };
    return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
  }

  private async compareResources(inputs: string[] | undefined) {
    if (!Array.isArray(inputs) || inputs.length < 2 || inputs.length > 3) {
      return this.errorResponse("Provide two or three resources to compare");
    }

    const resolved = await Promise.all(
      inputs.map(async (input) => ({ input, ...(await this.documentation.resolve(input)) }))
    );
    const unique = new Set(resolved.flatMap(({ resource }) => resource ?? []));
    const items = await Promise.all(
      [...unique].map(async (resource) =>
        buildComparison(await this.documentation.describe(resource))
      )
    );
    const unresolved = resolved.flatMap(({ input, matches }) =>
      matches ? [{ resource: input, matches }] : []
    );

    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({ total: items.length, items, unresolved }),
        },
      ],
    };
  }

  async handleResourceRead(request: ReadResourceRequest): Promise<ReadResourceResult> {
    const { uri } = request.params;

    if (uri === "accessci://compute-resources") {
      return this.createTextResource(
        uri,
        "ACCESS-CI resource documentation - Use search_resources, get_resource and compare_resources to find resources and read their queues, storage, login and transfer details."
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
          step_3: "Use search_resources to find systems with those capabilities, e.g. has_gpu or min_memory_gb",
          step_4: "Review a system's queues, storage and login details with get_resource, or set candidates side by side with compare_resources",
          step_5: "Check software availability with software-discovery service",
        },
      };
      return this.createJsonResource(uri, matrix);
    }

    if (uri === "accessci://compute-resources/gpu-guide") {
      const guide = `# GPU Resource Selection Guide

GPU details come from the per-resource pages at
https://support.access-ci.org/documentation/resources, where each resource documents its
queues with accelerator model, count and memory.

## Finding GPU Resources

1. **search_resources** with \`has_gpu: true\` — lists resources with an accelerator on at
   least one queue, including non-NVIDIA ones such as Habana Gaudi. Add \`gpu_type\` (e.g.
   'H100') or \`min_gpu_memory_gb\` to narrow it, and read \`matching_queues\` for the
   partitions that qualify. Resources listed under \`unchecked\` have no queue
   documentation, which doesn't mean they have no GPUs.
2. **get_resource** — the full queue table, login and storage details for one resource.
3. **compare_resources** — two or three candidates side by side.

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

Use **search_resources** with **has_gpu: true** to find candidate systems, then
**get_resource** for the queues that have the GPUs, and cite its citation_url.
`;
      return this.createMarkdownResource(uri, guide);
    }

    if (uri === "accessci://compute-resources/resource-types") {
      return this.createJsonResource(uri, {
        description:
          "Resource types used by the ACCESS resource documentation. Filter search_resources by type, then by hardware within it.",
        resource_types: [
          { name: "Compute", description: "Batch clusters, cloud and VM platforms, and other systems that run jobs" },
          { name: "Storage", description: "Data storage and archive systems" },
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
2. **search_resources** with filters such as \`has_gpu\`, \`min_gpu_memory_gb\` or \`min_memory_gb\` — to narrow to systems with the hardware I need
3. **get_resource** or **compare_resources** — for queue, storage and access details on promising systems

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
}
