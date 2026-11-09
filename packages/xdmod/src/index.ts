#!/usr/bin/env node

import {
  BaseAccessServer,
  Resource,
  CallToolResult,
  callerSafeUpstreamError,
  logUpstreamFailure,
  type ToolWithAccess,
} from "@access-mcp/shared";
import { createRequire } from "module";
import {
  buildChartPayload,
  partialPeriodNote,
  effectiveUnit,
  ORDERED_DIMENSIONS,
  timeseriesPoints,
  type ChartDataParams,
  type ChartInfo,
  type ChartPayload,
} from "./chart-payload.js";

export { timeseriesPoints };
const require = createRequire(import.meta.url);
const { version } = require("../package.json");

// Static realm metadata discovered from the live XDMoD API at xdmod.access-ci.org.
// Statistics were discovered by requesting get_data with no statistic parameter
// (returns all available fields in metaData.fields), then querying each individually
// to get the display name. Last updated: 2026-02-22.
const REALM_STATISTICS: Record<
  string,
  { description: string; statistics: Record<string, string> }
> = {
  Accounts: {
    description: "ACCESS user account tracking — accounts associated with allocations and job activity",
    statistics: {
      unique_account_count: "Number of Accounts: Created",
      unique_account_with_jobs_count: "Number of Accounts: Created w/Jobs",
    },
  },
  Allocations: {
    description: "Allocation and project tracking — active allocations, PIs, and resource usage in SUs/ACEs",
    statistics: {
      active_allocation_count: "Number of Projects: Active",
      active_pi_count: "Number of PIs: Active",
      active_resallocation_count: "Number of Allocations: Active",
      allocated_nu: "NUs: Allocated",
      allocated_raw_su: "CPU Core Hours: Allocated",
      allocated_su: "XD SUs: Allocated",
      allocated_ace: "ACCESS Credit Equivalents: Allocated (SU)",
      rate_of_usage: "Allocation Usage Rate (XD SU/Hour)",
      rate_of_usage_ace: "Allocation Usage Rate ACEs (SU/Hour)",
      used_su: "XD SUs: Used",
      used_ace: "ACCESS Credit Equivalents: Used (SU)",
    },
  },
  Cloud: {
    description: "Cloud and virtualized compute environment metrics",
    statistics: {
      cloud_num_sessions_ended: "Number of Sessions Ended",
      cloud_num_sessions_started: "Number of Sessions Started",
      cloud_num_sessions_running: "Number of Sessions Active",
      cloud_wall_time: "Wall Hours: Total",
      cloud_core_time: "CPU Hours: Total",
      cloud_avg_wallduration_hours: "Wall Hours: Per Session",
      cloud_avg_cores_reserved: "Average Cores Reserved Weighted By Wall Hours",
      cloud_avg_memory_reserved: "Average Memory Reserved Weighted By Wall Hours (Bytes)",
      cloud_avg_rv_storage_reserved: "Average Root Volume Storage Reserved Weighted By Wall Hours (Bytes)",
      cloud_core_utilization: "Core Hour Utilization (%)",
      gateway_session_count: "Number of Sessions Ended via Gateway",
    },
  },
  Gateways: {
    description: "Science gateway job metrics — jobs submitted through ACCESS gateways",
    statistics: {
      job_count: "Number of Jobs Ended",
      running_job_count: "Number of Jobs Running",
      started_job_count: "Number of Jobs Started",
      submitted_job_count: "Number of Jobs Submitted",
      total_cpu_hours: "CPU Hours: Total",
      total_node_hours: "Node Hours: Total",
      total_wallduration_hours: "Wall Hours: Total",
      total_waitduration_hours: "Wait Hours: Total",
      avg_cpu_hours: "CPU Hours: Per Job",
      avg_node_hours: "Node Hours: Per Job",
      avg_wallduration_hours: "Wall Hours: Per Job",
      avg_waitduration_hours: "Wait Hours: Per Job",
      avg_processors: "Job Size: Per Job (Core Count)",
      max_processors: "Job Size: Max (Core Count)",
      min_processors: "Job Size: Min (Core Count)",
      normalized_avg_processors: "Job Size: Normalized (% of Total Cores)",
      avg_job_size_weighted_by_cpu_hours: "Job Size: Weighted By CPU Hours (Core Count)",
      avg_job_size_weighted_by_xd_su: "Job Size: Weighted By XD SUs (Core Count)",
      avg_job_size_weighted_by_ace: "Job Size: Weighted By ACEs (Core Count)",
      total_su: "XD SUs Charged: Total",
      avg_su: "XD SUs Charged: Per Job",
      total_nu: "NUs Charged: Total",
      avg_nu: "NUs Charged: Per Job",
      total_ace: "ACCESS Credit Equivalents Charged: Total (SU)",
      avg_ace: "ACCESS Credit Equivalents Charged: Per Job (SU)",
      rate_of_usage: "Allocation Usage Rate (XD SU/Hour)",
      rate_of_usage_ace: "Allocation Usage Rate ACEs (SU/Hour)",
      expansion_factor: "User Expansion Factor",
      utilization: "ACCESS CPU Utilization (%)",
      active_resource_count: "Number of Resources: Active",
      active_institution_count: "Number of Institutions: Active",
      active_gateway_count: "Number of Gateways: Active",
      active_gwuser_count: "Number of Gateway Users: Active",
    },
  },
  Jobs: {
    description: "Job accounting and resource usage metrics from job schedulers",
    statistics: {
      job_count: "Number of Jobs Ended",
      running_job_count: "Number of Jobs Running",
      started_job_count: "Number of Jobs Started",
      submitted_job_count: "Number of Jobs Submitted",
      total_cpu_hours: "CPU Hours: Total",
      total_node_hours: "Node Hours: Total",
      total_wallduration_hours: "Wall Hours: Total",
      total_waitduration_hours: "Wait Hours: Total",
      avg_cpu_hours: "CPU Hours: Per Job",
      avg_node_hours: "Node Hours: Per Job",
      avg_wallduration_hours: "Wall Hours: Per Job",
      avg_waitduration_hours: "Wait Hours: Per Job",
      avg_processors: "Job Size: Per Job (Core Count)",
      max_processors: "Job Size: Max (Core Count)",
      min_processors: "Job Size: Min (Core Count)",
      normalized_avg_processors: "Job Size: Normalized (% of Total Cores)",
      avg_job_size_weighted_by_cpu_hours: "Job Size: Weighted By CPU Hours (Core Count)",
      avg_job_size_weighted_by_xd_su: "Job Size: Weighted By XD SUs (Core Count)",
      avg_job_size_weighted_by_ace: "Job Size: Weighted By ACEs (Core Count)",
      total_su: "XD SUs Charged: Total",
      avg_su: "XD SUs Charged: Per Job",
      total_nu: "NUs Charged: Total",
      avg_nu: "NUs Charged: Per Job",
      total_ace: "ACCESS Credit Equivalents Charged: Total (SU)",
      avg_ace: "ACCESS Credit Equivalents Charged: Per Job (SU)",
      rate_of_usage: "Allocation Usage Rate (XD SU/Hour)",
      rate_of_usage_ace: "Allocation Usage Rate ACEs (SU/Hour)",
      expansion_factor: "User Expansion Factor",
      utilization: "ACCESS CPU Utilization (%)",
      gateway_job_count: "Number of Jobs via Gateway",
      active_person_count: "Number of Users: Active",
      active_pi_count: "Number of PIs: Active",
      active_resource_count: "Number of Resources: Active",
      active_allocation_count: "Number of Allocations: Active",
      active_institution_count: "Number of Institutions: Active",
    },
  },
  Requests: {
    description: "Allocation request/proposal tracking",
    statistics: {
      request_count: "Number of Proposals",
      project_count: "Number of Projects",
    },
  },
  ResourceSpecifications: {
    description: "Resource hardware specifications — CPU/GPU counts, node hours, and capacity metrics",
    statistics: {
      total_cpu_core_hours: "CPU Hours: Total",
      allocated_cpu_core_hours: "CPU Hours: Allocated",
      total_gpu_hours: "GPU Hours: Total",
      allocated_gpu_hours: "GPU Hours: Allocated",
      total_gpu_node_hours: "GPU Node Hours: Total",
      allocated_gpu_node_hours: "GPU Node Hours: Allocated",
      total_cpu_node_hours: "CPU Node Hours: Total",
      allocated_cpu_node_hours: "CPU Node Hours: Allocated",
      total_avg_number_of_cpu_cores: "Average Number of CPU Cores: Total",
      allocated_avg_number_of_cpu_cores: "Average Number of CPU Cores: Allocated",
      total_avg_number_of_gpus: "Average Number of GPUs: Total",
      allocated_avg_number_of_gpus: "Average Number of GPUs: Allocated",
      total_avg_number_of_cpu_nodes: "Average Number of CPU Nodes: Total",
      allocated_avg_number_of_cpu_nodes: "Average Number of CPU Nodes: Allocated",
      total_avg_number_of_gpu_nodes: "Average Number of GPU Nodes: Total",
      allocated_avg_number_of_gpu_nodes: "Average Number of GPU Nodes: Allocated",
      ace_total: "ACCESS Credit Equivalents Available: Total (SU)",
      ace_allocated: "ACCESS Credit Equivalents Available: Allocated (SU)",
    },
  },
  Storage: {
    description: "File system and storage usage metrics (requires authentication — not available for public queries)",
    statistics: {
      user_count: "User Count",
      avg_physical_usage: "Physical Usage (Bytes)",
      avg_logical_usage: "Logical Usage (Bytes)",
      avg_file_count: "File Count",
      avg_hard_threshold: "Quota: Hard Threshold (Bytes)",
      avg_soft_threshold: "Quota: Soft Threshold (Bytes)",
    },
  },
  SUPREMM: {
    description: "Detailed job performance analytics — CPU, GPU, memory, network, and I/O metrics from monitoring",
    statistics: {
      job_count: "Number of Jobs Ended",
      short_job_count: "Number of Short Jobs Ended",
      running_job_count: "Number of Jobs Running",
      started_job_count: "Number of Jobs Started",
      submitted_job_count: "Number of Jobs Submitted",
      wall_time: "CPU Hours: Total",
      wall_time_per_job: "Wall Hours: Per Job",
      wait_time: "Wait Hours: Total",
      wait_time_per_job: "Wait Hours: Per Job",
      requested_wall_time: "Wall Hours: Requested: Total",
      requested_wall_time_per_job: "Wall Hours: Requested: Per Job",
      wall_time_accuracy: "Wall Time Accuracy (%)",
      cpu_time_user: "CPU Hours: User: Total",
      cpu_time_system: "CPU Hours: System: Total",
      cpu_time_idle: "CPU Hours: Idle: Total",
      avg_percent_cpu_user: "Avg CPU %: User: weighted by core-hour",
      avg_percent_cpu_system: "Avg CPU %: System: weighted by core-hour",
      avg_percent_cpu_idle: "Avg CPU %: Idle: weighted by core-hour",
      avg_cpuusercv_per_core: "Avg: CPU User CV: weighted by core-hour",
      avg_cpuuserimb_per_core: "Avg: CPU User Imbalance: weighted by core-hour (%)",
      gpu_time: "GPU Hours: Total",
      avg_percent_gpu_usage: "Avg GPU usage: weighted by GPU hour (GPU %)",
      avg_flops_per_core: "Avg: FLOPS: Per Core weighted by core-hour (ops/s)",
      avg_cpiref_per_core: "Avg: CPI: Per Core weighted by core-hour",
      avg_cpldref_per_core: "Avg: CPLD: Per Core weighted by core-hour",
      avg_memory_per_core: "Avg: Memory: Per Core weighted by core-hour (bytes)",
      avg_total_memory_per_core: "Avg: Total Memory: Per Core weighted by core-hour (bytes)",
      avg_max_memory_per_core: "Avg: Max Memory: weighted by core-hour (%)",
      avg_mem_bw_per_core: "Avg: Memory Bandwidth: Per Core weighted by core-hour (bytes/s)",
      avg_ib_rx_bytes: "Avg: InfiniBand rate: Per Node weighted by node-hour (bytes/s)",
      avg_homogeneity: "Avg: Homogeneity: weighted by node-hour (%)",
      avg_net_eth0_rx: "Avg: eth0 receive rate: Per Node weighted by node-hour (bytes/s)",
      avg_net_eth0_tx: "Avg: eth0 transmit rate: Per Node weighted by node-hour (bytes/s)",
      avg_net_ib0_rx: "Avg: ib0 receive rate: Per Node weighted by node-hour (bytes/s)",
      avg_net_ib0_tx: "Avg: ib0 transmit rate: Per Node weighted by node-hour (bytes/s)",
      avg_netdrv_lustre_rx: "Avg: lustre receive rate: Per Node weighted by node-hour (bytes/s)",
      avg_netdrv_lustre_tx: "Avg: lustre transmit rate: Per Node weighted by node-hour (bytes/s)",
      avg_block_sda_rd_bytes: "Avg: block sda read rate: Per Node weighted by node-hour (bytes/s)",
      avg_block_sda_wr_bytes: "Avg: block sda write rate: Per Node weighted by node-hour (bytes/s)",
      avg_block_sda_rd_ios: "Avg: block sda read ops rate: Per Node weighted by node-hour (ops/s)",
      avg_block_sda_wr_ios: "Avg: block sda write ops rate: Per Node weighted by node-hour (ops/s)",
      avg_netdir_home_write: "Avg: /home write rate: Per Node weighted by node-hour (bytes/s)",
      avg_netdir_scratch_write: "Avg: /scratch write rate: Per Node weighted by node-hour (bytes/s)",
      avg_netdir_work_write: "Avg: /work write rate: Per Node weighted by node-hour (bytes/s)",
      total_su: "XD SUs Charged: Total",
      avg_su: "XD SUs Charged: Per Job",
      total_ace: "ACCESS Credit Equivalents Charged: Total (SU)",
      avg_ace: "ACCESS Credit Equivalents Charged: Per Job (SU)",
      active_pi_count: "Number of PIs: Active",
      active_app_count: "Number of Applications: Active",
    },
  },
};

