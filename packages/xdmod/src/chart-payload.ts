export type Unit = "Day" | "Month" | "Quarter" | "Year";
export type MeasureKind = "total" | "average";

export interface ChartDataParams {
  realm: string;
  group_by: string;
  statistic: string;
  start_date: string;
  end_date: string;
  dataset_type: string;
  display_type?: string;
  combine_type?: string;
  limit?: number;
  offset?: number;
  log_scale?: string;
  aggregation_unit?: string;
  filters?: Record<string, string | string[]>;
}

export interface ChartInfo {
  description?: string;
  chart_title?: string;
  group_description?: string;
  hc_jsonstore?: { data?: { name?: string; x?: unknown[]; y?: unknown[] }[] };
  [key: string]: unknown;
}

export interface ChartPayload {
  version: 1;
  realm: string;
  statistic: string;
  group_by: string;
  dataset_type: string;
  unit?: Unit;
  requested: { start: string; end: string };
  counted: { start: string; end: string };
  last_period_incomplete: boolean;
  measure: { label: string; description: string; kind: MeasureKind; missing: "zero" | "gap" };
  dimension: { name: string; ordered: boolean };
  /** What the chart was filtered to, one note per filter value; empty when unfiltered. */
  filters: { notes: string[] };
  /**
   * A series' data_through is set only when its data stops before the chart's:
   * the start of its last period with a value ("period"), or its last day ("day").
   */
  series?: {
    name: string;
    points: { start: string; value: number | null }[];
    data_through?: string;
    data_through_precision?: "day" | "period";
  }[];
  /** A category's data_through is its last day with data, set only when before the chart's end. */
  categories?: { name: string; value: number | null; data_through?: string }[];
  /** How many top-ranked series or categories XDMoD skipped before these; 0 when none. */
  offset: number;
  /**
   * Where XDMoD's data stops, or null. A timeseries gives the start of the last
   * period with any value, sharpened to a day by the realm's latest data day
   * when that day falls inside the period. An aggregate gives the realm's
   * latest data day when it is before the requested end.
   */
  data_through: string | null;
  /** "day" when data_through is a real last day; "period" when it is a period start. */
  data_through_precision: "day" | "period" | null;
  /** How many series or categories XDMoD left out past the limit, when it says; 0 when none. */
  others_count: number | null;
  /** The last period with data may hold only part of its data, because later periods are empty. */
  last_data_period_partial: boolean;
  has_more: boolean;
  ranked_by: "value";
  /** Null when the public portal can't open this chart, as with filters. */
  link: string | null;
  source: "XDMoD";
  retrieved: string;
}

export const ORDERED_DIMENSIONS: ReadonlySet<string> = new Set([
  "jobsize",
  "jobwalltime",
  "jobwaittime",
  "nodecount",
  "gpu_count",
]);

/**
 * Measures XDMoD sums whose ids don't say so, checked against each one's
 * XDMoD definition ("The total ..."). An empty period of these is 0.
 */
const TOTAL_MEASURES: ReadonlySet<string> = new Set([
  // Allocations
  "used_su",
  "used_ace",
  "allocated_nu",
  "allocated_raw_su",
  "allocated_su",
  "allocated_ace",
  // Cloud
  "cloud_num_sessions_ended",
  "cloud_num_sessions_started",
  "cloud_num_sessions_running",
  "cloud_wall_time",
  "cloud_core_time",
  // SUPREMM
  "wall_time",
  "wait_time",
  "gpu_time",
  "requested_wall_time",
  "cpu_time_user",
  "cpu_time_system",
  "cpu_time_idle",
  // ResourceSpecifications
  "allocated_cpu_core_hours",
  "allocated_gpu_hours",
  "allocated_cpu_node_hours",
  "allocated_gpu_node_hours",
  "ace_total",
  "ace_allocated",
]);

/**
 * Measures named total_ that XDMoD defines as a per-day average ("The average
 * number of CPU cores available per day"), so an empty period is unknown.
 */
