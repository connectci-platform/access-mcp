import { describe, it, expect } from "vitest";
import {
  buildChartPayload,
  effectiveUnit,
  measureKind,
  ORDERED_DIMENSIONS,
  periodStarts,
  type ChartDataParams,
} from "../chart-payload.js";

const ms = (date: string) => Date.parse(`${date}T05:00:00Z`);

const base: ChartDataParams = {
  realm: "Jobs",
  group_by: "resource",
  statistic: "job_count",
  start_date: "2026-08-01",
  end_date: "2026-11-08",
  dataset_type: "timeseries",
  aggregation_unit: "Month",
};

function build(
  over: Partial<Omit<Parameters<typeof buildChartPayload>[0], "params">> & {
    params?: Partial<ChartDataParams>;
  }
) {
  const { params, ...rest } = over;
  return buildChartPayload({
    params: { ...base, ...params },
    chartInfo: { description: "Jobs run", hc_jsonstore: { data: [] } },
    matchNotes: [],
    label: "Number of Jobs Ended",
    today: "2026-11-09",
    hasMore: false,
    link: "https://xdmod.example/chart",
    ...rest,
  });
}

describe("measureKind", () => {
  it.each([
    ["job_count", "total"],
    ["total_cpu_hours", "total"],
    ["active_person_count", "total"],
    ["gpu_time", "total"],
    ["wait_time", "total"],
    ["avg_waitduration_hours", "average"],
    ["utilization", "average"],
    ["rate_of_usage", "average"],
  ])("%s is %s", (stat, kind) => {
    expect(measureKind(stat)).toBe(kind);
  });
});

describe("ORDERED_DIMENSIONS", () => {
  it("lists the bucketed dimensions", () => {
    expect([...ORDERED_DIMENSIONS].sort()).toEqual([
      "gpu_count",
      "jobsize",
      "jobwaittime",
      "jobwalltime",
      "nodecount",
    ]);
  });
});

describe("effectiveUnit", () => {
  it("picks Day under six months", () => {
    expect(effectiveUnit(undefined, "2026-01-01", "2026-05-31")).toBe("Day");
  });
  it("picks Month under ten years", () => {
    expect(effectiveUnit(undefined, "2026-01-01", "2026-08-01")).toBe("Month");
  });
  it("picks Quarter for ten years or more", () => {
    expect(effectiveUnit("Auto", "2010-01-01", "2026-01-01")).toBe("Quarter");
  });
  it("keeps a requested unit", () => {
    expect(effectiveUnit("Month", "2026-10-01", "2026-11-08")).toBe("Month");
  });
});

describe("periodStarts", () => {
  it("lists months touching the range", () => {
    expect(periodStarts("Month", "2026-08-15", "2026-11-08")).toEqual([
      "2026-08-01",
      "2026-09-01",
      "2026-10-01",
      "2026-11-01",
    ]);
  });
  it("lists quarters", () => {
    expect(periodStarts("Quarter", "2026-02-10", "2026-05-01")).toEqual([
      "2026-01-01",
      "2026-04-01",
    ]);
  });
  it("lists days and years", () => {
    expect(periodStarts("Day", "2026-02-27", "2026-03-01")).toEqual([
      "2026-02-27",
      "2026-02-28",
      "2026-03-01",
    ]);
    expect(periodStarts("Year", "2025-06-01", "2026-02-01")).toEqual(["2025-01-01", "2026-01-01"]);
  });
});

describe("buildChartPayload timeseries", () => {
  const chartInfo = {
    description: "Jobs run",
    hc_jsonstore: {
      data: [
        { name: "Anvil", x: [ms("2026-09-01"), ms("2026-11-01")], y: [5, 7] },
        { name: "Anvil gap connector", x: [ms("2026-09-01")], y: [5] },
      ],
    },
  };

  it("fills missing periods with null and computes counted range", () => {
    const p = build({ chartInfo });
    expect(p.version).toBe(1);
    expect(p.unit).toBe("Month");
    expect(p.series).toHaveLength(1);
    expect(p.series![0].points).toEqual([
      { start: "2026-08-01", value: null },
      { start: "2026-09-01", value: 5 },
      { start: "2026-10-01", value: null },
      { start: "2026-11-01", value: 7 },
    ]);
    expect(p.requested).toEqual({ start: "2026-08-01", end: "2026-11-08" });
    expect(p.counted).toEqual({ start: "2026-08-01", end: "2026-11-30" });
    expect(p.last_period_incomplete).toBe(true);
    expect(p.measure).toMatchObject({
      label: "Number of Jobs Ended",
      description: "Jobs run",
      kind: "total",
    });
    expect(p.source).toBe("XDMoD");
    expect(p.retrieved).toBe("2026-11-09");
  });

  it("is complete when the last period has ended", () => {
    expect(build({ chartInfo, today: "2026-12-01" }).last_period_incomplete).toBe(false);
  });

  it("marks missing as zero for totals and gap for averages", () => {
    expect(build({ chartInfo }).measure.missing).toBe("zero");
    const avg = build({ chartInfo, params: { statistic: "avg_waitduration_hours" } });
    expect(avg.measure.missing).toBe("gap");
    expect(avg.series![0].points[0].value).toBeNull();
  });

  it("passes has_more, notes and link through", () => {
    const p = build({ chartInfo, hasMore: true, matchNotes: ["a -> 1"] });
    expect(p.has_more).toBe(true);
    expect(p.filters.notes).toEqual(["a -> 1"]);
    expect(p.link).toBe("https://xdmod.example/chart");
  });
});

