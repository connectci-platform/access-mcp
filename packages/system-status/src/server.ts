import {
  BaseAccessServer,
  handleApiError,
  projectFields,
  Tool,
  Resource,
  CallToolResult,
  resolveResourceId,
  buildPagination,
  MAX_LIMIT,
} from "@access-mcp/shared";
import {
  CallToolRequest,
  ReadResourceRequest,
  ReadResourceResult,
} from "@modelcontextprotocol/sdk/types.js";
import { createRequire } from "module";
const require = createRequire(import.meta.url);
const { version } = require("../package.json");

interface InfrastructureNewsArgs {
  resource?: string;
  time?: string;
  outage_type?: string;
  ids?: string[];
  limit?: number;
  offset?: number;
  fields?: string[];
}

interface InfrastructureNewsRouterArgs {
  resource?: string;
  time?: string;
  outage_type?: string;
  resource_ids?: string[];
  limit?: number;
  offset?: number;
  fields?: string[];
}

interface AffectedResource {
  ResourceName?: string;
  ResourceID?: string | number;
}

interface OutageItem {
  Subject?: string;
  AffectedResources?: AffectedResource[];
  OutageStart?: string;
  OutageEnd?: string;
  OutageType?: string;
  category?: string;
}

interface EnhancedOutage extends OutageItem {
  severity?: string;
  scheduled_start?: string;
  scheduled_end?: string;
  hours_until_start?: number;
  duration_hours?: number | null;
  has_scheduled_time?: boolean;
  outage_start?: string;
  outage_end?: string;
  days_ago?: number;
  outage_type?: string;
}

interface ResourceGroup {
  info_groupid?: string;
  group_descriptive_name?: string;
}

export class SystemStatusServer extends BaseAccessServer {
  constructor() {
    super("access-mcp-system-status", version, "https://operations-api.access-ci.org");
  }

  protected listingLinks(
    context: "list" | "search" | "details" = "list"
  ): Record<string, string> | undefined {
    if (context === "list" || context === "search") {
      return { see_all_url: "https://operations.access-ci.org/infrastructure_news_view" };
    }
    return undefined;
  }

  /**
   * Search for resources by name to resolve human-readable names to full IDs.
   * Used by resolveResourceId callback.
   */
  private async searchResourcesByName(query: string): Promise<Array<{ id: string; name: string }>> {
    try {
      const response = await this.httpClient.get(
        "/wh2/cider/v1/access-active-groups/type/resource-catalog.access-ci.org/"
      );
      const groups: ResourceGroup[] = response.data.results?.active_groups || [];
      const queryLower = query.toLowerCase();

      return groups
        .filter((g) => g.group_descriptive_name?.toLowerCase().includes(queryLower))
        .map((g) => ({
          id: g.info_groupid || "",
          name: g.group_descriptive_name || "",
        }));
    } catch {
      return [];
    }
  }