interface MenuEntry {
  text?: string;
  id?: string;
  realm?: string;
  group_by?: string;
  node_type?: string;
  [key: string]: unknown;
}

type ChartResult = {
  content: { type: "text"; text: string }[];
  structuredContent?: { chart: ChartPayload };
};

// Per series, enough for ten years of quarters or five of months, so a year of
// days is summarized. The total keeps a high limit from listing every series.
const MAX_SERIES_POINTS = 60;
const MAX_LISTED_POINTS = 300;

// The portal's hash picks a statistic node only; its Usage tab reads no dates from it.
function portalChartUrl(realm: string, groupBy: string, statistic: string): string {
  const urlParams = new URLSearchParams({
    node: "statistic",
    realm,
    group_by: groupBy,
    statistic,
  });
  return `https://xdmod.access-ci.org/index.php#tg_usage?${urlParams.toString()}`;
}

export class XDMoDMetricsServer extends BaseAccessServer {
  private menuCache: { data: MenuEntry[]; timestamp: number } | null = null;
  private static readonly MENU_CACHE_TTL = 1000 * 60 * 30; // 30 minutes
  private chartCache = new Map<string, { result: ChartResult; expires: number }>();
  private static readonly CHART_CACHE_TTL = 1000 * 60 * 60; // 1 hour
  private static readonly CHART_CACHE_MAX_ENTRIES = 100;
  private dimensionOrderCache = new Map<string, { names: string[]; expires: number }>();
  private static readonly DIMENSION_ORDER_TTL = 1000 * 60 * 30; // 30 minutes
  private latestDayCache = new Map<string, { day: string; expires: number }>();
  private static readonly LATEST_DAY_TTL = 1000 * 60 * 60; // 1 hour
  // Count statistics that have a value on every day a realm has data.
  private static readonly PROBE_STATISTICS: Record<string, string> = {
    Jobs: "job_count",
    SUPREMM: "job_count",
    Gateways: "job_count",
  };