const AVERAGE_MEASURES: ReadonlySet<string> = new Set([
  "total_avg_number_of_cpu_cores",
  "total_avg_number_of_gpus",
  "total_avg_number_of_cpu_nodes",
  "total_avg_number_of_gpu_nodes",
  "allocated_avg_number_of_cpu_cores",
  "allocated_avg_number_of_gpus",
  "allocated_avg_number_of_cpu_nodes",
  "allocated_avg_number_of_gpu_nodes",
]);

export function measureKind(statistic: string): MeasureKind {
  if (AVERAGE_MEASURES.has(statistic)) return "average";
  if (TOTAL_MEASURES.has(statistic)) return "total";
  if (statistic.startsWith("total_") || statistic.endsWith("_count")) return "total";
  return "average";
}

/**
 * Pairs a timeseries trace's period starts with its values, dropping gaps.
 * XDMoD sends each start as epoch milliseconds at local midnight on the
 * US East Coast, so the UTC date is the period's calendar date.
 */
export function timeseriesPoints(series: {
  x?: unknown[];
  y?: unknown[];
}): { start: string; value: number }[] {
  const xs = series.x ?? [];
  const ys = series.y ?? [];
  const points: { start: string; value: number }[] = [];
  for (let i = 0; i < ys.length; i++) {
    const value = ys[i];
    if (typeof value !== "number") continue;
    points.push({ start: xToDate(xs[i], i), value });
  }
  return points;
}

function xToDate(x: unknown, i: number): string {
  return typeof x === "number"
    ? new Date(x).toISOString().slice(0, 10)
    : String(x ?? `period ${i + 1}`);
}

function parseDate(s: string): { y: number; m: number; d: number } {
  const [y, m, d] = s.slice(0, 10).split("-").map(Number);
  return { y, m, d };
}

function fmt(y: number, m: number, d: number): string {
  return `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

function addDay(s: string): string {
  const { y, m, d } = parseDate(s);
  return new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);
}

function periodStartOf(unit: Unit, s: string): string {
  const { y, m } = parseDate(s);
  if (unit === "Day") return s.slice(0, 10);
  if (unit === "Month") return fmt(y, m, 1);
  if (unit === "Quarter") return fmt(y, Math.floor((m - 1) / 3) * 3 + 1, 1);
  return fmt(y, 1, 1);
}

function nextPeriodStart(unit: Unit, start: string): string {
  const { y, m } = parseDate(start);
  if (unit === "Day") return addDay(start);
  const step = unit === "Month" ? 1 : unit === "Quarter" ? 3 : 12;
  const total = y * 12 + (m - 1) + step;
  return fmt(Math.floor(total / 12), (total % 12) + 1, 1);
}

function periodEnd(unit: Unit, start: string): string {
  if (unit === "Day") return start;
  const next = nextPeriodStart(unit, start);
  const { y, m, d } = parseDate(next);
  return new Date(Date.UTC(y, m - 1, d - 1)).toISOString().slice(0, 10);
}

export function periodStarts(unit: Unit, start: string, end: string): string[] {
  const out: string[] = [];
  let cur = periodStartOf(unit, start);
  const last = end.slice(0, 10);
  while (cur <= last) {
    out.push(cur);
    cur = nextPeriodStart(unit, cur);
  }
  return out;
}

export function effectiveUnit(requested: string | undefined, start: string, end: string): Unit {
  if (
    requested === "Day" ||
    requested === "Month" ||
    requested === "Quarter" ||
    requested === "Year"
  ) {
    return requested;
  }
  const s = parseDate(start);
  const e = parseDate(end);
  const months = (e.y - s.y) * 12 + (e.m - s.m) + (e.d >= s.d ? 0 : -1);
  if (months < 6) return "Day";
  if (months < 120) return "Month";
  return "Quarter";
}

/** XDMoD's description is HTML; the panel wants plain text. */
export function plainDescription(html: string): string {
  return html
    .replace(/(?<![.!?:;,])\s*<br\s*\/?>\s*/gi, ". ")
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<[^>]*>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

/** XDMoD starts a description with the measure's label and a colon. */
function stripLabel(text: string, label: string): string {
  const prefix = `${label}:`;
  return label && text.toLowerCase().startsWith(prefix.toLowerCase())
    ? text.slice(prefix.length).trim()
    : text;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** A period's name as people say it: Oct 1, 2026 / Oct 2026 / Q4 2026 / 2026. */
export function periodLabel(unit: Unit, start: string): string {
  const { y, m, d } = parseDate(start);
  if (unit === "Day") return `${MONTHS[m - 1]} ${d}, ${y}`;
  if (unit === "Month") return `${MONTHS[m - 1]} ${y}`;
  if (unit === "Quarter") return `Q${Math.floor((m - 1) / 3) + 1} ${y}`;
  return String(y);
}

/** The line that keeps a reader from taking a half-empty last period for a drop. */
export function partialPeriodNote(payload: ChartPayload): string | undefined {
  if (!payload.last_data_period_partial || !payload.data_through || !payload.unit) return undefined;
  const own = periodStartOf(payload.unit, payload.data_through);
  const later = payload.counted.end > periodEnd(payload.unit, own);
  const period = periodLabel(payload.unit, payload.data_through);
  // A period start isn't the day data stops: the period may be full.
  if (payload.data_through_precision !== "day") {
    return later
      ? `XDMoD has no data after ${period}, so the ${period} value may cover only part of that period. ` +
          "Don't read it as a change."
      : undefined;
  }
  return (
    `XDMoD has data only through ${periodLabel("Day", payload.data_through)}, so the ` +
    `${period} value may cover only part of that period` +
    `${later ? ", and later periods have no data yet" : ""}. Don't read it as a change.`
  );
}

