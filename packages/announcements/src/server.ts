import {
  BaseAccessServer,
  Tool,
  Resource,
  CallToolResult,
  DrupalAuthProvider,
  DrupalApiError,
  getRequestContext,
  projectFields,
  MAX_LIMIT,
  coerceOffset,
  coerceLimit,
  assertNoPublicWrites,
  type ToolWithAccess,
} from "@access-mcp/shared";
import {
  CallToolRequest,
  ReadResourceRequest,
  ReadResourceResult,
  GetPromptResult,
  Prompt,
} from "@modelcontextprotocol/sdk/types.js";
import { createRequire } from "module";
const require = createRequire(import.meta.url);
const { version } = require("../package.json");

// ============================================================================
// Types
// ============================================================================

interface SearchAnnouncementsArgs {
  query?: string;
  tags?: string;
  date?: string;
  limit?: number;
  offset?: number;
  fields?: string[];
}

interface AnnouncementFilters {
  query?: string;
  tags?: string;
  ag?: string;
  affiliation?: string;
  relative_start_date?: string;
  relative_end_date?: string;
  start_date?: string;
  end_date?: string;
  date?: string;
  limit?: number;
}

interface Announcement {
  uuid?: string; // Added in API v2.2 update
  title: string;
  body: string;
  published_date: string;
  affinity_group: string | string[];
  tags: string | string[]; // API returns comma-separated string, we convert to array
  affiliation: string;
  summary?: string;
}

interface CreateAnnouncementArgs {
  title: string;
  body: string;
  summary?: string;
  published_date?: string;
  tags?: string[];
  affiliation?: string;
  affinity_group?: string;
  external_link?: { uri: string; title?: string };
  where_to_share?: string[];
}

interface UpdateAnnouncementArgs {
  uuid: string;
  title?: string;
  body?: string;
  summary?: string;
  published_date?: string;
  tags?: string[];
  affinity_group?: string;
  external_link?: { uri: string; title?: string };
  where_to_share?: string[];
}

interface DeleteAnnouncementArgs {
  uuid: string;
  confirmed: boolean;
}

interface GetMyAnnouncementsArgs {
  limit?: number;
  fields?: string[];
}

// JSON:API response type for Drupal (still used by get_announcement_context,
// which reads affinity groups from a jsonapi_views display).
interface JsonApiResourceItem {
  id: string;
  type: string;
  attributes?: {
    drupal_internal__nid?: number;
    title?: string;
    status?: boolean;
    created?: string;
    name?: string;
    field_published_date?: string;
    field_group_id?: string;
    field_affinity_group_category?: string;
    body?: {
      value?: string;
      summary?: string;
    };
  };
}

// ============================================================================
// Server
// ============================================================================

export class AnnouncementsServer extends BaseAccessServer {
  private drupalAuth?: DrupalAuthProvider;
  private tagCache: Map<string, string> = new Map(); // name -> uuid
  private tagCacheExpiry?: Date;
  private static TAG_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

  constructor() {
    super("access-announcements", version, "https://support.access-ci.org", {
      requireApiKey: true,
    });
    assertNoPublicWrites(this.getTools() as ToolWithAccess[]);
  }

  /**
   * Get or create the Drupal auth provider for JSON:API write operations.
   * Requires DRUPAL_API_URL, DRUPAL_USERNAME, and DRUPAL_PASSWORD env vars.
   *
   * Acting user is determined in priority order:
   * 1. X-Acting-User header (from request context)
   * 2. ACTING_USER environment variable (fallback)
   */
  private getDrupalAuth(): DrupalAuthProvider {
    if (!this.drupalAuth) {
      const baseUrl = process.env.DRUPAL_API_URL;
      const username = process.env.DRUPAL_USERNAME;
      const password = process.env.DRUPAL_PASSWORD;

      if (!baseUrl || !username || !password) {
        throw new Error(
          "CRUD operations require DRUPAL_API_URL, DRUPAL_USERNAME, and DRUPAL_PASSWORD environment variables"
        );
      }

      this.drupalAuth = new DrupalAuthProvider(baseUrl, username, password);
    }

    return this.drupalAuth;
  }