  constructor() {
    super("xdmod", version, "https://xdmod.access-ci.org");
  }

  private getHeaders(): Record<string, string> {
    return {
      "Content-Type": "application/x-www-form-urlencoded",
    };
  }

  /**
   * Fetch the XDMoD menu tree (public_user=true). Cached in memory.
   */
  private async fetchMenus(): Promise<MenuEntry[]> {
    if (this.menuCache && Date.now() - this.menuCache.timestamp < XDMoDMetricsServer.MENU_CACHE_TTL) {
      return this.menuCache.data;
    }

    const response = await fetch(`${this.baseURL}/controllers/user_interface.php`, {
      method: "POST",
      headers: this.getHeaders(),
      body: new URLSearchParams({
        operation: "get_menus",
        public_user: "true",
        node: "category_",
      }),
    });

    if (!response.ok) {
      throw new Error(`Failed to fetch XDMoD menus: HTTP ${response.status}`);
    }

    // The parser's error quotes the body, so never let it reach the caller.
    const json = await response.json().catch(() => null);
    if (json === null) {
      throw new Error("XDMoD returned an unreadable response");
    }
    const data: MenuEntry[] = json.data ?? json ?? [];
    this.menuCache = { data, timestamp: Date.now() };
    return data;
  }

  /**
   * Resolve a filter value to a numeric XDMoD dimension ID.
   * If the value is already numeric, returns it as-is.
   * Otherwise searches the dimension API for a matching entry.
   */
  private async resolveFilterId(
    realm: string,
    dimension: string,
    value: string,
    matchNotes?: string[]
  ): Promise<string> {
    // Already numeric — use as-is
    if (/^\d+$/.test(value)) return value;

    const response = await fetch(
      `${this.baseURL}/controllers/metric_explorer.php`,
      {
        method: "POST",
        headers: this.getHeaders(),
        body: new URLSearchParams({
          operation: "get_dimension",
          public_user: "true",
          realm,
          dimension_id: dimension,
          start: "0",
          limit: "200",
        }),
      }
    );

    if (!response.ok) return value; // fallback to original

    const json = await response.json().catch(() => null);
    if (json === null) return value; // unreadable body: fall back to original
    const items: { id?: string; name?: string; short_name?: string }[] =
      json.data ?? [];

    const lower = value.toLowerCase();
    // Normalize: strip hyphens/extra spaces for fuzzy matching (e.g., "Bridges-2" vs "Bridges 2 RM")
    const normalize = (s: string) => s.toLowerCase().replace(/[-_]/g, " ").replace(/\s+/g, " ").trim();
    const normalized = normalize(value);

    // 1. Exact name match
    const exact = items.find(
      (i) =>
        i.name?.toLowerCase() === lower ||
        i.short_name?.toLowerCase() === lower
    );
    if (exact?.id) return exact.id;

    // 2. All items whose name contains the search term (or vice versa)
    const matches = items.filter(
      (i) => {
        const normName = normalize(i.name ?? "");
        return (
          normName.includes(normalized) ||
          normalized.includes(normName) ||
          i.name?.toLowerCase().includes(lower) ||
          lower.includes(i.name?.toLowerCase() ?? "___")
        );
      }
    );
    // A partial name can include more than was asked for, such as DeltaAI for
    // Delta, so callers can report what it matched.
    if (matches.length > 0) {
      matchNotes?.push(
        `${dimension} "${value}" included ${matches.map((m) => m.name).join(", ")}`
      );
    }
    if (matches.length === 1) return matches[0].id ?? value;
    if (matches.length > 1) {
      // Multiple matches — return all IDs so XDMoD includes all
      return matches.map((m) => m.id).filter(Boolean).join(",");
    }

    return value; // no match found, pass through
  }

  /**
   * Resolve all filter values in a filters object to numeric IDs.
   * Supports both string values and arrays of strings (for multi-value filters).
   */
  private async resolveFilters(
    realm: string,
    filters: Record<string, unknown>,
    matchNotes?: string[]
  ): Promise<Record<string, string>> {
    const resolved: Record<string, string> = {};
    for (const [dimension, value] of Object.entries(filters)) {
      if (Array.isArray(value)) {
        // Multi-value filter: resolve each and join with commas
        const ids = await Promise.all(
          value.map((v: unknown) =>
            this.resolveFilterId(realm, dimension, String(v), matchNotes)
          )
        );
        // Overlapping names (Delta and NCSA DELTA CPU) resolve to the same ids.
        resolved[dimension] = [...new Set(ids.join(",").split(","))].join(",");
      } else {
        resolved[dimension] = await this.resolveFilterId(
          realm,
          dimension,
          String(value),
          matchNotes
        );
      }
    }
    return resolved;
  }

  // Realms available for public (unauthenticated) queries.
  // Storage requires authentication and is excluded.
  private static readonly PUBLIC_REALMS = Object.keys(REALM_STATISTICS)
    .filter((r) => r !== "Storage")
    .sort();