/** The line that keeps a reader from taking an aggregate cut short for the whole range. */
export function aggregateDataNote(payload: ChartPayload): string | undefined {
  if (payload.dataset_type !== "aggregate" || !payload.data_through) return undefined;
  return (
    `XDMoD has data only through ${periodLabel("Day", payload.data_through)}, but the range asked for ` +
    `runs to ${periodLabel("Day", payload.requested.end)}, so these values leave out the rest of the range.`
  );
}

/** The line that says which series or bars stop before the rest of the chart. */
export function earlyEndNote(payload: ChartPayload): string | undefined {
  const day = (d: string) => periodLabel("Day", d);
  if (payload.dataset_type === "timeseries") {
    const early = (payload.series ?? []).filter((s) => s.data_through);
    if (early.length === 0 || !payload.unit) return undefined;
    const parts = early.map((s) =>
      s.data_through_precision === "day"
        ? `${s.name} has data only through ${day(s.data_through!)}`
        : `${s.name} has no data after ${periodLabel(payload.unit!, s.data_through!)}`
    );
    return (
      `Some series stop before the rest of the chart: ${parts.join("; ")}. ` +
      "Their later periods are missing from XDMoD, not zero."
    );
  }
  const early = (payload.categories ?? []).filter((c) => c.data_through);
  if (early.length === 0) return undefined;
  const parts = early.map((c) => `${c.name} has data only through ${day(c.data_through!)}`);
  return (
    `Some data stops before the range does: ${parts.join("; ")}. ` +
    "Those values leave out the rest of the range."
  );
}

/** The line that keeps a page of results past the top from reading as the top. */
export function offsetNote(payload: ChartPayload, shown: number): string | undefined {
  if (payload.offset <= 0 || shown === 0) return undefined;
  const first = payload.offset + 1;
  const last = payload.offset + shown;
  return (
    `These are ranks ${first} to ${last} by value: XDMoD's top ${payload.offset} ` +
    `${payload.offset === 1 ? "is" : "are"} left out (offset ${payload.offset}).`
  );
}

