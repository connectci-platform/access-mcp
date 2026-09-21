import {
  BaseAccessServer,
  handleApiError,
  sanitizeGroupId,
  projectFields,
  Tool,
  Resource,
  CallToolResult,
} from "@access-mcp/shared";
import {
  CallToolRequest,
  ReadResourceRequest,
  ReadResourceResult,
} from "@modelcontextprotocol/sdk/types.js";
import { createRequire } from "module";
const require = createRequire(import.meta.url);
const { version } = require("../package.json");

interface SearchAffinityGroupsArgs {
  id?: string;
  include?: string;
  query?: string;
  limit?: number;
  fields?: string[];
}

export class AffinityGroupsServer extends BaseAccessServer {
  constructor() {
    super("access-mcp-affinity-groups", version);
  }

  protected listingLinks(
    context: "list" | "search" | "details" = "list"
  ): Record<string, string> | undefined {
    if (context === "list" || context === "search") {
      return { see_all_url: "https://support.access-ci.org/affinity-groups" };
    }
    return undefined;
  }

  protected getTools(): Tool[] {
    return [
      {
        name: "search_affinity_groups",
        description: "Search ACCESS-CI affinity groups. Returns {total, items}.",
        inputSchema: {
          type: "object",
          properties: {
            id: {
              type: "string",
              description: "Group ID (omit to list all)",
            },
            include: {
              type: "string",
              enum: ["events", "kb", "all"],
              description:
                "What to include with each group result. events = upcoming events for each group; kb = knowledge base articles; all = both events and KB articles",
            },
            query: {
              type: "string",
              description:
                "Filter groups by name, description, and category. Only applies when retrieving a list of affinity groups (when id is omitted).",
            },
            limit: {
              type: "number",
              description: "Max results (default: 20)",
              default: 20,
            },
            fields: {
              type: "array",
              items: { type: "string" },
              description:
                "Project the response down to only these fields. Dotted path syntax: 'total', 'items[].name', 'items[].description', 'metadata.pagination.has_more', etc. Use to reduce payload size when you only need specific fields. Omit to receive the full response. Only applies to listing/search results, not single-group lookups.",
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
    return [
      {
        uri: "accessci://affinity-groups",
        name: "ACCESS-CI Affinity Groups",
        description:
          "Information about ACCESS-CI affinity groups, their events, and knowledge base resources",
        mimeType: "application/json",
      },
    ];
  }

  protected async handleToolCall(request: CallToolRequest): Promise<CallToolResult> {
    const { name, arguments: args = {} } = request.params;

    try {
      switch (name) {
        case "search_affinity_groups":
          return await this.searchAffinityGroupsRouter(args as SearchAffinityGroupsArgs);
        default:
          return this.errorResponse(`Unknown tool: ${name}`);
      }
    } catch (error) {
      return this.errorResponse(handleApiError(error));
    }
  }

  private async searchAffinityGroupsRouter(
    args: SearchAffinityGroupsArgs
  ): Promise<CallToolResult> {
    const { id, include, query, limit, fields } = args;

    if (!id && !query) {
      return await this.listAffinityGroups(fields);
    }

    // Text search: filter groups by query matching name, description, category
    if (!id && query) {
      const allResult = await this.listAffinityGroups();
      const content = allResult.content[0];
      if (content.type !== "text") return allResult;

      const allData = JSON.parse(content.text);
      const terms = query.toLowerCase().split(/\s+/).filter(Boolean);

      const filtered = (allData.items || []).filter((group: Record<string, string>) => {
        const searchable = [
          group.name || "",
          group.description || "",
          group.category || "",
        ].join(" ").toLowerCase();
        return terms.some((term) => searchable.includes(term));
      });

      // Use explicit-undefined check so an honest limit: 0 (caller only
      // wants total + pagination) doesn't fall through to the full list.
      const limited = limit !== undefined ? filtered.slice(0, limit) : filtered;

      const envelope = {
        total: filtered.length,
        items: limited,
        metadata: {
          filters_applied: {
            query: query ?? null,
          },
          pagination: {
            limit: limit ?? filtered.length,
            offset: 0,
            has_more: limited.length < filtered.length,
          },
          query_relevance: "loose_match" as const,
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

    // At this point id is guaranteed to be set (early returns above handle !id cases)
    const groupId = id!;

    if (include === "all") {
      const [groupInfo, events, kb] = await Promise.all([
        this.getAffinityGroup(groupId),
        this.getAffinityGroupEvents(groupId),
        this.getAffinityGroupKB(groupId),
      ]);

      const groupContent = groupInfo.content[0];
      const eventsContent = events.content[0];
      const kbContent = kb.content[0];
      const groupText = groupContent.type === "text" ? groupContent.text : "";
      const eventsText = eventsContent.type === "text" ? eventsContent.text : "";
      const kbText = kbContent.type === "text" ? kbContent.text : "";

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              group: JSON.parse(groupText),
              events: JSON.parse(eventsText),
              knowledge_base: JSON.parse(kbText),
            }),
          },
        ],
      };
    }

    if (include === "events") {
      return await this.getAffinityGroupEvents(groupId);
    }

    if (include === "kb") {
      return await this.getAffinityGroupKB(groupId);
    }

    return await this.getAffinityGroup(groupId);
  }

  protected async handleResourceRead(request: ReadResourceRequest): Promise<ReadResourceResult> {
    const { uri } = request.params;

    if (uri === "accessci://affinity-groups") {
      const result = await this.listAffinityGroups();
      const content = result.content[0];
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

    throw new Error(`Unknown resource: ${uri}`);
  }

  private async getAffinityGroup(groupId: string): Promise<CallToolResult> {
    const sanitizedId = sanitizeGroupId(groupId);
    const response = await this.httpClient.get(`/1.1/affinity_groups/${sanitizedId}`);

    // Check if response data exists
    if (!response.data) {
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                total: 0,
                items: [],
              },
              null,
              2
            ),
          },
        ],
      };
    }