  protected getTools(): Tool[] {
    const tools: ToolWithAccess[] = [
      // Read operations (existing)
      {
        name: "search_announcements",
        description:
          "Search ACCESS announcements (news, updates, notifications). Read-only view of public announcements. For managing your own announcements (update/delete), use get_my_announcements which returns UUIDs. Returns {total, items: [{title, summary, body, published_date, tags, affiliation, affinity_group}]}.",
        inputSchema: {
          type: "object",
          properties: {
            query: {
              type: "string",
              description: "Full-text search across title, body, and summary",
            },
            tags: {
              type: "string",
              description:
                "Filter by tag name. Examples: gpu, ml, hpc, open-ondemand, ACCESS-allocations, ACCESS-account, ai, pegasus. Use suggest_tags to discover tags from announcement content.",
            },
            date: {
              type: "string",
              description:
                "Time period filter: today, this_week (last 7 days), this_month (last 30 days), past (last year)",
              enum: ["today", "this_week", "this_month", "past"],
            },
            limit: {
              type: "number",
              description:
                "Max results (default: 25). Values above 500 are clamped to 500 and the response is marked `capped`; `total` always reflects the true corpus size regardless of the clamp.",
              default: 25,
            },
            offset: {
              type: "number",
              description:
                "Number of results to skip, for paging past the first `limit`. Default 0. The full corpus is fetched, so any offset within `total` is reachable.",
            },
            fields: {
              type: "array",
              items: { type: "string" },
              description:
                "Project the response down to only these fields. Dotted path syntax: 'total', 'items[].title', 'items[].published_date', 'metadata.pagination.has_more', etc. Use to reduce payload size when you only need specific fields. Omit to receive the full response.",
            },
          },
        },
        _meta: {
          supportsFieldProjection: true,
        },
        access: "public",
      },
      // CRUD operations (new)
      {
        name: "create_announcement",
        description: `Create a new ACCESS announcement (saved as draft for staff review).

BEFORE CALLING:
1. Call get_announcement_context to check coordinator status.
2. Gather information - either conversationally OR by parsing pasted content:
   - title (required): Clear, specific headline
   - body (required): Full content with details, dates, links. HTML supported.
   - summary (required): 1-2 sentence teaser for listings
   - tags (required): Call suggest_tags with the body text, then pass the returned english tag NAMES (the "name" field) as the tags array. Never pass ids or uuids.
   - affiliation (optional): "ACCESS Collaboration" or "Community" (default)
   - external_link (if relevant): URL and link text for external references
3. IF user is a coordinator (check get_announcement_context response):
   - affinity_group: Ask which group to associate with
   - where_to_share: Ask preferences (defaults: Announcements page + Bi-Weekly Digest)

WORKFLOW:
If user pastes content (event description, draft text, etc.):
1. Call get_announcement_context
2. Parse the pasted content to extract title, body, dates, links, etc.
3. Call suggest_tags with the body text — include returned tag names in the tags parameter
4. Call suggest_summary with the body text if no summary provided
5. Ask only about missing/unclear fields
6. If coordinator: ask about affinity group and where to share
7. Show preview (including tags) and get confirmation
8. Create the announcement with ALL fields including tags

If user describes what they want conversationally:
1. Call get_announcement_context
2. Guide them through providing title, body, summary
3. Call suggest_tags with the body text — include returned tag names in the tags parameter
4. If coordinator: ask about affinity group and where to share
5. Show preview (including tags) and get confirmation
6. Create the announcement with ALL fields including tags

IMPORTANT: Always pass the tags parameter when creating. Tags are english NAMES (strings) taken verbatim from the "name" field of suggest_tags — pass them as the tags array. Never pass ids or uuids; the tool resolves names internally.

PREVIEW FORMAT (show before creating):
---
**Title:** [title]
**Summary:** [summary or "None provided"]
**Body:**
[body content, truncate if very long]

**Tags:** [tag1, tag2, ...] or "None"
**Affiliation:** [affiliation or "Community (default)"]
**External Link:** [link text](url) or omit if none
[If coordinator:]
**Affinity Group:** [group name] or "None"
**Share to:** [list of selected options]
---
Ask "Does this look correct?" before creating.

Returns the write envelope {action:"create", status:"created", executed:true, data:{uuid, nid, title, edit_url, moderation_state}} (a "warning" is added when some tags could not be matched). Read "status" and "executed"; the created draft's fields are under "data".
ALWAYS display data.edit_url to the user so they can review their draft in Drupal.`,
        inputSchema: {
          type: "object",
          properties: {
            title: {
              type: "string",
              description: "Announcement title - clear and specific, under 100 characters",
            },
            body: {
              type: "string",
              description:
                "Full announcement content. HTML allowed (basic_html format: <p>, <a>, <strong>, <em>, <ul>, <li>)",
            },
            summary: {
              type: "string",
              description: "Brief teaser (1-2 sentences) shown in announcement listings. Required.",
            },
            published_date: {
              type: "string",
              description: "When to display (YYYY-MM-DD). Defaults to today.",
            },
            tags: {
              type: "array",
              items: { type: "string" },
              description:
                'English tag NAMES as strings, e.g. ["ai", "machine-learning", "gpu"]. Take these verbatim from the "name" field of the suggest_tags response. Pass names only — never ids or any other identifier.',
            },
            affiliation: {
              type: "string",
              description: "Source of announcement",
              enum: ["ACCESS Collaboration", "Community"],
            },
            affinity_group: {
              type: "string",
              description:
                "Affinity group name or UUID. User must be coordinator of the group. Use list_affinity_groups to find valid groups.",
            },
            external_link: {
              type: "object",
              description: "External link related to this announcement",
              properties: {
                uri: { type: "string", description: "URL (must include https://)" },
                title: { type: "string", description: "Link text to display" },
              },
              required: ["uri"],
            },
            where_to_share: {
              type: "array",
              items: { type: "string" },
              description:
                "Where to share the announcement. Defaults to 'Announcements page' + 'Bi-Weekly Digest'. Options: 'Announcements page', 'Bi-Weekly Digest', 'Affinity Group page', 'Email to Affinity Group'",
            },
          },
          required: ["title", "body", "summary"],
        },
        access: "authenticated",
        mutates: true,
      },
      {
        name: "update_announcement",
        description: `Update an existing announcement. User must own the announcement.

BEFORE CALLING:
1. Use get_my_announcements to find the announcement UUID
2. Confirm which fields the user wants to change
3. Only include fields that are changing
4. Show a preview of the changes and ask for confirmation before updating

Returns the write envelope {action:"update", status:"updated", executed:true, data:{uuid, title, edit_url}} (a "warning" is added when some tags could not be matched). Read "status" and "executed"; the updated fields are under "data".
ALWAYS display data.edit_url to the user so they can review changes in Drupal.`,
        inputSchema: {
          type: "object",
          properties: {
            uuid: {
              type: "string",
              description: "UUID of the announcement (get from get_my_announcements)",
            },
            title: {
              type: "string",
              description: "New title (only if changing)",
            },
            body: {
              type: "string",
              description: "New body content (only if changing)",
            },
            summary: {
              type: "string",
              description: "New summary (only if changing)",
            },
            published_date: {
              type: "string",
              description: "New publication date YYYY-MM-DD (only if changing)",
            },
            tags: {
              type: "array",
              items: { type: "string" },
              description:
                'New tags — replaces ALL existing tags (only if changing). English tag NAMES as strings, taken verbatim from the "name" field of suggest_tags. Never pass ids or uuids.',
            },
            affinity_group: {
              type: "string",
              description: "Affinity group name or UUID. User must be coordinator.",
            },
            external_link: {
              type: "object",
              description: "External link related to this announcement",
              properties: {
                uri: { type: "string", description: "URL (must include https://)" },
                title: { type: "string", description: "Link text to display" },
              },
              required: ["uri"],
            },
            where_to_share: {
              type: "array",
              items: { type: "string" },
              description:
                "Where to share the announcement. Options: 'Announcements page', 'Bi-Weekly Digest', 'Affinity Group page', 'Email to Affinity Group'",
            },
          },
          required: ["uuid"],
        },
        access: "authenticated",
        mutates: true,
      },
      {
        name: "delete_announcement",
        description: `Permanently delete an announcement. User must own the announcement.

CRITICAL: NEVER delete without explicit user confirmation for EACH announcement.

BEFORE CALLING (required for EVERY delete):
1. Use get_my_announcements to find the announcement
2. Show the user: "Delete '[title]' (status: [status])? This cannot be undone."
3. For published announcements, add warning: "⚠️ This is currently visible to the public."
4. Wait for explicit "yes" or confirmation - general statements like "sure" or "go ahead" are NOT sufficient
5. Only proceed after receiving clear confirmation for THIS SPECIFIC announcement

BULK DELETES: When user asks to delete multiple announcements, confirm EACH ONE individually.
Do NOT batch delete based on general consent. Each deletion requires its own confirmation prompt.

Returns the write envelope {action:"delete", status, executed, data}. "confirmed" is REQUIRED and preview-by-default: confirmed=false (or omitted, or any value other than strict true) previews — status:"preview", executed:false, data:{uuid, title}, writes NOTHING; confirmed=true performs the delete — status:"deleted", executed:true, data:{uuid}. Read "status"/"executed" to know which happened. A uuid the acting user does not own returns an error with code "not_found".`,
        inputSchema: {
          type: "object",
          properties: {
            uuid: {
              type: "string",
              description: "UUID of the announcement to delete",
            },
            confirmed: {
              type: "boolean",
              description:
                "Set to true only after user has explicitly confirmed deletion of THIS specific announcement. Required.",
            },
          },
          required: ["uuid", "confirmed"],
        },
        access: "authenticated",
        mutates: true,
      },
      {
        name: "get_my_announcements",
        description: `List all announcements created by the authenticated user.

Returns announcements with: uuid, nid, title, status (draft/published), created date, published_date, summary, tags (english NAMES, ready to display or reuse as the tags parameter for update_announcement), edit_url

Use this to:
- Find announcement UUIDs for update/delete operations
- Check status of submitted announcements
- Review what the user has created
- Get edit_url links for users to review in Drupal`,
        inputSchema: {
          type: "object",
          properties: {
            limit: {
              type: "number",
              description: "Max results (default: 25)",
              default: 25,
            },
            fields: {
              type: "array",
              items: { type: "string" },
              description:
                "Project the response down to only these fields. Dotted path syntax: 'total', 'items[].uuid', 'items[].title', 'items[].status', 'metadata.pagination.has_more', etc. Use to reduce payload size when you only need specific fields. Omit to receive the full response.",
            },
          },
        },
        _meta: {
          supportsFieldProjection: true,
        },
        access: "authenticated",
      },
      {
        name: "get_announcement_context",
        description: `Get user context and options BEFORE creating an announcement. Call this first.

Returns:
- affinity_groups: Groups the user coordinates (empty if not a coordinator)
- is_coordinator: Boolean - if true, ask about affinity_group and where_to_share
- affiliations: Available affiliation options
- where_to_share_options: Available sharing options (only relevant for coordinators)

Does NOT return tags — use suggest_tags after the user provides content.`,
        inputSchema: {
          type: "object",
          properties: {},
        },
        access: "public",
      },
      {
        name: "suggest_tags",
        description: `Suggest relevant tags for announcement content. Call this AFTER the user provides their announcement body text. Returns {tags: [{name, ...}]}. Use ONLY the "name" values (english words): show those names to the user and pass exactly those names as the tags array when calling create_announcement or update_announcement. Ignore any id/uuid fields — they are internal and must never be passed to create/update.`,
        inputSchema: {
          type: "object",
          properties: {
            text: {
              type: "string",
              description: "The announcement body text to analyze for tag suggestions. Must be at least 100 characters.",
            },
            limit: {
              type: "number",
              description: "Maximum number of tags to suggest (default: 6)",
            },
          },
          required: ["text"],
        },
        access: "authenticated",
      },
      {
        name: "suggest_summary",
        description: `Generate a concise summary for announcement content. Call this to auto-generate a summary from the announcement body. Returns a summary of up to 150 characters.`,
        inputSchema: {
          type: "object",
          properties: {
            text: {
              type: "string",
              description: "The announcement body text to summarize. Must be at least 100 characters.",
            },
          },
          required: ["text"],
        },
        access: "authenticated",
      },
    ];
    return tools;
  }