/** XDMoD numbers ranked names ("1. NCSA DELTA GPU"). */
function stripRank(name: string): string {
  return name.replace(/^\d+\.\s+/, "");
}

export function buildChartPayload(input: {
  params: ChartDataParams;
  chartInfo: ChartInfo;
  matchNotes: string[];
  label: string;
  today: string;
  hasMore: boolean;
  /** Series or categories left out past the limit; null when XDMoD didn't say. */
  othersCount?: number | null;
  dimensionOrder?: string[];
  /** dimensionOrder lists every value XDMoD has for the dimension. */
  dimensionComplete?: boolean;
  /** The latest day XDMoD holds data for in this realm, when known. */
  latestDataDay?: string | null;
  /** The latest day each resource has data for, by name, when known. */
  resourceDays?: Record<string, string> | null;
  /** Null when the public portal can't open this chart, as with filters. */
  link: string | null;
}): ChartPayload {
  const { params, chartInfo, matchNotes, label, today, hasMore, dimensionOrder, link } = input;
  const kind = measureKind(params.statistic);
  const traces = chartInfo.hc_jsonstore?.data ?? [];
  const requested = { start: params.start_date, end: params.end_date };

  const payload: ChartPayload = {
    version: 1,
    realm: params.realm,
    statistic: params.statistic,
    group_by: params.group_by,
    dataset_type: params.dataset_type,
    requested,
    counted: { ...requested },
    last_period_incomplete: false,
    measure: {
      label,
      description: stripLabel(plainDescription(chartInfo.description ?? ""), label),
      kind,
      missing: kind === "total" ? "zero" : "gap",
    },
    dimension: { name: params.group_by, ordered: ORDERED_DIMENSIONS.has(params.group_by) },
    filters: { notes: matchNotes },
    data_through: null,
    data_through_precision: null,
    last_data_period_partial: false,
    has_more: hasMore,
    others_count: input.othersCount === undefined ? (hasMore ? null : 0) : input.othersCount,
    ranked_by: "value",
    offset: params.offset ?? 0,
    link,
    source: "XDMoD",
    retrieved: today,
  };

  if (params.dataset_type === "timeseries") {
    const unit = effectiveUnit(params.aggregation_unit, params.start_date, params.end_date);
    const starts = periodStarts(unit, params.start_date, params.end_date);
    if (starts.length === 0) {
      throw new Error(`No periods between ${params.start_date} and ${params.end_date}`);
    }
    const grid = new Set(starts);
    payload.unit = unit;
    payload.series = traces
      .filter((t) => t.name && !t.name.toLowerCase().includes("gap connector"))
      .map((t) => {
        const byStart = new Map<string, number>();
        for (const p of timeseriesPoints(t)) {
          if (!grid.has(p.start) || byStart.has(p.start)) {
            throw new Error(`XDMoD periods don't match the ${unit} grid`);
          }
          byStart.set(p.start, p.value);
        }
        return {
          name: stripRank(t.name as string),
          points: starts.map((start) => ({ start, value: byStart.get(start) ?? null })),
        };
      });
    for (const start of starts) {
      if (payload.series.some((sr) => sr.points.find((pt) => pt.start === start)?.value != null)) {
        payload.data_through = start;
      }
    }
    payload.counted = { start: starts[0], end: periodEnd(unit, starts[starts.length - 1]) };
    const probe = input.latestDataDay;
    let fromProbe = false;
    // The series' own last period wins. The realm-wide day only sharpens it
    // when it falls inside that same period.
    if (
      probe &&
      payload.data_through !== null &&
      probe >= payload.data_through &&
      probe <= periodEnd(unit, periodStartOf(unit, payload.data_through))
    ) {
      payload.data_through = probe;
      fromProbe = true;
    }
    if (payload.data_through !== null) {
      payload.data_through_precision = unit === "Day" || fromProbe ? "day" : "period";
      const own = periodStartOf(unit, payload.data_through);
      const laterEmpty = starts[starts.length - 1] > own;
      const cutShort = fromProbe && payload.data_through < periodEnd(unit, own);
      payload.last_data_period_partial = laterEmpty || cutShort;
    }
    payload.last_period_incomplete = payload.counted.end >= today;
    markEarlySeries(payload, unit, resourceDaysFor(params, input.resourceDays));
  } else {
    const trace = traces[0];
    const xs = trace?.x ?? [];
    const ys = trace?.y ?? [];
    let categories: NonNullable<ChartPayload["categories"]> = xs.map((x, i) => ({
      name: String(x),
      value: typeof ys[i] === "number" ? (ys[i] as number) : null,
    }));
    categories = categories.map((c) => ({ ...c, name: stripRank(c.name) }));
    if (dimensionOrder && dimensionOrder.length > 0 && payload.dimension.ordered) {
      // XDMoD leaves out a bucket with no jobs. Of a count or total, that
      // bucket is 0, so it is shown, but only when every bucket came back and
      // none was filtered or paged away.
      const fill =
        input.dimensionComplete &&
        kind === "total" &&
        categories.length > 0 &&
        !hasMore &&
        payload.offset === 0 &&
        params.filters?.[params.group_by] === undefined;
      if (fill) {
        const have = new Set(categories.map((c) => c.name));
        for (const name of dimensionOrder) {
          if (!have.has(name)) categories.push({ name, value: 0 });
        }
      }
      const rank = (name: string) => {
        const i = dimensionOrder.indexOf(name);
        return i === -1 ? dimensionOrder.length : i;
      };
      categories = categories
        .map((c, i) => ({ c, i }))
        .sort((a, b) => rank(a.c.name) - rank(b.c.name) || a.i - b.i)
        .map(({ c }) => c);
    }
    payload.categories = categories;
    // An aggregate has no periods to read the end of data from, so the realm's
    // latest data day says whether XDMoD's data reaches the end asked for.
    payload.last_period_incomplete = requested.end.slice(0, 10) >= today;
    const probe = input.latestDataDay;
    if (probe && probe < requested.end.slice(0, 10)) {
      payload.data_through = probe;
      payload.data_through_precision = "day";
    }
    const days = resourceDaysFor(params, input.resourceDays);
    if (days) {
      const end = payload.data_through ?? requested.end.slice(0, 10);
      for (const c of categories) {
        const day = days[c.name];
        if (day && day < end && day >= requested.start.slice(0, 10)) c.data_through = day;
      }
    }
  }
  return payload;
}