  protected getTools(): Tool[] {
    return [
      {
        name: "get_infrastructure_news",
        description:
          "Get ACCESS-CI infrastructure status including outages, maintenance, and incidents. With no parameters, returns current active outages. Use 'time' to get scheduled/past outages, 'resource' to filter to a specific system, or 'ids' to check status of specific resources.",
        inputSchema: {
          type: "object",
          properties: {
            time: {
              type: "string",
              enum: ["current", "scheduled", "past", "all"],
              description:
                "Time period: 'current' (active now), 'scheduled' (planned/future), 'past' (historical), 'all' (combined view)",
              default: "current",
            },
            resource: {
              type: "string",
              description:
                "Filter to a specific resource by name (e.g., 'delta', 'bridges2', 'anvil')",
            },
            outage_type: {
              type: "string",
              enum: ["Full", "Partial", "Degraded", "Reconfiguration"],
              description:
                "Filter by severity: 'Full' (complete outage), 'Partial' (some services affected), 'Degraded' (reduced performance), 'Reconfiguration' (system changes)",
            },
            ids: {
              type: "array",
              items: { type: "string" },
              description:
                "Check operational status for specific resources. Returns 'operational' or 'affected' for each. Accepts names ('Anvil') or IDs ('anvil.purdue.access-ci.org')",
            },
            limit: {
              type: "number",
              description: "Max results to return",
              default: 50,
            },
            offset: {
              type: "number",
              description:
                "Number of results to skip, for paging past the first `limit`. Applies to all time values.",
            },
            fields: {
              type: "array",
              items: { type: "string" },
              description:
                "Project the response down to only these fields. Dotted path syntax: 'total', 'items[].name', 'metadata.pagination.has_more', etc. Use to reduce payload size when you only need specific fields. Omit to receive the full response.",
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
        uri: "accessci://system-status",
        name: "ACCESS-CI System Status",
        description: "Real-time status of ACCESS-CI infrastructure, outages, and maintenance",
        mimeType: "application/json",
      },
      {
        uri: "accessci://outages/current",
        name: "Current Outages",
        description: "Currently active outages and system issues",
        mimeType: "application/json",
      },
      {
        uri: "accessci://outages/scheduled",
        name: "Scheduled Maintenance",
        description: "Upcoming scheduled maintenance and planned outages",
        mimeType: "application/json",
      },
      {
        uri: "accessci://outages/past",
        name: "Past Outages",
        description: "Historical outages and past incidents",
        mimeType: "application/json",
      },
    ];
  }

  protected async handleToolCall(request: CallToolRequest): Promise<CallToolResult> {
    const { name, arguments: args = {} } = request.params;
    const typedArgs = args as InfrastructureNewsArgs;

    try {
      switch (name) {
        case "get_infrastructure_news":
          return await this.getInfrastructureNewsRouter({
            resource: typedArgs.resource,
            time: typedArgs.time,
            outage_type: typedArgs.outage_type,
            resource_ids: typedArgs.ids,
            limit: typedArgs.limit,
            offset: typedArgs.offset,
            fields: typedArgs.fields,
          });
        default:
          return this.errorResponse(`Unknown tool: ${name}`);
      }
    } catch (error) {
      return this.errorResponse(handleApiError(error));
    }
  }

  /**
   * Router for consolidated get_infrastructure_news tool
   * Routes to appropriate handler based on parameters
   */
  private async getInfrastructureNewsRouter(
    args: InfrastructureNewsRouterArgs
  ): Promise<CallToolResult> {
    const { resource, time = "current", outage_type, resource_ids, limit, offset, fields } = args;

    // Check resource status (returns operational/affected) - only if IDs provided
    if (resource_ids && Array.isArray(resource_ids) && resource_ids.length > 0) {
      return await this.checkResourceStatus(resource_ids, fields);
    }

    // Time-based routing
    switch (time) {
      case "current":
        return await this.getCurrentOutages(resource, outage_type, limit, offset, fields);
      case "scheduled":
        return await this.getScheduledMaintenance(resource, outage_type, limit, offset, fields);
      case "past":
        return await this.getPastOutages(resource, outage_type, limit, offset, fields);
      case "all":
        return await this.getSystemAnnouncements(resource, outage_type, limit, offset, fields);
      default:
        throw new Error(
          `Invalid time parameter: ${time}. Must be one of: current, scheduled, past, all`
        );
    }
  }

  protected async handleResourceRead(request: ReadResourceRequest): Promise<ReadResourceResult> {
    const { uri } = request.params;

    switch (uri) {
      case "accessci://system-status": {
        return {
          contents: [
            {
              uri,
              mimeType: "text/plain",
              text: "ACCESS-CI System Status API - Monitor real-time status, outages, and maintenance for ACCESS-CI resources.",
            },
          ],
        };
      }
      case "accessci://outages/current": {
        const currentOutages = await this.getCurrentOutages();
        const content = currentOutages.content[0];
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
      case "accessci://outages/scheduled": {
        const scheduledMaintenance = await this.getScheduledMaintenance();
        const content = scheduledMaintenance.content[0];
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
      case "accessci://outages/past": {
        const pastOutages = await this.getPastOutages();
        const content = pastOutages.content[0];
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
   * `limit`/`offset` are optional so the no-arg resource-read callers
   * (accessci://outages/current) keep compiling and inherit the same
   * documented ceiling as the tool path.
   *
   * BEHAVIOR CHANGE: this path was previously UNBOUNDED (no slice at all).
   * Routing through buildPagination with defaultLimit: MAX_LIMIT (500)
   * introduces a hard 500-item ceiling on a no-limit call. This is a
   * deliberate trade-off, not "returns everything" — it returns up to
   * MAX_LIMIT. It's safe because the active outage set is realistically far
   * below 500, so no truncation happens in practice; if it ever did exceed
   * 500, buildPagination reports has_more:true and capped:true, making the
   * overflow loud and pageable instead of silently dropping items.
   */
  private async getCurrentOutages(
    resourceFilter?: string,
    outageTypeFilter?: string,
    limit?: number,
    offset?: number,
    fields?: string[]
  ): Promise<CallToolResult> {
    const response = await this.httpClient.get(
      "/wh2/news/v1/affiliation/access-ci.org/current_outages/"
    );

    let outages: OutageItem[] = response.data.results || [];

    // Filter by outage type if specified
    if (outageTypeFilter) {
      outages = outages.filter(
        (outage: OutageItem) => outage.OutageType?.toLowerCase() === outageTypeFilter.toLowerCase()
      );
    }

    // Filter by resource if specified
    if (resourceFilter) {
      const filter = resourceFilter.toLowerCase();
      outages = outages.filter(
        (outage: OutageItem) =>
          outage.Subject?.toLowerCase().includes(filter) ||
          outage.AffectedResources?.some(
            (resource: AffectedResource) =>
              resource.ResourceName?.toLowerCase().includes(filter) ||
              resource.ResourceID?.toString().includes(filter)
          )
      );
    }

    // Initialize tracking variables
    const affectedResources = new Set();
    const severityCounts = { high: 0, medium: 0, low: 0, unknown: 0 };

    // Enhance outages with status summary
    const enhancedOutages = outages.map((outage: OutageItem): EnhancedOutage => {
      // Track affected resources (use ResourceID as fallback if ResourceName is missing)
      outage.AffectedResources?.forEach((resource: AffectedResource) => {
        const resourceIdentifier = resource.ResourceName || resource.ResourceID;
        if (resourceIdentifier) affectedResources.add(String(resourceIdentifier));
      });

      // Categorize severity (basic heuristic)
      const subject = outage.Subject?.toLowerCase() || "";
      let severity = "unknown";
      if (subject.includes("emergency") || subject.includes("critical")) {
        severity = "high";
      } else if (subject.includes("maintenance") || subject.includes("scheduled")) {
        severity = "low";
      } else {
        severity = "medium";
      }
      severityCounts[severity as keyof typeof severityCounts]++;

      return {
        ...outage,
        severity,
      };
    });

    // total/aggregations describe the full filtered set; only items is paged.
    const totalCurrentOutages = enhancedOutages.length;
    const pagination = buildPagination({
      requestedLimit: limit,
      offset: offset ?? 0,
      total: totalCurrentOutages,
      defaultLimit: MAX_LIMIT,
    });
    const pagedOutages = enhancedOutages.slice(
      pagination.offset,
      pagination.offset + pagination.limit
    );

    const summary = {
      total: totalCurrentOutages,
      items: pagedOutages,
      metadata: {
        aggregations: {
          affected_resources: Array.from(affectedResources),
          severity_counts: severityCounts,
        },
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
          text: JSON.stringify(projectFields(summary, fields), null, 2),
        },
      ],
    };
  }

  /**
   * `limit`/`offset` are optional so the no-arg resource-read callers
   * (accessci://outages/scheduled) keep compiling and inherit the same
   * documented ceiling as the tool path.
   *
   * BEHAVIOR CHANGE: this path was previously UNBOUNDED (no slice at all).
   * Routing through buildPagination with defaultLimit: MAX_LIMIT (500)
   * introduces a hard 500-item ceiling on a no-limit call. This is a
   * deliberate trade-off, not "returns everything" — it returns up to
   * MAX_LIMIT. It's safe because the scheduled-maintenance set is
   * realistically far below 500, so no truncation happens in practice; if it
   * ever did exceed 500, buildPagination reports has_more:true and
   * capped:true, making the overflow loud and pageable instead of silently
   * dropping items.
   */
  private async getScheduledMaintenance(
    resourceFilter?: string,
    outageTypeFilter?: string,
    limit?: number,
    offset?: number,
    fields?: string[]
  ): Promise<CallToolResult> {
    const response = await this.httpClient.get(
      "/wh2/news/v1/affiliation/access-ci.org/future_outages/"
    );

    let maintenance: OutageItem[] = response.data.results || [];

    // Filter by outage type if specified
    if (outageTypeFilter) {
      maintenance = maintenance.filter(
        (item: OutageItem) => item.OutageType?.toLowerCase() === outageTypeFilter.toLowerCase()
      );
    }

    // Filter by resource if specified
    if (resourceFilter) {
      const filter = resourceFilter.toLowerCase();
      maintenance = maintenance.filter(
        (item: OutageItem) =>
          item.Subject?.toLowerCase().includes(filter) ||
          item.AffectedResources?.some(
            (resource: AffectedResource) =>
              resource.ResourceName?.toLowerCase().includes(filter) ||
              resource.ResourceID?.toString().includes(filter)
          )
      );
    }

    // Sort by scheduled start time
    maintenance.sort((a: OutageItem, b: OutageItem) => {
      const dateA = new Date(a.OutageStart || "");
      const dateB = new Date(b.OutageStart || "");
      return dateA.getTime() - dateB.getTime();
    });

    // Initialize tracking variables
    const affectedResources = new Set();
    let upcoming24h = 0;
    let upcomingWeek = 0;

    const enhancedMaintenance = maintenance.map((item: OutageItem): EnhancedOutage => {
      // Track affected resources
      item.AffectedResources?.forEach((resource: AffectedResource) => {
        const resourceIdentifier = resource.ResourceName || resource.ResourceID;
        if (resourceIdentifier) affectedResources.add(String(resourceIdentifier));
      });

      // Check timing - use OutageStart for scheduling
      const hasScheduledTime = !!item.OutageStart;
      const startTime = new Date(item.OutageStart || "");
      const now = new Date();
      const hoursUntil = (startTime.getTime() - now.getTime()) / (1000 * 60 * 60);

      if (hoursUntil <= 24) upcoming24h++;
      if (hoursUntil <= 168) upcomingWeek++; // 7 days * 24 hours

      return {
        ...item,
        scheduled_start: item.OutageStart,
        scheduled_end: item.OutageEnd,
        hours_until_start: Math.max(0, Math.round(hoursUntil)),
        duration_hours:
          item.OutageEnd && item.OutageStart
            ? Math.round(
                (new Date(item.OutageEnd).getTime() - new Date(item.OutageStart).getTime()) /
                  (1000 * 60 * 60)
              )
            : null,
        has_scheduled_time: hasScheduledTime,
      };
    });

    // total/aggregations describe the full filtered set; only items is paged.
    const totalScheduledMaintenance = enhancedMaintenance.length;
    const pagination = buildPagination({
      requestedLimit: limit,
      offset: offset ?? 0,
      total: totalScheduledMaintenance,
      defaultLimit: MAX_LIMIT,
    });
    const pagedMaintenance = enhancedMaintenance.slice(
      pagination.offset,
      pagination.offset + pagination.limit
    );

    const summary = {
      total: totalScheduledMaintenance,
      items: pagedMaintenance,
      metadata: {
        aggregations: {
          upcoming_24h: upcoming24h,
          upcoming_week: upcomingWeek,
          affected_resources: Array.from(affectedResources),
        },
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
          text: JSON.stringify(projectFields(summary, fields), null, 2),
        },
      ],
    };
  }

  private async getPastOutages(
    resourceFilter?: string,
    outageTypeFilter?: string,
    limit?: number,
    offset?: number,
    fields?: string[]
  ): Promise<CallToolResult> {
    const response = await this.httpClient.get(
      "/wh2/news/v1/affiliation/access-ci.org/past_outages/"
    );

    let pastOutages: OutageItem[] = response.data.results || [];

    // Filter by outage type if specified
    if (outageTypeFilter) {
      pastOutages = pastOutages.filter(
        (outage: OutageItem) => outage.OutageType?.toLowerCase() === outageTypeFilter.toLowerCase()
      );
    }

    // Filter by resource if specified
    if (resourceFilter) {
      const filter = resourceFilter.toLowerCase();
      pastOutages = pastOutages.filter(
        (outage: OutageItem) =>
          outage.Subject?.toLowerCase().includes(filter) ||
          outage.AffectedResources?.some(
            (resource: AffectedResource) =>
              resource.ResourceName?.toLowerCase().includes(filter) ||
              resource.ResourceID?.toString().includes(filter)
          )
      );
    }

    // Sort by outage end time (most recent first)
    pastOutages.sort((a: OutageItem, b: OutageItem) => {
      const dateA = new Date(a.OutageEnd || "");
      const dateB = new Date(b.OutageEnd || "");
      return dateB.getTime() - dateA.getTime();
    });

    // Capture pre-slice count so pagination.total reflects the true
    // filtered/sorted match count, not the returned page.
    const totalPastOutages = pastOutages.length;

    const pagination = buildPagination({
      requestedLimit: limit,
      offset: offset ?? 0,
      total: totalPastOutages,
      defaultLimit: 100,
    });

    pastOutages = pastOutages.slice(pagination.offset, pagination.offset + pagination.limit);

    // Initialize tracking variables
    const affectedResources = new Set<string>();
    const outageTypes = new Set<string>();
    const recentOutages = pastOutages.filter((outage: OutageItem) => {
      const endTime = new Date(outage.OutageEnd || "");
      const daysAgo = (Date.now() - endTime.getTime()) / (1000 * 60 * 60 * 24);
      return daysAgo <= 30; // Last 30 days
    });

    // Enhance outages with calculated fields
    const enhancedOutages = pastOutages.map((outage: OutageItem): EnhancedOutage => {
      // Track affected resources (use ResourceID as fallback if ResourceName is missing)
      outage.AffectedResources?.forEach((resource: AffectedResource) => {
        const resourceIdentifier = resource.ResourceName || resource.ResourceID;
        if (resourceIdentifier) affectedResources.add(String(resourceIdentifier));
      });

      // Track outage types
      if (outage.OutageType) {
        outageTypes.add(outage.OutageType);
      }

      // Calculate duration
      const startTime = new Date(outage.OutageStart || "");
      const endTime = new Date(outage.OutageEnd || "");
      const durationHours = Math.round(
        (endTime.getTime() - startTime.getTime()) / (1000 * 60 * 60)
      );

      // Calculate how long ago it ended
      const daysAgo = Math.round((Date.now() - endTime.getTime()) / (1000 * 60 * 60 * 24));

      return {
        ...outage,
        outage_start: outage.OutageStart,
        outage_end: outage.OutageEnd,
        duration_hours: durationHours,
        days_ago: daysAgo,
        outage_type: outage.OutageType,
      };
    });

    const averageDurationHours =
      enhancedOutages.length > 0
        ? Math.round(
            enhancedOutages
              .filter((o: EnhancedOutage) => o.duration_hours && o.duration_hours > 0)
              .reduce((sum: number, o: EnhancedOutage) => sum + (o.duration_hours || 0), 0) /
              enhancedOutages.filter(
                (o: EnhancedOutage) => o.duration_hours && o.duration_hours > 0
              ).length
          )
        : 0;

    const summary = {
      total: totalPastOutages,
      items: enhancedOutages,
      metadata: {
        aggregations: {
          recent_outages_30_days: recentOutages.length,
          affected_resources: Array.from(affectedResources),
          outage_types: Array.from(outageTypes),
          average_duration_hours: averageDurationHours,
        },
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
          text: JSON.stringify(projectFields(summary, fields), null, 2),
        },
      ],
    };
  }

  private async getSystemAnnouncements(
    resourceFilter?: string,
    outageTypeFilter?: string,
    limit?: number,
    offset?: number,
    fields?: string[]
  ): Promise<CallToolResult> {
    // Get current, future, and recent past announcements for comprehensive view
    const [currentResponse, futureResponse, pastResponse] = await Promise.all([
      this.httpClient.get("/wh2/news/v1/affiliation/access-ci.org/current_outages/"),
      this.httpClient.get("/wh2/news/v1/affiliation/access-ci.org/future_outages/"),
      this.httpClient.get("/wh2/news/v1/affiliation/access-ci.org/past_outages/"),
    ]);

    let currentOutages: OutageItem[] = currentResponse.data.results || [];
    let futureOutages: OutageItem[] = futureResponse.data.results || [];
    let pastOutagesData: OutageItem[] = pastResponse.data.results || [];

    // Filter by outage type if specified
    if (outageTypeFilter) {
      const typeFilter = outageTypeFilter.toLowerCase();
      currentOutages = currentOutages.filter((o) => o.OutageType?.toLowerCase() === typeFilter);
      futureOutages = futureOutages.filter((o) => o.OutageType?.toLowerCase() === typeFilter);
      pastOutagesData = pastOutagesData.filter((o) => o.OutageType?.toLowerCase() === typeFilter);
    }

    // Filter by resource if specified. Applied here (before recentPastOutages
    // is derived) so total/aggregations downstream describe the same
    // filtered universe as items -- filtering later (e.g. at fullSorted)
    // would leave total/aggregations counting the unfiltered arrays.
    if (resourceFilter) {
      const filter = resourceFilter.toLowerCase();
      const matchesResource = (outage: OutageItem) =>
        outage.Subject?.toLowerCase().includes(filter) ||
        outage.AffectedResources?.some(
          (resource: AffectedResource) =>
            resource.ResourceName?.toLowerCase().includes(filter) ||
            resource.ResourceID?.toString().includes(filter)
        );
      currentOutages = currentOutages.filter(matchesResource);
      futureOutages = futureOutages.filter(matchesResource);
      pastOutagesData = pastOutagesData.filter(matchesResource);
    }

    // Filter recent past outages (last 30 days) for announcements
    const recentPastOutages = pastOutagesData.filter((outage: OutageItem) => {
      const endTime = new Date(outage.OutageEnd || "");
      const daysAgo = (Date.now() - endTime.getTime()) / (1000 * 60 * 60 * 24);
      return daysAgo <= 30;
    });

    // Combine all announcements and sort by most relevant date. Keep the
    // FULL sorted list here (no slice in the chain) so `total` and the
    // `categories` aggregation both describe the same full universe; the
    // page is sliced separately below via buildPagination.
    const fullSorted: OutageItem[] = [
      ...currentOutages.map((item: OutageItem) => ({ ...item, category: "current" as const })),
      ...futureOutages.map((item: OutageItem) => ({ ...item, category: "scheduled" as const })),
      ...recentPastOutages.map((item: OutageItem) => ({
        ...item,
        category: "recent_past" as const,
      })),
    ].sort((a: OutageItem, b: OutageItem) => {
      // Sort by most relevant date: current first, then future by start time, then past by end time
      if (a.category === "current" && b.category !== "current") return -1;
      if (b.category === "current" && a.category !== "current") return 1;

      const dateA = new Date(a.OutageStart || "");
      const dateB = new Date(b.OutageStart || "");
      return dateB.getTime() - dateA.getTime(); // Most recent first
    });

    const total = fullSorted.length;

    const pagination = buildPagination({
      requestedLimit: limit,
      offset: offset ?? 0,
      total,
      defaultLimit: 50,
    });

    const page = fullSorted.slice(pagination.offset, pagination.offset + pagination.limit);

    const summary = {
      total,
      items: page,
      metadata: {
        aggregations: {
          current_outages: currentOutages.length,
          scheduled_maintenance: futureOutages.length,
          recent_past_outages: recentPastOutages.length,
          // Reads fullSorted (the full set), not the returned page, so
          // category counts describe the same universe `total` describes.
          categories: {
            current: fullSorted.filter((a) => a.category === "current").length,
            scheduled: fullSorted.filter((a) => a.category === "scheduled").length,
            recent_past: fullSorted.filter((a) => a.category === "recent_past").length,
          },
        },
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
          text: JSON.stringify(projectFields(summary, fields), null, 2),
        },
      ],
    };
  }

  private async checkResourceStatus(
    resourceIds: string[],
    fields?: string[]
  ): Promise<CallToolResult> {
    if (!resourceIds || !Array.isArray(resourceIds) || resourceIds.length === 0) {
      throw new Error(
        "resource_ids parameter is required and must be a non-empty array of resource IDs"
      );
    }

    // Resolve all resource names to IDs first
    const resolvedIds: string[] = [];
    const resolutionErrors: Array<{ input: string; error: string }> = [];

    for (const inputId of resourceIds) {
      const resolved = await resolveResourceId(inputId, (query) =>
        this.searchResourcesByName(query)
      );
      if (resolved.success) {
        resolvedIds.push(resolved.id);
      } else {
        resolutionErrors.push({ input: inputId, error: resolved.error });
      }
    }

    // If any resolutions failed, return errors
    if (resolutionErrors.length > 0) {
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                error: "Could not resolve some resource names",
                resolution_errors: resolutionErrors,
                suggestions: [
                  "Use full resource IDs (e.g., 'anvil.purdue.access-ci.org')",
                  "Or use exact resource names (e.g., 'Anvil', 'Delta')",
                ],
              },
              null,
              2
            ),
          },
        ],
      };
    }

    // Use group API for efficient per-resource queries
    const now = new Date();
    const statusPromises = resolvedIds.map(async (resourceId) => {
      try {
        const response = await this.httpClient.get(`/wh2/news/v1/info_groupid/${resourceId}/`);
        const allOutages: OutageItem[] = response.data.results || [];

        // Filter to current outages only (started and not ended)
        const currentOutages = allOutages.filter((outage: OutageItem) => {
          const start = outage.OutageStart ? new Date(outage.OutageStart) : null;
          const end = outage.OutageEnd ? new Date(outage.OutageEnd) : null;
          return start && start <= now && (!end || end > now);
        });

        let status = "operational";
        let severity: string | null = null;

        if (currentOutages.length > 0) {
          status = "affected";
          // Determine severity from OutageType
          const types = currentOutages.map((o) => o.OutageType?.toLowerCase());
          if (types.includes("full")) severity = "high";
          else if (types.includes("degraded") || types.includes("partial")) severity = "medium";
          else severity = "low";
        }

        return {
          resource_id: resourceId,
          status,
          severity,
          active_outages: currentOutages.length,
          outage_details: currentOutages.map((outage: OutageItem) => ({
            subject: outage.Subject,
            outage_type: outage.OutageType,
          })),
        };
      } catch {
        return {
          resource_id: resourceId,
          status: "unknown",
          severity: null,
          active_outages: 0,
          outage_details: [],
          error: `Failed to fetch status for ${resourceId}`,
        };
      }
    });

    const resourceStatus = await Promise.all(statusPromises);

    const envelope = {
      total: resourceStatus.length,
      items: resourceStatus,
      metadata: {
        checked_at: now.toISOString(),
        aggregations: {
          counts: {
            operational: resourceStatus.filter((r) => r.status === "operational").length,
            affected: resourceStatus.filter((r) => r.status === "affected").length,
            unknown: resourceStatus.filter((r) => r.status === "unknown").length,
          },
        },
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