  protected getResources(): Resource[] {
    return [
      {
        uri: "accessci://announcements",
        name: "ACCESS Support Announcements",
        description: "Recent announcements and notifications from ACCESS support",
        mimeType: "application/json",
      },
    ];
  }

  protected getPrompts(): Prompt[] {
    return [
      {
        name: "create_announcement_guide",
        description: "Guide the user through creating a new ACCESS announcement step by step",
        arguments: [
          {
            name: "topic",
            description:
              "Brief description of what the announcement is about (optional, helps tailor guidance)",
            required: false,
          },
        ],
      },
      {
        name: "manage_announcements_guide",
        description: "Help the user view, update, or delete their existing announcements",
        arguments: [],
      },
    ];
  }

  protected async handleGetPrompt(request: {
    params: { name: string; arguments?: Record<string, string> };
  }): Promise<GetPromptResult> {
    const { name, arguments: args = {} } = request.params;

    if (name === "create_announcement_guide") {
      const topic = args.topic || "";

      return {
        description: "Guide for creating an ACCESS announcement",
        messages: [
          {
            role: "user",
            content: {
              type: "text",
              text: topic
                ? `I want to create an announcement about: ${topic}`
                : "I want to create a new announcement",
            },
          },
          {
            role: "assistant",
            content: {
              type: "text",
              text: `I'll help you create an ACCESS announcement. Let me check your options first.

Once you provide the content, I'll suggest relevant tags and generate a summary automatically.

**Required Information:**

1. **Title** - A clear, concise title (under 100 characters)

2. **Body** - The main content (HTML supported)

**Recommended:**

3. **Summary** - Brief teaser (1-2 sentences) for listings

4. **Tags** - Help users find your announcement (1-6 recommended)

**Optional:**

5. **Affiliation** - "ACCESS Collaboration" or "Community" (default)

6. **External Link** - If referencing external content

**For Affinity Group Coordinators:**
- Associate with your affinity group
- Choose where to share (Announcements page, Bi-Weekly Digest, Affinity Group page, Email to group)

**Important:** Announcements are created as **drafts** requiring staff review. You'll receive an edit URL.

Let me check your context first, then we'll get started!${topic ? `\n\nI see you want to announce something about "${topic}" - I'll help you craft that.` : ""}`,
            },
          },
        ],
      };
    }

    if (name === "manage_announcements_guide") {
      return {
        description: "Guide for managing existing announcements",
        messages: [
          {
            role: "user",
            content: {
              type: "text",
              text: "I want to manage my announcements",
            },
          },
          {
            role: "assistant",
            content: {
              type: "text",
              text: `I can help you manage your ACCESS announcements. Here's what you can do:

**View Your Announcements**
Use \`get_my_announcements\` to see all announcements you've created, including:
- Draft announcements awaiting review
- Published announcements
- Their current status

**Update an Announcement**
Use \`update_announcement\` with the announcement's UUID to modify:
- Title
- Body content
- Summary
- Published date
- Tags

**Delete an Announcement**
Use \`delete_announcement\` with the UUID to remove an announcement you own.

Would you like me to:
1. **List your announcements** - See what you've created
2. **Update a specific announcement** - Make changes to an existing one
3. **Delete an announcement** - Remove one you no longer need

Which would you like to do?`,
            },
          },
        ],
      };
    }

    throw new Error(`Unknown prompt: ${name}`);
  }