/** Per-resource days apply only when the chart's series or bars are resources. */
function resourceDaysFor(
  params: ChartDataParams,
  days: Record<string, string> | null | undefined
): Record<string, string> | undefined {
  return params.group_by === "resource" && days ? days : undefined;
}

/**
 * Marks each series whose data stops before the chart's: its own last period
 * is earlier, or its resource's last day falls before the chart's last day.
 */
function markEarlySeries(
  payload: ChartPayload,
  unit: Unit,
  days: Record<string, string> | undefined
): void {
  if (payload.data_through === null) return;
  const chartPeriod = periodStartOf(unit, payload.data_through);
  const chartEnd =
    payload.data_through_precision === "day" ? payload.data_through : periodEnd(unit, chartPeriod);
  for (const s of payload.series ?? []) {
    let last = -1;
    s.points.forEach((p, i) => {
      if (p.value !== null) last = i;
    });
    if (last === -1) continue;
    const own = s.points[last].start;
    const day = days?.[s.name];
    if (day && day >= own && day <= periodEnd(unit, own) && day < chartEnd) {
      s.data_through = day;
      s.data_through_precision = "day";
    } else if (own < chartPeriod) {
      s.data_through = own;
      s.data_through_precision = unit === "Day" ? "day" : "period";
    }
  }
}
