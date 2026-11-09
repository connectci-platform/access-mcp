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
  filters: { notes: string[] };
  series?: { name: string; points: { start: string; value: number | null }[] }[];
  categories?: { name: string; value: number | null }[];
  has_more: boolean;
  ranked_by: "value";
  link: string;
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

export function measureKind(statistic: string): MeasureKind {
  if (statistic.startsWith("total_") || statistic.endsWith("_count")) return "total";
  if (statistic === "gpu_time" || statistic === "wait_time") return "total";
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

export function buildChartPayload(input: {
  params: ChartDataParams;
  chartInfo: ChartInfo;
  matchNotes: string[];
  label: string;
  today: string;
  hasMore: boolean;
  dimensionOrder?: string[];
  link: string;
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
      description: chartInfo.description ?? "",
      kind,
      missing: kind === "total" ? "zero" : "gap",
    },
    dimension: { name: params.group_by, ordered: ORDERED_DIMENSIONS.has(params.group_by) },
    filters: { notes: matchNotes },
    has_more: hasMore,
    ranked_by: "value",
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
          name: t.name as string,
          points: starts.map((start) => ({ start, value: byStart.get(start) ?? null })),
        };
      });
    payload.counted = { start: starts[0], end: periodEnd(unit, starts[starts.length - 1]) };
    payload.last_period_incomplete = payload.counted.end >= today;
  } else {
    const trace = traces[0];
    const xs = trace?.x ?? [];
    const ys = trace?.y ?? [];
    let categories = xs.map((x, i) => ({
      name: String(x),
      value: typeof ys[i] === "number" ? (ys[i] as number) : null,
    }));
    if (dimensionOrder && dimensionOrder.length > 0 && payload.dimension.ordered) {
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
  }
  return payload;
}