  protected async handleToolCall(request: CallToolRequest): Promise<CallToolResult> {
    const { name, arguments: args } = request.params;

    try {
      switch (name) {
        // Read operations
        case "search_announcements":
          return await this.searchAnnouncements(args as SearchAnnouncementsArgs);

        // CRUD operations
        case "create_announcement":
          return await this.createAnnouncement(args as unknown as CreateAnnouncementArgs);
        case "update_announcement":
          return await this.updateAnnouncement(args as unknown as UpdateAnnouncementArgs);
        case "delete_announcement":
          return await this.deleteAnnouncement(args as unknown as DeleteAnnouncementArgs);
        case "get_my_announcements":
          return await this.getMyAnnouncements(args as unknown as GetMyAnnouncementsArgs);

        // Helper operations
        case "get_announcement_context":
          return await this.getAnnouncementContext();
        case "suggest_tags":
          return await this.suggestTags(args as { text: string; limit?: number });
        case "suggest_summary":
          return await this.suggestSummary(args as { text: string });

        default:
          return this.errorResponse(`Unknown tool: ${name}`);
      }
    } catch (error) {
      // A persistent Drupal auth failure (an expired session the shared auth
      // layer could not recover, or a re-login that itself failed) gets the
      // structured envelope instead of the raw upstream text, e.g.
      // "Drupal API error: 307 Temporary Redirect".
      const authError = this.drupalAuthError(error);
      if (authError) return authError;
      const message = error instanceof Error ? error.message : String(error);
      return this.errorResponse(message);
    }
  }

  protected async handleResourceRead(request: ReadResourceRequest): Promise<ReadResourceResult> {
    const { uri } = request.params;

    if (uri === "accessci://announcements") {
      try {
        const announcements = await this.fetchAnnouncements({ limit: 10 });
        return {
          contents: [
            {
              uri,
              mimeType: "application/json",
              text: JSON.stringify(announcements, null, 2),
            },
          ],
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          contents: [
            {
              uri,
              mimeType: "text/plain",
              text: `Error loading announcements: ${message}`,
            },
          ],
        };
      }
    }

    throw new Error(`Unknown resource: ${uri}`);
  }

  // ============================================================================
  // Read Operations (existing)
  // ============================================================================

  private buildAnnouncementsUrl(filters: AnnouncementFilters): string {
    const params = new URLSearchParams();
    // Fetch the entire filtered corpus in one request so search_announcements
    // can report an EXACT total and slice [offset, offset+limit) locally —
    // this server's `All` value (verified live) returns the true corpus, not
    // a capped page, which the {5,10,25,50} bucketed sizes could not give us.
    params.append("items_per_page", "All");

    if (filters.query) {
      params.append("search_api_fulltext", filters.query);
    }

    if (filters.tags) {
      params.append("tags", filters.tags);
    }

    const dateMap: Record<string, { start: string; end?: string }> = {
      today: { start: "today" },
      this_week: { start: "-1 week", end: "now" },
      this_month: { start: "-1 month", end: "now" },
      past: { start: "-1 year", end: "now" },
    };

    if (filters.date && dateMap[filters.date]) {
      const dateRange = dateMap[filters.date];
      params.append("relative_start_date", dateRange.start);
      if (dateRange.end) {
        params.append("relative_end_date", dateRange.end);
      }
    }

    return `/api/2.2/announcements?${params.toString()}`;
  }

  private async fetchAnnouncements(filters: AnnouncementFilters): Promise<Announcement[]> {
    const url = this.buildAnnouncementsUrl(filters);
    const response = await this.httpClient.get(url);

    if (response.status !== 200) {
      throw new Error(`API Error ${response.status}: ${response.statusText}`);
    }

    const announcements = response.data || [];
    return this.enhanceAnnouncements(announcements);
  }