  protected getTools(): ToolWithAccess[] {
    const tools: ToolWithAccess[] = [
      {
        name: "get_chart_data",
        mutates: false,
        description:
          "The go-to tool for ACCESS-wide usage statistics, counts, and trends: " +
          "job counts, CPU/GPU hours, utilization, most-used resources, active users/PIs, " +
          "allocation usage — any 'how many / how much / trend over time' usage question " +
          "(e.g. 'how many jobs ran on Delta last month'). For a trend, use dataset_type timeseries; " +
          "each period's value is listed, and aggregation_unit sets the period length. Aggregate data only, not " +
          "per-user extracts. Filters accept names (auto-resolved to IDs). " +
          "Stats by realm — Jobs: job_count, total_cpu_hours, total_su, active_person_count; " +
          "Allocations: allocated_ace, used_ace, active_allocation_count; Accounts: unique_account_count; " +
          "Gateways: active_gateway_count, job_count; SUPREMM: gpu_time, short_job_count, avg_flops_per_core, wall_time_accuracy; " +
          "Cloud: cloud_num_sessions_started; ResourceSpecifications: total_avg_number_of_gpus; Requests: project_count.",
        inputSchema: {
          type: "object",
          properties: {
            realm: {
              type: "string",
              description:
                'Data realm. Jobs=job counts/CPU hours/SUs/active users; ' +
                'Allocations=ACEs/SUs allocated+used/active allocations/PIs; Accounts=user account counts; ' +
                'Gateways=gateway job counts/active gateways; SUPREMM=GPU time/CPU perf/FLOPS/short jobs/memory; ' +
                'Cloud=VM sessions/core hours; ResourceSpecifications=GPU+CPU node counts/capacity; ' +
                'Requests=proposals/projects submitted.',
              enum: XDMoDMetricsServer.PUBLIC_REALMS,
            },
            group_by: {
              type: "string",
              description:
                'Dimension to group by. Use "none" for overall totals, or a dimension like "resource", "person", "pi", "institution", "gateway", "fieldofscience". Call describe_fields to see all dimensions for a realm.',
            },
            statistic: {
              type: "string",
              description:
                'Exact statistic ID — must match the realm. Use describe_fields to discover all options. ' +
                'Jobs: job_count, total_cpu_hours, total_su, active_person_count, gateway_job_count. ' +
                'Allocations: allocated_ace, used_ace, active_allocation_count, active_pi_count. ' +
                'SUPREMM: gpu_time, short_job_count, wall_time_accuracy, avg_flops_per_core, avg_percent_gpu_usage. ' +
                'Requests: project_count, request_count. Accounts: unique_account_count.',
            },
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
            dataset_type: {
              type: "string",
              description: 'Dataset type (default: "timeseries")',
              enum: ["timeseries", "aggregate"],
              default: "timeseries",
            },
            display_type: {
              type: "string",
              description: 'Display type (default: "line")',
              enum: ["line", "bar", "pie", "scatter"],
              default: "line",
            },
            combine_type: {
              type: "string",
              description: 'How to combine data (default: "side")',
              enum: ["side", "stack", "percent"],
              default: "side",
            },
            limit: {
              type: "number",
              description: "Maximum number of data series to return (default: 10)",
              default: 10,
            },
            offset: {
              type: "number",
              description: "Offset for pagination (default: 0)",
              default: 0,
            },
            log_scale: {
              type: "string",
              description: 'Use logarithmic scale (default: "n")',
              enum: ["y", "n"],
              default: "n",
            },
            aggregation_unit: {
              type: "string",
              description:
                "Length of each timeseries period. Omit for Auto, where XDMoD uses days for ranges under 6 months, " +
                "months under 10 years, and quarters beyond that. Set Month for a monthly trend over a shorter range.",
              enum: ["Auto", "Day", "Month", "Quarter", "Year"],
            },
            filters: {
              type: "object",
              description:
                'Filter by dimension. Keys are dimension names (e.g., "resource", "pi", "fieldofscience"). ' +
                'Each value is a name, auto-resolved to its ID (e.g., {"resource": "Delta"}), or an id listed by get_dimension_values given as a string. ' +
                'A partial name can match several (Delta also matches DeltaAI). Pass a list to match any of several (e.g., {"resource": ["Delta", "Anvil"]}).',
              additionalProperties: {
                anyOf: [{ type: "string" }, { type: "array", items: { type: "string" }, minItems: 1 }],
              },
            },
          },
          required: ["realm", "group_by", "statistic", "start_date", "end_date"],
        },
      },
      {
        name: "get_chart_image",
        mutates: false,
        description:
          "Get chart image (SVG, PNG, or PDF) for a specific statistic. Use PNG format for direct display in Claude Desktop.",
        inputSchema: {
          type: "object",
          properties: {
            realm: {
              type: "string",
              description: 'The data realm. Use describe_realms to see all.',
              enum: XDMoDMetricsServer.PUBLIC_REALMS,
            },
            group_by: {
              type: "string",
              description: 'Dimension to group by. Use describe_fields for options.',
            },
            statistic: {
              type: "string",
              description: 'The statistic. Use describe_fields for available statistics per realm.',
            },
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
            format: {
              type: "string",
              description: "Image format (svg, png, pdf)",
              enum: ["svg", "png", "pdf"],
              default: "svg",
            },
            width: {
              type: "number",
              description: "Image width in pixels",
              default: 916,
            },
            height: {
              type: "number",
              description: "Image height in pixels",
              default: 484,
            },
            dataset_type: {
              type: "string",
              description: 'Dataset type (default: "timeseries")',
              enum: ["timeseries", "aggregate"],
              default: "timeseries",
            },
            display_type: {
              type: "string",
              description: 'Display type (default: "line")',
              enum: ["line", "bar", "pie", "scatter"],
              default: "line",
            },
            combine_type: {
              type: "string",
              description: 'How to combine data (default: "side")',
              enum: ["side", "stack", "percent"],
              default: "side",
            },
            limit: {
              type: "number",
              description: "Maximum number of data series to return (default: 10)",
              default: 10,
            },
            offset: {
              type: "number",
              description: "Offset for pagination (default: 0)",
              default: 0,
            },
            log_scale: {
              type: "string",
              description: 'Use logarithmic scale (default: "n")',
              enum: ["y", "n"],
              default: "n",
            },
            aggregation_unit: {
              type: "string",
              description:
                "Length of each timeseries period. Omit for Auto, where XDMoD uses days for ranges under 6 months, " +
                "months under 10 years, and quarters beyond that. Set Month for a monthly trend over a shorter range.",
              enum: ["Auto", "Day", "Month", "Quarter", "Year"],
            },
            filters: {
              type: "object",
              description:
                'Filter by dimension. Keys are dimension names (e.g., "resource", "pi", "fieldofscience"). ' +
                'Each value is a name, auto-resolved to its ID (e.g., {"resource": "Delta"}), or an id listed by get_dimension_values given as a string. ' +
                'A partial name can match several (Delta also matches DeltaAI). Pass a list to match any of several (e.g., {"resource": ["Delta", "Anvil"]}).',
              additionalProperties: {
                anyOf: [{ type: "string" }, { type: "array", items: { type: "string" }, minItems: 1 }],
              },
            },
          },
          required: ["realm", "group_by", "statistic", "start_date", "end_date"],
        },
      },
      {
        name: "get_chart_link",
        mutates: false,
        description:
          "Generate a direct URL to view an interactive chart in the XDMoD web portal. Use this when users want to explore data interactively, apply additional filters, or share charts with collaborators. The web interface provides more filtering options than the API.",
        inputSchema: {
          type: "object",
          properties: {
            realm: {
              type: "string",
              description: 'The data realm. Use describe_realms to see all.',
              enum: XDMoDMetricsServer.PUBLIC_REALMS,
            },
            group_by: {
              type: "string",
              description: 'Dimension to group by. Use describe_fields for options.',
            },
            statistic: {
              type: "string",
              description: 'The statistic. Use describe_fields for available statistics per realm.',
            },
          },
          required: ["realm", "group_by", "statistic"],
        },
      },
      {
        name: "describe_realms",
        mutates: false,
        description:
          "List all available XDMoD data realms (Jobs, SUPREMM, Cloud, Storage, etc.) with their available dimensions and statistics. Use this when you need to know what data categories exist or where to find specific metrics (e.g., GPU metrics are in the SUPREMM realm). No authentication required.",
        inputSchema: {
          type: "object",
          properties: {},
          required: [],
        },
      },
      {
        name: "describe_fields",
        mutates: false,
        description:
          "List all dimensions and statistics for a realm. Use this only when you need to discover a statistic ID not listed in get_chart_data's description. Returns group_by dimensions and statistic IDs with labels.",
        inputSchema: {
          type: "object",
          properties: {
            realm: {
              type: "string",
              description: 'XDMoD realm to describe.',
              enum: XDMoDMetricsServer.PUBLIC_REALMS,
              default: "Jobs",
            },
          },
          required: ["realm"],
        },
      },
      {
        name: "get_dimension_values",
        mutates: false,
        description:
          "Get the list of filter values for a dimension in a realm. For example, get all available resources, all institutions, or all fields of science. Use this to discover valid filter values before calling get_chart_data. No authentication required.",
        inputSchema: {
          type: "object",
          properties: {
            realm: {
              type: "string",
              description: 'XDMoD realm (e.g., "Jobs", "SUPREMM")',
            },
            dimension: {
              type: "string",
              description:
                'Dimension to get values for (e.g., "resource", "person", "institution", "fieldofscience", "jobsize", "queue")',
            },
            limit: {
              type: "number",
              description: "Maximum number of values to return (default: 200)",
              default: 200,
            },
          },
          required: ["realm", "dimension"],
        },
      },
    ];

    return tools;
  }