    // Clean up the response data - API returns array with single group
    const rawGroups = Array.isArray(response.data) ? response.data : [response.data];
    const cleanedGroups = rawGroups.map((group) => ({
      id: group?.field_group_id || group?.nid,
      name: group?.title, // Changed from title to name for consistency
      description: group?.description
        ?.replace(/<[^>]*>/g, "")
        .replace(/\\n/g, "\n")
        .trim(),
      coordinator: group?.coordinator_name,
      category: group?.field_affinity_group_category,
      slack_link: group?.slack_link,
      support_url: group?.url,
      ask_ci_forum: group?.field_ask_ci_locale,
    }));

    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(
            {
              total: cleanedGroups.length,
              items: cleanedGroups,
            },
            null,
            2
          ),
        },
      ],
    };
  }

  private async getAffinityGroupEvents(groupId: string): Promise<CallToolResult> {
    const sanitizedId = sanitizeGroupId(groupId);
    const response = await this.httpClient.get(`/1.1/events/ag/${sanitizedId}`);

    const events = Array.isArray(response.data) ? response.data : [];

    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(
            {
              total: events.length,
              items: events,
            },
            null,
            2
          ),
        },
      ],
    };
  }

  private async getAffinityGroupKB(groupId: string): Promise<CallToolResult> {
    const sanitizedId = sanitizeGroupId(groupId);
    const response = await this.httpClient.get(`/1.0/kb/${sanitizedId}`);

    const kbItems = Array.isArray(response.data) ? response.data : [];

    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(
            {
              total: kbItems.length,
              items: kbItems,
            },
            null,
            2
          ),
        },
      ],
    };
  }

  private async listAffinityGroups(fields?: string[]): Promise<CallToolResult> {
    const response = await this.httpClient.get("/1.1/affinity_groups/all");

    const groups = Array.isArray(response.data)
      ? response.data.map((group) => ({
          id: group.field_group_id || group.nid,
          name: group.title, // Changed from title to name for consistency
          description: group.description
            ?.replace(/<[^>]*>/g, "")
            .replace(/\\n/g, "\n")
            .trim(),
          coordinator: group.coordinator_name,
          category: group.field_affinity_group_category,
        }))
      : [];

    const envelope = {
      total: groups.length,
      items: groups,
      metadata: {
        pagination: {
          limit: groups.length,
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
          text: JSON.stringify(projectFields(envelope, fields), null, 2),
        },
      ],
    };
  }
}