  private enhanceAnnouncements(rawAnnouncements: Announcement[]): Announcement[] {
    return rawAnnouncements.map((announcement) => ({
      ...announcement,
      // Tags come as comma-separated string from public API, convert to array
      tags: Array.isArray(announcement.tags)
        ? announcement.tags
        : typeof announcement.tags === "string" && announcement.tags.trim()
          ? announcement.tags.split(",").map((t: string) => t.trim())
          : [],
      summary:
        announcement.summary ||
        (announcement.body
          ? announcement.body.replace(/<[^>]*>/g, "").substring(0, 200) + "..."
          : ""),
    }));
  }

  protected listingLinks(
    context: "list" | "search" | "details" = "list"
  ): Record<string, string> | undefined {
    if (context === "list" || context === "search") {
      return { see_all_url: "https://support.access-ci.org/announcements" };
    }
    return undefined;
  }

  private async searchAnnouncements(filters: SearchAnnouncementsArgs): Promise<CallToolResult> {
    const fetched = await this.fetchAnnouncements(filters);
    // `fetched` is the ENTIRE filtered corpus (items_per_page=All), so its
    // length is a true, exact total — not a lower bound like events/nsf,
    // which can only ever see one upstream page at a time.
    const total = fetched.length;

    if (total > MAX_LIMIT) {
      // Not a response guard — the slice below still returns a correct
      // window and `total` stays exact. This just makes it loud in logs
      // that fetch-All is no longer cheap and page-based pagination should
      // be considered, before that migration is otherwise triggered by a
      // performance complaint.
      this.logger.warn(
        `announcements corpus (${total}) exceeded ${MAX_LIMIT}; fetch-All pagination is unbounded — consider page-based pagination`
      );
    }

    const offset = coerceOffset(filters.offset);
    const requestedLimit = coerceLimit(filters.limit, 25);
    const limit = Math.min(requestedLimit, MAX_LIMIT);
    const window = fetched.slice(offset, offset + limit);

    const envelope = {
      total,
      items: window,
      metadata: {
        pagination: {
          limit,
          offset,
          total,
          has_more: offset + window.length < total,
          ...(limit < requestedLimit ? { capped: true as const } : {}),
        },
        query_relevance: filters.query ? ("loose_match" as const) : ("exact" as const),
        filters_applied: {
          query: filters.query ?? null,
          tags: filters.tags ?? null,
          date: filters.date ?? null,
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
          text: JSON.stringify(projectFields(envelope, filters.fields)),
        },
      ],
    };
  }

  // ============================================================================
  // CRUD Operations (new)
  // ============================================================================

  /**
   * Get the acting user's ACCESS ID for content attribution.
   *
   * Priority order:
   * 1. X-Acting-User header (from request context)
   * 2. ACTING_USER environment variable (fallback)
   *
   * Returns the ACCESS ID (e.g., "username@access-ci.org")
   */
  private getActingUserAccessId(): string {
    // Try request context first
    const context = getRequestContext();
    if (context?.actingUser) {
      return context.actingUser;
    }

    // Fall back to environment variable
    const envUser = process.env.ACTING_USER;
    if (envUser) {
      return envUser;
    }

    throw new Error(
      "Authentication required: No acting user specified.\n\n" +
        "Please authenticate with your ACCESS-CI credentials to use this tool. " +
        "If using Claude, add this server as an authenticated connector via Customize > Connectors."
    );
  }

  /**
   * Create a new announcement via Drupal JSON:API
   *
   * The X-Acting-User header (built from the actingUser passed into each
   * provider call) tells Drupal which ACCESS user is creating the content.
   * Drupal handles user resolution.
   */
  private async createAnnouncement(args: CreateAnnouncementArgs): Promise<CallToolResult> {
    const actingUser = this.getActingUserAccessId();
    const auth = this.getDrupalAuth();

    // Build a FLAT request body for the custom Drupal controller at
    // POST /api/2.3/announcements. The controller runs the write AS the acting
    // user (per-user permissions) and json_decodes the raw body — no JSON:API
    // envelope. It hardcodes moderation_state=draft, so we do NOT send it.
    // The controller reads Drupal machine-name keys (verified against
    // AnnouncementApiController): title; body ({value, summary} or a string);
    // field_published_date; field_affiliation; field_tags (term UUIDs);
    // field_affinity_group_node (node UUIDs); field_news_external_link;
    // field_choose_where_to_share_this. Summary is NESTED inside body.
    const bodyField: { value: string; summary?: string } = { value: args.body };
    if (args.summary) {
      bodyField.summary = args.summary;
    }
    const requestBody: Record<string, unknown> = {
      title: args.title,
      body: bodyField,
    };

    requestBody.field_published_date = args.published_date
      ? args.published_date
      // Default to today
      : new Date().toISOString().split("T")[0];

    if (args.affiliation) {
      requestBody.field_affiliation = args.affiliation;
    }

    // Look up tag UUIDs if tags provided (controller resolves field_tags by uuid)
    const unmatchedTags: string[] = [];
    if (args.tags && args.tags.length > 0) {
      const { uuids: tagUuids, unmatched } = await this.resolveTagNames(actingUser, args.tags);
      unmatchedTags.push(...unmatched);
      if (tagUuids.length > 0) {
        requestBody.field_tags = tagUuids;
      }
    }

    // Look up affinity group UUID if provided (controller resolves
    // field_affinity_group_node by uuid — settled identifier contract)
    if (args.affinity_group) {
      const groupUuid = await this.getAffinityGroupUuid(actingUser, args.affinity_group);
      if (groupUuid) {
        requestBody.field_affinity_group_node = [groupUuid];
      } else {
        throw new Error(
          `Affinity group not found: ${args.affinity_group}. Use list_affinity_groups to see groups you coordinate.`
        );
      }
    }

    // Add external link if provided
    if (args.external_link) {
      requestBody.field_news_external_link = {
        uri: args.external_link.uri,
        title: args.external_link.title || "",
      };
    }

    // Add where to share (defaults handled by Drupal if not provided)
    if (args.where_to_share && args.where_to_share.length > 0) {
      requestBody.field_choose_where_to_share_this = this.normalizeWhereToShare(args.where_to_share);
    }

    const result = await auth.post(actingUser, "/api/2.3/announcements", requestBody);

    // Controller returns a flat {success, uuid, nid, title, edit_url}.
    // Prefer the server-computed edit_url; fall back to building it from nid.
    const editUrl =
      result.edit_url ?? `${process.env.DRUPAL_API_URL}/node/${result.nid}/edit`;

    const warning =
      unmatchedTags.length > 0
        ? `These tags were not found and were skipped: ${unmatchedTags.join(", ")}. Use suggest_tags to get valid tag names.`
        : undefined;

    return this.writeResponse({
      action: "create",
      status: "created",
      executed: true,
      data: {
        uuid: result.uuid,
        nid: result.nid,
        title: result.title,
        edit_url: editUrl,
        moderation_state: "draft",
      },
      ...(warning && { warning }),
    });
  }