  protected getResources(): Resource[] {
    return [];
  }

  protected async handleToolCall(request: {
    method: "tools/call";
    params: { name: string; arguments?: Record<string, unknown> };
  }): Promise<CallToolResult> {
    const { name, arguments: args = {} } = request.params;
    // console.log(`[XDMoD] Tool called: ${name}`, args);

    switch (name) {
      case "get_chart_data":
        return await this.getChartData({
          realm: args.realm as string,
          group_by: args.group_by as string,
          statistic: args.statistic as string,
          start_date: args.start_date as string,
          end_date: args.end_date as string,
          dataset_type: (args.dataset_type as string) || "timeseries",
          display_type: (args.display_type as string) || "line",
          combine_type: (args.combine_type as string) || "side",
          limit: (args.limit as number) || 10,
          offset: (args.offset as number) || 0,
          log_scale: (args.log_scale as string) || "n",
          aggregation_unit: args.aggregation_unit as string | undefined,
          filters: args.filters as Record<string, string | string[]> | undefined,
        });

      case "get_chart_image":
        return await this.getChartImage({
          realm: args.realm as string,
          group_by: args.group_by as string,
          statistic: args.statistic as string,
          start_date: args.start_date as string,
          end_date: args.end_date as string,
          format: (args.format as string) || "svg",
          width: (args.width as number) || 916,
          height: (args.height as number) || 484,
          dataset_type: (args.dataset_type as string) || "timeseries",
          display_type: (args.display_type as string) || "line",
          combine_type: (args.combine_type as string) || "side",
          limit: (args.limit as number) || 10,
          offset: (args.offset as number) || 0,
          log_scale: (args.log_scale as string) || "n",
          aggregation_unit: args.aggregation_unit as string | undefined,
          filters: args.filters as Record<string, string | string[]> | undefined,
        });

      case "get_chart_link":
        return await this.getChartLink(
          args.realm as string,
          args.group_by as string,
          args.statistic as string
        );

      case "describe_realms":
        return await this.describeRealms();

      case "describe_fields":
        return await this.describeFields(args.realm as string);

      case "get_dimension_values":
        return await this.getDimensionValues(
          args.realm as string,
          args.dimension as string,
          (args.limit as number) || 200
        );

      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  }

  private async getChartData(params: ChartDataParams): Promise<ChartResult> {
    // Queries can take over 45 seconds. Charts are public data, so results can
    // be shared between callers, and a range that has ended no longer moves.
    const cacheKey = JSON.stringify(params);
    const cached = this.chartCache.get(cacheKey);
    if (cached && cached.expires > Date.now()) return cached.result;

    try {
      // Resolve text filter values to numeric IDs
      const matchNotes: string[] = [];
      const resolvedFilters = params.filters
        ? await this.resolveFilters(params.realm, params.filters, matchNotes)
        : undefined;

      const urlParams = new URLSearchParams({
        operation: "get_charts",
        public_user: "true",
        dataset_type: params.dataset_type,
        format: "hc_jsonstore",
        width: "916",
        height: "484",
        realm: params.realm,
        group_by: params.group_by,
        statistic: params.statistic,
        start_date: params.start_date,
        end_date: params.end_date,
      });

      if (params.display_type) urlParams.append("display_type", params.display_type);
      if (params.combine_type) urlParams.append("combine_type", params.combine_type);
      // One more than asked for tells us whether the list was cut short.
      if (params.limit !== undefined) urlParams.append("limit", (params.limit + 1).toString());
      if (params.offset !== undefined) urlParams.append("offset", params.offset.toString());
      if (params.log_scale) urlParams.append("log_scale", params.log_scale);
      // Sending the resolved unit keeps the periods XDMoD returns on the grid the payload uses.
      const unit =
        params.dataset_type === "timeseries"
          ? effectiveUnit(params.aggregation_unit, params.start_date, params.end_date)
          : undefined;
      const sentUnit = unit ?? params.aggregation_unit;
      if (sentUnit) urlParams.append("aggregation_unit", sentUnit);

      if (resolvedFilters) {
        for (const [key, value] of Object.entries(resolvedFilters)) {
          urlParams.append(`${key}_filter`, value);
        }
      }

      const response = await fetch(`${this.baseURL}/controllers/user_interface.php`, {
        method: "POST",
        headers: this.getHeaders(),
        body: urlParams,
      });

      // Any response may not be JSON, and the parser's error quotes the body.
      const data = await response.json().catch(() => null);
      if (response.ok && data === null) {
        throw new Error("XDMoD returned an unreadable response");
      }

      if (!response.ok || data?.success === false) {
        throw new Error(this.xdmodErrorText(response, data, params.realm));
      }

      let resultText = `Chart Data for ${params.statistic} (${params.realm}):\n\n`;
      if (matchNotes.length > 0) {
        resultText += `**Filters matched:** ${matchNotes.join("; ")}\n\n`;
      }

      let chartInfo: ChartInfo | undefined;
      let hasMore = false;
      let chart: ChartPayload | undefined;
      if (data.data && data.data.length > 0) {
        ({ chartInfo, hasMore } = this.trimToLimit(data.data[0] as ChartInfo, params));
        chart = await this.chartPayload(
          params,
          chartInfo,
          matchNotes,
          hasMore,
          new Date().toISOString().slice(0, 10)
        );

        if (chartInfo.group_description) {
          resultText += `**Group Description:**\n${chartInfo.group_description}\n\n`;
        }

        if (chartInfo.description) {
          resultText += `**Chart Description:**\n${chartInfo.description}\n\n`;
        }

        if (chartInfo.chart_title) {
          resultText += `**Chart Title:** ${chartInfo.chart_title}\n\n`;
        }

        // Extract a human-readable summary from the chart data so LLMs
        // don't have to parse the raw Plotly chart JSON structure.
        // Aggregate grouped data has one trace with x=categories, y=values.
        // Timeseries grouped data has one trace per category with y=values over time.
        const hcData = chartInfo.hc_jsonstore?.data;
        const chartTitle = (
          chartInfo.hc_jsonstore as
            | { layout?: { annotations?: { name?: string; text?: string }[] } }
            | undefined
        )?.layout?.annotations?.find(
          (a: { name?: string }) => a.name === "title"
        )?.text || params.statistic;

        if (hcData && hcData.length > 0) {
          const trace = hcData[0];
          if (params.dataset_type === "aggregate" && trace.x && trace.y) {
            resultText += `**${chartTitle} by ${params.group_by}:**\n`;
            for (let i = 0; i < trace.x.length; i++) {
              const label = trace.x[i];
              const value = trace.y[i];
              if (typeof value === "number") {
                resultText += `- ${label}: ${value.toFixed(4)}\n`;
              } else {
                resultText += `- ${label}: ${value}\n`;
              }
            }
            resultText += "\n";
          } else if (params.dataset_type === "timeseries") {
            const unitText = unit ? `, by ${unit.toLowerCase()}` : "";
            resultText += `**${chartTitle} by ${params.group_by} (${params.start_date} to ${params.end_date}${unitText}):**\n`;
            let listed = 0;
            let summarized = false;
            for (const series of hcData) {
              if (series.name && !series.name.toLowerCase().includes("gap connector")) {
                const points = timeseriesPoints(series);
                if (points.length === 0) continue;
                resultText += `- ${series.name} (${points.length} data points)\n`;
                if (points.length <= MAX_SERIES_POINTS && listed + points.length <= MAX_LISTED_POINTS) {
                  for (const p of points) resultText += `  - ${p.start}: ${p.value.toFixed(4)}\n`;
                  listed += points.length;
                } else {
                  summarized = true;
                }
              }
            }
            if (listed > 0) {
              resultText +=
                "Each date is the start of a whole period. XDMoD counts the whole first and last period, " +
                "even when start_date or end_date falls partway through it.\n";
            }
            const partial = chart && partialPeriodNote(chart);
            if (partial) resultText += `${partial}\n`;
            if (summarized) {
              resultText +=
                `Only series of up to ${MAX_SERIES_POINTS} points, ${MAX_LISTED_POINTS} in all, are listed. ` +
                "For the rest, set aggregation_unit to Month (Quarter or Year for long ranges), or lower limit.\n";
            }
            resultText += "\n";
          }
        }

        resultText += `*Use get_chart_image or get_chart_link for visual charts.*`;
      } else {
        resultText += "No data available for the specified parameters.";
      }

      const result: ChartResult = {
        content: [
          {
            type: "text" as const,
            text: resultText,
          },
        ],
      };
      const today = new Date().toISOString().slice(0, 10);
      if (chart) result.structuredContent = { chart };
      if (data.data?.length > 0 && params.end_date < today) {
        this.cacheChart(cacheKey, result);
      }
      return result;
    } catch (error) {
      throw new Error(
        `Failed to fetch chart data: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /**
   * XDMoD was asked for one series more than the limit. Drops the extra one
   * and says whether there was one.
   */
  private trimToLimit(
    chartInfo: ChartInfo,
    params: ChartDataParams
  ): { chartInfo: ChartInfo; hasMore: boolean } {
    const limit = params.limit;
    const store = chartInfo.hc_jsonstore;
    const traces = store?.data;
    if (limit === undefined || !store || !traces) return { chartInfo, hasMore: false };

    if (params.dataset_type === "timeseries") {
      const real = traces.filter(
        (t) => t.name && !t.name.toLowerCase().includes("gap connector")
      );
      if (real.length <= limit) return { chartInfo, hasMore: false };
      const kept = real.slice(0, limit);
      return { chartInfo: { ...chartInfo, hc_jsonstore: { ...store, data: kept } }, hasMore: true };
    }

    const trace = traces[0];
    if (!trace?.x || trace.x.length <= limit) return { chartInfo, hasMore: false };
    const cut = { ...trace, x: trace.x.slice(0, limit), y: (trace.y ?? []).slice(0, limit) };
    return {
      chartInfo: { ...chartInfo, hc_jsonstore: { ...store, data: [cut, ...traces.slice(1)] } },
      hasMore: true,
    };
  }

  /** The structured chart, or undefined (with a warning) when XDMoD's data doesn't fit it. */
  private async chartPayload(
    params: ChartDataParams,
    chartInfo: ChartInfo,
    matchNotes: string[],
    hasMore: boolean,
    today: string
  ): Promise<ChartPayload | undefined> {
    try {
      const dimensionOrder = ORDERED_DIMENSIONS.has(params.group_by)
        ? await this.dimensionOrder(params.realm, params.group_by)
        : undefined;
      const latestDataDay =
        params.dataset_type === "timeseries" ? await this.latestDataDay(params.realm) : null;
      return buildChartPayload({
        latestDataDay,
        params,
        chartInfo,
        matchNotes,
        label: REALM_STATISTICS[params.realm]?.statistics[params.statistic] ?? params.statistic,
        today,
        hasMore,
        dimensionOrder,
        link: portalChartUrl(params.realm, params.group_by, params.statistic),
      });
    } catch (error) {
      this.logger.warn("Could not build chart payload", {
        realm: params.realm,
        statistic: params.statistic,
        error: error instanceof Error ? error.message : String(error),
      });
      return undefined;
    }
  }

  /**
   * The last day in the past 120 with data in a realm, since public data can
   * stop weeks before today. Null when unknown; a failure is not cached.
   */
  private async latestDataDay(realm: string): Promise<string | null> {
    const statistic = XDMoDMetricsServer.PROBE_STATISTICS[realm];
    if (!statistic) return null;
    const cached = this.latestDayCache.get(realm);
    if (cached && cached.expires > Date.now()) return cached.day;
    try {
      const end = new Date().toISOString().slice(0, 10);
      const start = new Date(Date.parse(end) - 119 * 86_400_000).toISOString().slice(0, 10);
      const response = await fetch(`${this.baseURL}/controllers/user_interface.php`, {
        method: "POST",
        headers: this.getHeaders(),
        body: new URLSearchParams({
          operation: "get_charts",
          public_user: "true",
          dataset_type: "timeseries",
          format: "hc_jsonstore",
          width: "916",
          height: "484",
          realm,
          group_by: "none",
          statistic,
          start_date: start,
          end_date: end,
          aggregation_unit: "Day",
        }),
      });
      if (!response.ok) return null;
      const json = await response.json().catch(() => null);
      const traces: { name?: string; x?: unknown[]; y?: unknown[] }[] | undefined =
        json?.data?.[0]?.hc_jsonstore?.data;
      let day: string | null = null;
      for (const trace of traces ?? []) {
        if (!trace.name || trace.name.toLowerCase().includes("gap connector")) continue;
        for (const p of timeseriesPoints(trace)) {
          if (p.value !== 0 && (day === null || p.start > day)) day = p.start;
        }
      }
      if (day) {
        this.latestDayCache.set(realm, {
          day,
          expires: Date.now() + XDMoDMetricsServer.LATEST_DAY_TTL,
        });
      }
      return day;
    } catch {
      return null;
    }
  }

  /** XDMoD's own order of a dimension's values, cached. Undefined when the lookup fails. */
  private async dimensionOrder(realm: string, dimension: string): Promise<string[] | undefined> {
    const key = `${realm}/${dimension}`;
    const cached = this.dimensionOrderCache.get(key);
    if (cached && cached.expires > Date.now()) return cached.names;
    try {
      const response = await fetch(`${this.baseURL}/controllers/metric_explorer.php`, {
        method: "POST",
        headers: this.getHeaders(),
        body: new URLSearchParams({
          operation: "get_dimension",
          public_user: "true",
          realm,
          dimension_id: dimension,
          start: "0",
          limit: "200",
        }),
      });
      if (!response.ok) return undefined;
      const json = await response.json().catch(() => null);
      const items: { id?: string; name?: string; short_name?: string }[] = json?.data ?? [];
      const names = items.map((i) => i.name || i.short_name || i.id || "").filter(Boolean);
      if (names.length === 0) return undefined;
      this.dimensionOrderCache.set(key, {
        names,
        expires: Date.now() + XDMoDMetricsServer.DIMENSION_ORDER_TTL,
      });
      return names;
    } catch {
      return undefined;
    }
  }

  /**
   * XDMoD's exception handler answers HTTP 500 {success:false, message} with
   * the exception's text, which can include SQL, so only a 4xx message is shown.
   * A 200 success:false carries no caller-safe text either; the one case
   * callers act on, an unknown statistic, is matched explicitly.
   */
  private xdmodErrorText(response: Response, data: unknown, realm: string): string {
    const safe = callerSafeUpstreamError(response.status, data);
    const upstream = (data as { message?: unknown } | null)?.message;
    if (!safe) {
      // Metadata only: XDMoD's own text can carry SQL.
      logUpstreamFailure(this.logger, {
        upstream: "xdmod",
        method: "POST",
        path: response.url,
        status: response.status,
      });
    }
    let msg: string;
    if (safe) {
      msg = safe.message;
    } else if (typeof upstream === "string" && upstream.includes("No Statistic found")) {
      msg = "No Statistic found";
    } else if (!response.ok) {
      msg = `HTTP ${response.status}`;
    } else {
      msg = "XDMoD could not run this query";
    }
    const ref = REALM_STATISTICS[realm];
    const hint =
      msg.includes("No Statistic found") && ref
        ? `\n\nValid statistics for ${realm}: ${Object.keys(ref.statistics).join(", ")}`
        : "";
    return `XDMoD error: ${msg}${hint}`;
  }

  private cacheChart(key: string, result: ChartResult) {
    if (this.chartCache.size >= XDMoDMetricsServer.CHART_CACHE_MAX_ENTRIES) {
      const oldest = this.chartCache.keys().next().value;
      if (oldest !== undefined) this.chartCache.delete(oldest);
    }
    this.chartCache.set(key, {
      result,
      expires: Date.now() + XDMoDMetricsServer.CHART_CACHE_TTL,
    });
  }

  private async getChartImage(params: {
    realm: string;
    group_by: string;
    statistic: string;
    start_date: string;
    end_date: string;
    format: string;
    width: number;
    height: number;
    dataset_type: string;
    display_type?: string;
    combine_type?: string;
    limit?: number;
    offset?: number;
    log_scale?: string;
    aggregation_unit?: string;
    filters?: Record<string, string | string[]>;
  }) {
    try {
      // Resolve text filter values to numeric IDs
      const resolvedFilters = params.filters
        ? await this.resolveFilters(params.realm, params.filters)
        : undefined;

      const urlParams = new URLSearchParams({
        operation: "get_charts",
        public_user: "true",
        dataset_type: params.dataset_type,
        format: params.format,
        width: params.width.toString(),
        height: params.height.toString(),
        realm: params.realm,
        group_by: params.group_by,
        statistic: params.statistic,
        start_date: params.start_date,
        end_date: params.end_date,
      });

      if (params.display_type) urlParams.append("display_type", params.display_type);
      if (params.combine_type) urlParams.append("combine_type", params.combine_type);
      if (params.limit !== undefined) urlParams.append("limit", params.limit.toString());
      if (params.offset !== undefined) urlParams.append("offset", params.offset.toString());
      if (params.log_scale) urlParams.append("log_scale", params.log_scale);
      if (params.aggregation_unit) urlParams.append("aggregation_unit", params.aggregation_unit);

      if (resolvedFilters) {
        for (const [key, value] of Object.entries(resolvedFilters)) {
          urlParams.append(`${key}_filter`, value);
        }
      }

      const response = await fetch(`${this.baseURL}/controllers/user_interface.php`, {
        method: "POST",
        headers: this.getHeaders(),
        body: urlParams,
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => null);
        throw new Error(this.xdmodErrorText(response, errorData, params.realm));
      }

      if (params.format === "png") {
        // For PNG, get binary data and convert to base64
        const imageBuffer = await response.arrayBuffer();
        const base64Data = Buffer.from(imageBuffer).toString("base64");

        // Return with MCP-compliant image format that was working
        return {
          content: [
            {
              type: "image" as const,
              data: base64Data,
              mimeType: "image/png",
            },
            {
              type: "text" as const,
              text:
                `\nChart Details:\n` +
                `- Statistic: ${params.statistic}\n` +
                `- Realm: ${params.realm}\n` +
                `- Group By: ${params.group_by}\n` +
                `- Date Range: ${params.start_date} to ${params.end_date}\n` +
                `- Size: ${params.width}x${params.height} pixels`,
            },
          ],
        };
      } else {
        // For SVG and other text formats
        const imageData = await response.text();

        if (params.format === "svg") {
          // For SVG, provide helpful message about using PNG instead
          return {
            content: [
              {
                type: "text" as const,
                text:
                  `SVG Chart for ${params.statistic} (${params.realm})\n\n` +
                  `⚠️ SVG format doesn't display directly in Claude Desktop.\n\n` +
                  `**Recommended:** Use PNG format for direct image display:\n` +
                  `\`\`\`\n` +
                  `format: "png"\n` +
                  `\`\`\`\n\n` +
                  `**Chart Details:**\n` +
                  `- Statistic: ${params.statistic}\n` +
                  `- Realm: ${params.realm}\n` +
                  `- Group By: ${params.group_by}\n` +
                  `- Date Range: ${params.start_date} to ${params.end_date}\n` +
                  `- Size: ${params.width}x${params.height} pixels\n\n` +
                  `**To view this SVG chart:**\n` +
                  `1. Copy the SVG code below\n` +
                  `2. Save it to a .svg file and open in your browser\n\n` +
                  `\`\`\`svg\n${imageData}\n\`\`\``,
              },
            ],
          };
        } else {
          // For PDF and other formats, return as text
          return {
            content: [
              {
                type: "text" as const,
                text:
                  `Chart Image (${params.format.toUpperCase()}) for ${params.statistic}:\n\n` +
                  `**Parameters:** Realm: ${params.realm}, Group By: ${params.group_by}, ` +
                  `Date Range: ${params.start_date} to ${params.end_date}\n\n` +
                  `**To view this chart:**\n` +
                  `1. Copy the ${params.format.toUpperCase()} data below\n` +
                  `2. Save it to a file with .${params.format} extension\n` +
                  `3. Open the file in your browser or image viewer\n\n` +
                  `**${params.format.toUpperCase()} Data:**\n\`\`\`${params.format}\n${imageData}\n\`\`\``,
              },
            ],
          };
        }
      }
    } catch (error) {
      throw new Error(
        `Failed to fetch chart image: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  private async getChartLink(realm: string, groupBy: string, statistic: string) {
    const chartUrl = portalChartUrl(realm, groupBy, statistic);

    const responseText =
      `Direct link to view chart in XDMoD portal:\n\n${chartUrl}\n\n` +
      `**Chart Parameters:**\n` +
      `- Realm: ${realm}\n` +
      `- Group By: ${groupBy}\n` +
      `- Statistic: ${statistic}\n\n` +
      `You can use this URL to view the interactive chart directly in the XDMoD web interface. ` +
      `Use the portal's filtering options to narrow down to specific resources, users, or other criteria.`;

    return {
      content: [
        {
          type: "text" as const,
          text: responseText,
        },
      ],
    };
  }

  // --- Discovery tools (public, no auth required) ---

  private async describeRealms(): Promise<CallToolResult> {
    try {
      const menus = await this.fetchMenus();

      // Extract unique realm names from menu entries
      const liveRealms = new Set<string>();
      for (const entry of menus) {
        if (entry.realm) {
          liveRealms.add(entry.realm);
        }
      }

      let text = "**Available XDMoD Realms**\n\n";

      // Merge live data with static reference
      const allRealms = new Set([...liveRealms, ...Object.keys(REALM_STATISTICS)]);
      for (const realm of [...allRealms].sort()) {
        const ref = REALM_STATISTICS[realm];
        const isLive = liveRealms.has(realm);

        text += `### ${realm}`;
        if (!isLive) text += " (reference only)";
        text += "\n";

        if (ref) {
          text += `${ref.description}\n`;
          // Count dimensions from live API menu entries
          const dims = menus.filter((e) => e.realm === realm);
          if (dims.length > 0) {
            text += `- **Dimensions:** ${dims.length} available\n`;
          }
          text += `- **Statistics:** ${Object.keys(ref.statistics).length} available\n`;
        } else {
          // Count dimensions from menu entries
          const dims = menus.filter((e) => e.realm === realm);
          text += `- **Dimensions from API:** ${dims.length} entries\n`;
        }
        text += "\n";
      }

      text += "Use `describe_fields` with a specific realm for full details.\n";

      return { content: [{ type: "text" as const, text }] };
    } catch (error) {
      throw new Error(
        `Failed to describe realms: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  private async describeFields(realm: string): Promise<CallToolResult> {
    try {
      const menus = await this.fetchMenus();

      // Filter menu entries for this realm to get dimensions
      const realmEntries = menus.filter((e) => e.realm === realm);
      const ref = REALM_STATISTICS[realm];

      if (realmEntries.length === 0 && !ref) {
        const allRealms = new Set(menus.map((e) => e.realm).filter(Boolean));
        return {
          content: [
            {
              type: "text" as const,
              text: `Realm "${realm}" not found. Available realms: ${[...allRealms].sort().join(", ")}`,
            },
          ],
        };
      }

      let text = `**Fields for Realm: ${realm}**\n\n`;

      // Dimensions from live API
      text += "**Dimensions (group_by values):**\n";
      if (realmEntries.length > 0) {
        const seen = new Set<string>();
        for (const entry of realmEntries) {
          const groupBy = entry.group_by || entry.id || "";
          if (groupBy && !seen.has(groupBy)) {
            seen.add(groupBy);
            text += `- \`${groupBy}\``;
            if (entry.text) text += ` — ${entry.text}`;
            text += "\n";
          }
        }
      } else {
        text += "No dimension data available from API.\n";
      }

      // Statistics from static reference
      text += "\n**Statistics:**\n";
      if (ref) {
        for (const [id, label] of Object.entries(ref.statistics)) {
          text += `- \`${id}\` — ${label}\n`;
        }
      } else {
        text += "No static statistics reference available for this realm.\n";
        text += "Try using `get_chart_data` with common statistics like `total_cpu_hours` or `job_count`.\n";
      }

      text += `\nUse \`get_dimension_values\` to see available filter values for any dimension.\n`;

      return { content: [{ type: "text" as const, text }] };
    } catch (error) {
      throw new Error(
        `Failed to describe fields: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  private async getDimensionValues(
    realm: string,
    dimension: string,
    limit: number
  ): Promise<CallToolResult> {
    try {
      const response = await fetch(`${this.baseURL}/controllers/metric_explorer.php`, {
        method: "POST",
        headers: this.getHeaders(),
        body: new URLSearchParams({
          operation: "get_dimension",
          public_user: "true",
          realm: realm,
          dimension_id: dimension,
          start: "0",
          limit: limit.toString(),
        }),
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const json = await response.json().catch(() => null);
      if (json === null) {
        throw new Error("XDMoD returned an unreadable response");
      }
      const totalCount = json.totalCount ?? 0;
      const data: { id?: string; name?: string; short_name?: string }[] = json.data ?? [];

      let text = `**${dimension} values in ${realm}** (${totalCount} total)\n\n`;

      if (data.length === 0) {
        text += "No values found. Check that the realm and dimension are valid.\n";
      } else {
        for (const item of data) {
          const name = item.name || item.short_name || item.id || "unknown";
          text += `- ${name}`;
          if (item.id && item.id !== name) text += ` (id: ${item.id})`;
          text += "\n";
        }
        if (totalCount > data.length) {
          text += `\n... and ${totalCount - data.length} more. Increase \`limit\` to see more.\n`;
        }
      }

      return { content: [{ type: "text" as const, text }] };
    } catch (error) {
      throw new Error(
        `Failed to get dimension values: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
}

// Start the server
async function main() {
  const server = new XDMoDMetricsServer();
  const port = process.env.PORT ? parseInt(process.env.PORT, 10) : undefined;
  await server.start(port ? { httpPort: port } : undefined);
}

main().catch(() => {
  // Log errors to a file instead of stderr to avoid interfering with JSON-RPC
  process.exit(1);
});