describe("buildChartPayload aggregate", () => {
  const params = { dataset_type: "aggregate" };

  it("keeps XDMoD's order for unordered dimensions", () => {
    const p = build({
      params,
      chartInfo: { hc_jsonstore: { data: [{ x: ["Anvil", "Bridges"], y: [9, 3] }] } },
    });
    expect(p.categories).toEqual([
      { name: "Anvil", value: 9 },
      { name: "Bridges", value: 3 },
    ]);
    expect(p.dimension.ordered).toBe(false);
    expect(p.series).toBeUndefined();
    expect(p.counted).toEqual(p.requested);
  });

  it("reorders ordered dimensions by dimensionOrder", () => {
    const p = build({
      params: { ...params, group_by: "jobsize" },
      dimensionOrder: ["1", "2 - 4", "5 - 8"],
      chartInfo: { hc_jsonstore: { data: [{ x: ["5 - 8", "1", "2 - 4"], y: [30, 20, 10] }] } },
    });
    expect(p.dimension.ordered).toBe(true);
    expect(p.categories!.map((c) => c.name)).toEqual(["1", "2 - 4", "5 - 8"]);
  });
});

describe("buildChartPayload edge cases", () => {
  const info = (x: string[], y: number[]) => ({
    hc_jsonstore: { data: [{ name: "A", x: x.map(ms), y }] },
  });

  it("throws when day points collide on a month grid", () => {
    expect(() =>
      build({ chartInfo: info(["2026-08-01", "2026-08-02", "2026-08-03"], [1, 2, 3]) })
    ).toThrow(/don't match the Month grid/);
  });

  it("throws when month points sit on a day grid", () => {
    expect(() =>
      build({
        params: { aggregation_unit: "Day", start_date: "2026-08-01", end_date: "2026-08-05" },
        chartInfo: info(["2026-08-01"], [1]),
      })
    ).not.toThrow();
    expect(() =>
      build({
        params: { aggregation_unit: "Day", start_date: "2026-08-01", end_date: "2026-08-05" },
        chartInfo: info(["2026-07-01"], [1]),
      })
    ).toThrow(/don't match the Day grid/);
  });

  it("throws a clear error for an inverted range", () => {
    expect(() =>
      build({
        params: { start_date: "2026-11-08", end_date: "2026-08-01" },
        chartInfo: info([], []),
      })
    ).toThrow(/No periods/);
  });

  it("does not reorder a nominal dimension", () => {
    const p = build({
      params: { dataset_type: "aggregate", group_by: "resource" },
      dimensionOrder: ["B", "A"],
      chartInfo: { hc_jsonstore: { data: [{ x: ["A", "B"], y: [1, 2] }] } },
    });
    expect(p.categories!.map((c) => c.name)).toEqual(["A", "B"]);
  });

  it("sorts categories missing from dimensionOrder after listed ones", () => {
    const p = build({
      params: { dataset_type: "aggregate", group_by: "jobsize" },
      dimensionOrder: ["1", "2 - 4"],
      chartInfo: { hc_jsonstore: { data: [{ x: ["9+", "2 - 4", "1"], y: [1, 2, 3] }] } },
    });
    expect(p.categories!.map((c) => c.name)).toEqual(["1", "2 - 4", "9+"]);
  });

  it("handles an empty data array", () => {
    expect(build({ chartInfo: { hc_jsonstore: { data: [] } } }).series).toEqual([]);
    expect(
      build({ params: { dataset_type: "aggregate" }, chartInfo: { hc_jsonstore: { data: [] } } })
        .categories
    ).toEqual([]);
  });

  it("rolls December into January for months and quarters", () => {
    expect(periodStarts("Month", "2026-11-20", "2027-01-05")).toEqual([
      "2026-11-01",
      "2026-12-01",
      "2027-01-01",
    ]);
    expect(periodStarts("Quarter", "2026-11-20", "2027-01-05")).toEqual([
      "2026-10-01",
      "2027-01-01",
    ]);
    const p = build({
      params: { start_date: "2026-12-01", end_date: "2027-01-05" },
      chartInfo: info(["2026-12-01", "2027-01-01"], [1, 2]),
    });
    expect(p.counted).toEqual({ start: "2026-12-01", end: "2027-01-31" });
  });

  it("ends the counted range at a month end when the range does", () => {
    const p = build({
      params: { start_date: "2026-08-01", end_date: "2026-09-30" },
      chartInfo: info(["2026-08-01", "2026-09-01"], [1, 2]),
    });
    expect(p.counted).toEqual({ start: "2026-08-01", end: "2026-09-30" });
  });
});