  /**
   * Update an existing announcement via Drupal JSON:API
   */
  private async updateAnnouncement(args: UpdateAnnouncementArgs): Promise<CallToolResult> {
    const actingUser = this.getActingUserAccessId();
    const auth = this.getDrupalAuth();

    // Build a FLAT body of only the changed fields for the custom controller at
    // PATCH /api/2.3/announcements/{uuid}. The controller applies only the fields
    // sent (no fetch-and-preserve pre-read) and reads Drupal machine-name keys;
    // summary is NESTED in body. Body/summary are sent together as one body
    // object when either changes; the controller preserves the untouched half.
    const requestBody: Record<string, unknown> = {};

    // Add fields to update
    if (args.title) {
      requestBody.title = args.title;
    }

    if (args.body !== undefined || args.summary !== undefined) {
      const bodyField: { value?: string; summary?: string } = {};
      if (args.body !== undefined) {
        bodyField.value = args.body;
      }
      if (args.summary !== undefined) {
        bodyField.summary = args.summary;
      }
      requestBody.body = bodyField;
    }

    if (args.published_date) {
      requestBody.field_published_date = args.published_date;
    }

    // Update tags if provided (controller resolves field_tags by uuid)
    const unmatchedTags: string[] = [];
    if (args.tags && args.tags.length > 0) {
      const { uuids: tagUuids, unmatched } = await this.resolveTagNames(actingUser, args.tags);
      unmatchedTags.push(...unmatched);
      if (tagUuids.length > 0) {
        requestBody.field_tags = tagUuids;
      }
    }

    // Update affinity group if provided (controller resolves by uuid)
    if (args.affinity_group) {
      const groupUuid = await this.getAffinityGroupUuid(actingUser, args.affinity_group);
      if (groupUuid) {
        requestBody.field_affinity_group_node = [groupUuid];
      } else {
        throw new Error(
          `Affinity group not found: ${args.affinity_group}. Use list_affinity_groups to see groups you coordinate.`
        );
      }
    }

    // Update external link if provided
    if (args.external_link) {
      requestBody.field_news_external_link = {
        uri: args.external_link.uri,
        title: args.external_link.title || "",
      };
    }

    // Update where to share if provided
    if (args.where_to_share && args.where_to_share.length > 0) {
      requestBody.field_choose_where_to_share_this = this.normalizeWhereToShare(args.where_to_share);
    }

    const result = await auth.patch(
      actingUser,
      `/api/2.3/announcements/${args.uuid}`,
      requestBody
    );

    // Controller returns a flat {success, uuid, title, edit_url}.
    // Update's edit_url can be null — no nid fallback here (unlike create).
    const warning =
      unmatchedTags.length > 0
        ? `These tags were not found and were skipped: ${unmatchedTags.join(", ")}. Use suggest_tags to get valid tag names.`
        : undefined;

    return this.writeResponse({
      action: "update",
      status: "updated",
      executed: true,
      data: {
        uuid: result.uuid,
        title: result.title,
        edit_url: result.edit_url ?? null,
      },
      ...(warning && { warning }),
    });
  }

  /**
   * Delete an announcement via Drupal JSON:API
   */
  private async deleteAnnouncement(args: DeleteAnnouncementArgs): Promise<CallToolResult> {
    // Resolve the acting user first so an unauthenticated caller fails before
    // any provider call (preview or delete).
    const actingUser = this.getActingUserAccessId();
    const auth = this.getDrupalAuth();

    // confirmed is REQUIRED and execute-gated on STRICT === true. Any other
    // value (false, or a truthy-but-not-true like "true"/1) is a PREVIEW that
    // writes NOTHING — it only reads the title so the caller can confirm.
    if (args.confirmed !== true) {
      // There is no single-item GET-by-uuid route; a user can only delete their
      // OWN announcements, so the title comes from GET /announcements/mine.
      // Pass an explicit high limit (mirrors get_my_announcements' bounded fetch)
      // so a user owning more announcements than the controller's default page
      // cap can still preview any of their own — without it, a deletable uuid
      // past the first page would wrongly read as not_found.
      let mine: { items?: Array<{ uuid?: string; title?: string }> };
      try {
        mine = await auth.get(actingUser, `/api/2.3/announcements/mine?limit=1000`);
      } catch (error) {
        // A persistent auth failure is diagnosed first: coding an expired
        // session as upstream_error would hide it behind "try again shortly",
        // which is the wrong advice and swallows it before the tool-call-level
        // mapping can see it.
        const authError = this.drupalAuthError(error);
        if (authError) return authError;
        // The preview lookup can itself fail. A failed list-fetch means the
        // lookup failed, NOT that the announcement is absent — so carry a coded
        // upstream_error (never not_found), matching the execute path's habit of
        // a machine-readable code instead of a bare {error}.
        if (error instanceof DrupalApiError) {
          return this.errorResponse(
            `Announcements service error (${error.status})`,
            { hint: "Try again shortly.", code: "upstream_error" }
          );
        }
        throw error;
      }
      const item = (mine.items || []).find(
        (i: { uuid?: string }) => i.uuid === args.uuid
      );

      if (!item) {
        return this.errorResponse(
          "Announcement not found (or not yours).",
          { hint: "Check the uuid via get_my_announcements.", code: "not_found" }
        );
      }

      return this.writeResponse({
        action: "delete",
        status: "preview",
        executed: false,
        data: { uuid: args.uuid, title: item.title },
      });
    }

    // Confirmed: perform the delete. Custom controller:
    // DELETE /api/2.3/announcements/{uuid} → flat {success, uuid}.
    try {
      await auth.delete(actingUser, `/api/2.3/announcements/${args.uuid}`);
    } catch (error) {
      // Post-#30: branch on the structured DrupalApiError.status instead of
      // string-matching "404" in the message (which could false-match a 404 in
      // an unrelated part of the text).
      if (error instanceof DrupalApiError && error.status === 404) {
        return this.errorResponse(
          "Announcement not found (or not yours).",
          { hint: "Check the uuid via get_my_announcements.", code: "not_found" }
        );
      }
      throw error;
    }

    return this.writeResponse({
      action: "delete",
      status: "deleted",
      executed: true,
      data: { uuid: args.uuid },
    });
  }

  /**
   * Get announcements created by the acting user.
   *
   * Uses a Drupal Views page display exposed via jsonapi_views at
   * /jsonapi/views/mcp_my_announcements/page_1.
   * The JsonApiViewsUserParameterSubscriber resolves X-Acting-User header to uid
   * and injects it as the contextual filter argument, so no user UUID lookup is needed.
   */
  private async getMyAnnouncements(args: GetMyAnnouncementsArgs): Promise<CallToolResult> {
    const auth = this.getDrupalAuth();

    // Ensure acting user is set (will throw if not available)
    const actingUser = this.getActingUserAccessId();

    // coerceLimit (not `|| 25`): `||` turned an explicit 0 into 25, and left a
    // negative limit unclamped into this tool's own `slice(0, limit)` below (a
    // negative limit there is also a slice-from-the-end footgun) and into the
    // `limit + 1` fetch param.
    const limit = coerceLimit(args.limit, 25);
    // Fetch one extra so has_more distinguishes exact-limit from
    // limit-plus-more (avoids the >=limit false-positive when the
    // user's total is exactly the requested cap).
    // Custom controller: GET /api/2.3/announcements/mine?limit=N → {items: [...]}.
    // Each item is already in final shape: status is a STRING ("published"/"draft"),
    // summary is already HTML-stripped, edit_url is already built — pass through
    // verbatim (no boolean→string derive, no re-strip, no edit_url rebuild).
    const result = await auth.get(
      actingUser,
      `/api/2.3/announcements/mine?limit=${limit + 1}`
    );

    const fetchedItems = result.items || [];
    const hasMore = fetchedItems.length > limit;
    const slicedItems = fetchedItems.slice(0, limit);
    const announcements = slicedItems.map(
      (item: {
        uuid?: string;
        nid?: number;
        title?: string;
        status?: string;
        created?: string;
        published_date?: string | null;
        summary?: string;
        // Tags are english NAMES from the controller (never ids) — pass through.
        tags?: string[];
        edit_url?: string | null;
      }) => ({
        uuid: item.uuid,
        nid: item.nid,
        title: item.title,
        status: item.status,
        created: item.created,
        published_date: item.published_date,
        summary: item.summary,
        tags: item.tags ?? [],
        edit_url: item.edit_url,
      })
    );

    // Bare page-length was reported as `total` before, which is a lie once
    // has_more is true (there's more beyond what was fetched). No true count
    // is available from this endpoint — it's a limit+1 probe, not a full
    // fetch — so total is a lower bound: what we can prove exists. offset
    // stays 0, but now legitimately: this tool does not page (jsonapi
    // page[offset] support is unverified), so record 0 really is where
    // every call starts.
    const total_lower_bound = announcements.length;

    const envelope = {
      total: total_lower_bound,
      items: announcements,
      metadata: {
        pagination: {
          limit,
          offset: 0,
          total_lower_bound,
          has_more: hasMore,
        },
      },
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

  // ============================================================================
  // Helper Methods
  // ============================================================================

  /**
   * Get announcement context - tags, affinity groups, and options for creating announcements.
   *
   * Uses a Drupal Views page display exposed via jsonapi_views at
   * /jsonapi/views/mcp_my_affinity_groups/page_1 for affinity groups lookup.
   * The JsonApiViewsUserParameterSubscriber resolves X-Acting-User header to uid,
   * so no user UUID lookup is needed.
   */
  private async getAnnouncementContext(): Promise<CallToolResult> {
    const auth = this.getDrupalAuth();

    // Ensure acting user is set (will throw if not available)
    const actingUser = this.getActingUserAccessId();

    // Fetch affinity groups the user coordinates.
    // Tags are NOT fetched here — use suggest_tags tool after the user provides content.
    const groupsResult = await auth.get(actingUser, "/jsonapi/views/mcp_my_affinity_groups/page_1");

    const affinityGroups = (groupsResult.data || []).map((item: JsonApiResourceItem) => ({
      id: item.attributes?.field_group_id,
      uuid: item.id,
      name: item.attributes?.title,
      category: item.attributes?.field_affinity_group_category,
    }));

    const isCoordinator = affinityGroups.length > 0;

    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({
            affinity_groups: affinityGroups,
            is_coordinator: isCoordinator,
            affiliations: ["ACCESS Collaboration", "Community"],
            where_to_share_options: [
              { value: "Announcements page", description: "Public announcements listing" },
              { value: "Bi-Weekly Digest", description: "ACCESS Support bi-weekly email digest" },
              {
                value: "Affinity Group page",
                description: "Your affinity group's page (coordinators only)",
              },
              {
                value: "Email to Affinity Group",
                description: "Direct email to affinity group members (coordinators only)",
              },
            ],
            guidance: isCoordinator
              ? "User is an affinity group coordinator. Ask about affinity_group association and where_to_share preferences."
              : "User is not a coordinator. Standard announcement fields apply.",
          }),
        },
      ],
    };
  }

  /**
   * Suggest tags for announcement content using Drupal's AI tag suggestion service.
   */
  private static readonly JSON_HEADERS = {
    "Content-Type": "application/json",
    Accept: "application/json",
  };

  private async suggestTags(args: { text: string; limit?: number }): Promise<CallToolResult> {
    const actingUser = this.getActingUserAccessId();

    if (!args.text || args.text.length < 100) {
      return this.errorResponse("Text must be at least 100 characters for tag suggestions.");
    }

    const auth = this.getDrupalAuth();
    const limit = args.limit || 6;
    const result = await auth.post(actingUser, "/api/suggest-tags", {
      text: args.text,
      limit,
    }, AnnouncementsServer.JSON_HEADERS);

    if (result.tags) {
      const tags = result.tags.slice(0, limit);
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            suggested_tags: tags.map((t: { name: string; uuid: string }) => t.name),
            tag_details: tags,
          }),
        }],
      };
    }

    return this.errorResponse(result.error || "Tag suggestion failed");
  }

  /**
   * Generate a summary for announcement content using Drupal's AI summary service.
   */
  private async suggestSummary(args: { text: string }): Promise<CallToolResult> {
    const actingUser = this.getActingUserAccessId();

    if (!args.text || args.text.length < 100) {
      return this.errorResponse("Text must be at least 100 characters for summary generation.");
    }

    const auth = this.getDrupalAuth();
    const result = await auth.post(actingUser, "/api/suggest-summary", {
      text: args.text,
    }, AnnouncementsServer.JSON_HEADERS);

    if (result.summary) {
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({ summary: result.summary }),
        }],
      };
    }

    return this.errorResponse(result.error || "Summary generation failed");
  }

  /**
   * Look up affinity group UUID by ID or name
   */
  private async getAffinityGroupUuid(actingUser: string, idOrName: string): Promise<string | null> {
    const auth = this.getDrupalAuth();

    // If it looks like a UUID, return as-is
    if (idOrName.match(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)) {
      return idOrName;
    }

    // Try by field_group_id first
    let result = await auth.get(
      actingUser,
      `/jsonapi/node/affinity_group?filter[field_group_id]=${encodeURIComponent(idOrName)}&filter[status]=1`
    );

    if (result.data && result.data.length > 0) {
      return result.data[0].id;
    }

    // Try by title
    result = await auth.get(
      actingUser,
      `/jsonapi/node/affinity_group?filter[title]=${encodeURIComponent(idOrName)}&filter[status]=1`
    );

    if (result.data && result.data.length > 0) {
      return result.data[0].id;
    }

    return null;
  }

  /**
   * Map human-friendly "where to share" labels to Drupal values
   */
  private static WHERE_TO_SHARE_MAP: Record<string, string> = {
    "announcements page": "on_the_announcements_page",
    "on the announcements page": "on_the_announcements_page",
    "bi-weekly digest": "in_the_access_support_bi_weekly_digest",
    "in the access support bi-weekly digest": "in_the_access_support_bi_weekly_digest",
    "affinity group page": "on_your_affinity_group_page",
    "on your affinity group page": "on_your_affinity_group_page",
    "email to affinity group": "email_to_your_affinity_group",
    "email to your affinity group": "email_to_your_affinity_group",
    // Also accept the raw values
    on_the_announcements_page: "on_the_announcements_page",
    in_the_access_support_bi_weekly_digest: "in_the_access_support_bi_weekly_digest",
    on_your_affinity_group_page: "on_your_affinity_group_page",
    email_to_your_affinity_group: "email_to_your_affinity_group",
  };

  private normalizeWhereToShare(values: string[]): string[] {
    return values.map((v) => {
      const normalized = AnnouncementsServer.WHERE_TO_SHARE_MAP[v.toLowerCase()];
      if (!normalized) {
        throw new Error(
          `Invalid where_to_share value: "${v}". ` +
            `Valid options: 'Announcements page', 'Bi-Weekly Digest', 'Affinity Group page', 'Email to Affinity Group'`
        );
      }
      return normalized;
    });
  }

  /**
   * Check if tag cache is still valid
   */
  private isTagCacheValid(): boolean {
    return this.tagCacheExpiry !== undefined && new Date() < this.tagCacheExpiry;
  }

  /**
   * Populate the tag cache with all available tags
   */
  private async populateTagCache(actingUser: string): Promise<void> {
    const auth = this.getDrupalAuth();
    try {
      this.tagCache.clear();
      let url: string | null = "/jsonapi/taxonomy_term/tags?page[limit]=50";
      let pageCount = 0;
      const MAX_PAGES = 100;

      while (url && pageCount < MAX_PAGES) {
        pageCount++;
        const result = await auth.get(actingUser, url);
        for (const item of result.data || []) {
          const name = item.attributes?.name?.toLowerCase();
          if (name && item.id) {
            this.tagCache.set(name, item.id);
          }
        }
        // Follow pagination links
        const nextHref = result.links?.next?.href;
        if (nextHref) {
          try {
            const parsed = new URL(nextHref);
            url = parsed.pathname + parsed.search;
          } catch {
            url = nextHref; // Already a relative path
          }
        } else {
          url = null;
        }
      }

      this.logger.info("Tag cache populated", { count: this.tagCache.size });
      this.tagCacheExpiry = new Date(Date.now() + AnnouncementsServer.TAG_CACHE_TTL_MS);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      this.logger.error("Failed to populate tag cache", { error: msg });
      this.tagCache.clear(); // Don't leave partial data
    }
  }

  /**
   * Get tag UUIDs by their names (with caching)
   */
  private async resolveTagNames(actingUser: string, tagNames: string[]): Promise<{ uuids: string[]; unmatched: string[] }> {
    // Ensure cache is populated
    if (!this.isTagCacheValid()) {
      await this.populateTagCache(actingUser);
    }

    const uuids: string[] = [];
    const unmatched: string[] = [];
    for (const name of tagNames) {
      const uuid = this.tagCache.get(name.toLowerCase());
      if (uuid) {
        uuids.push(uuid);
      } else {
        unmatched.push(name);
      }
    }

    return { uuids, unmatched };
  }
}
