import { describe, it, expect } from "vitest";
import {
  aggregateDataNote,
  buildChartPayload,
  earlyEndNote,
  offsetNote,
  effectiveUnit,
  measureKind,
  ORDERED_DIMENSIONS,
  partialPeriodNote,
  periodStarts,
  plainDescription,
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
    // Sums whose ids don't say so, per XDMoD's definitions.
    ["used_su", "total"],
    ["used_ace", "total"],
    ["allocated_ace", "total"],
    ["allocated_su", "total"],
    ["cloud_num_sessions_started", "total"],
    ["cloud_wall_time", "total"],
    ["cloud_core_time", "total"],
    ["wall_time", "total"],
    ["cpu_time_user", "total"],
    ["requested_wall_time", "total"],
    ["allocated_cpu_core_hours", "total"],
    ["ace_total", "total"],
    // Named total_, but a per-day average.
    ["total_avg_number_of_cpu_cores", "average"],
    ["total_avg_number_of_gpus", "average"],
    ["allocated_avg_number_of_gpu_nodes", "average"],
    ["cloud_avg_wallduration_hours", "average"],
    ["wall_time_per_job", "average"],
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

describe("plainDescription", () => {
  it("turns XDMoD's HTML into plain text", () => {
    const html =
      "<b>Wait Hours: Per Job</b>: The average time, in hours, a job waited.<br/><i>Wait Time: </i>Wait time is defined as the time between submission &amp; start.";
    expect(plainDescription(html)).toBe(
      "Wait Hours: Per Job: The average time, in hours, a job waited. Wait Time: Wait time is defined as the time between submission & start."
    );
  });

  it("uses a sentence break when no punctuation precedes a br", () => {
    expect(plainDescription("One<br>Two&nbsp;&lt;3&gt; &quot;x&quot; it&#39;s")).toBe(
      'One. Two <3> "x" it\'s'
    );
  });
});

describe("rank prefixes and data_through", () => {
  const info = {
    description: "d",
    hc_jsonstore: {
      data: [
        { name: "1. NCSA DELTA GPU", x: [ms("2026-08-01"), ms("2026-09-01")], y: [3, null] },
        { name: "2. NCSA DELTA CPU", x: [ms("2026-08-01"), ms("2026-09-01")], y: [1, 2] },
      ],
    },
  };

  it("strips rank prefixes from series names", () => {
    const p = build({ chartInfo: info, params: { end_date: "2026-09-30" } });
    expect(p.series!.map((s) => s.name)).toEqual(["NCSA DELTA GPU", "NCSA DELTA CPU"]);
  });

  it("strips rank prefixes from category names", () => {
    const p = build({
      params: { dataset_type: "aggregate" },
      chartInfo: { hc_jsonstore: { data: [{ name: "m", x: ["1. A", "2. B"], y: [2, 1] }] } },
    });
    expect(p.categories!.map((c) => c.name)).toEqual(["A", "B"]);
    expect(p.data_through).toBeNull();
  });

  it("reports the last period with any value", () => {
    const p = build({ chartInfo: info, params: { end_date: "2026-11-08" } });
    expect(p.data_through).toBe("2026-09-01");
  });

  it("is null when no series has a value", () => {
    const p = build({
      params: { end_date: "2026-09-30" },
      chartInfo: { hc_jsonstore: { data: [{ name: "A", x: [ms("2026-08-01")], y: [null] }] } },
    });
    expect(p.data_through).toBeNull();
  });
});

describe("partial last data period and label stripping", () => {
  const info = (unit: "m" | "d") => ({
    hc_jsonstore: {
      data: [
        unit === "m"
          ? { name: "A", x: [ms("2026-08-01"), ms("2026-09-01"), ms("2026-10-01")], y: [12, 11, 0.05] }
          : { name: "A", x: [ms("2026-10-01")], y: [1] },
      ],
    },
  });

  it("flags a last data period followed by empty periods", () => {
    const p = build({ chartInfo: info("m"), params: { end_date: "2026-11-08" } });
    expect(p.data_through).toBe("2026-10-01");
    expect(p.last_data_period_partial).toBe(true);
  });

  it("does not flag when data reaches the last period, or for aggregates", () => {
    expect(build({ chartInfo: info("m"), params: { end_date: "2026-10-31" } }).last_data_period_partial).toBe(false);
    const agg = build({
      params: { dataset_type: "aggregate" },
      chartInfo: { hc_jsonstore: { data: [{ name: "m", x: ["a"], y: [1] }] } },
    });
    expect(agg.last_data_period_partial).toBe(false);
  });

  it("words the note for Month and Day", () => {
    const month = build({ chartInfo: info("m"), params: { end_date: "2026-11-08" } });
    // Without the probe the month start isn't the day data stops.
    expect(month.data_through_precision).toBe("period");
    expect(partialPeriodNote(month)).toBe(
      "XDMoD has no data after Oct 2026, so the Oct 2026 value may cover only part of that period. Don't read it as a change."
    );
    const day = build({
      chartInfo: info("d"),
      params: { aggregation_unit: "Day", start_date: "2026-09-29", end_date: "2026-10-03" },
    });
    expect(day.data_through_precision).toBe("day");
    expect(partialPeriodNote(day)).toBe(
      "XDMoD has data only through Oct 1, 2026, so the Oct 1, 2026 value may cover only part of that period, and later periods have no data yet. Don't read it as a change."
    );
  });

  it("strips the label from the start of the description", () => {
    const p = build({
      label: "Wait Hours: Per Job",
      chartInfo: {
        description:
          "<b>Wait Hours: Per Job</b>: The average time, in hours, a job waited.<br/><i>Wait Time: </i>Wait time is defined as the time between submission &amp; start.",
        hc_jsonstore: { data: [] },
      },
    });
    expect(p.measure.description).toBe(
      "The average time, in hours, a job waited. Wait Time: Wait time is defined as the time between submission & start."
    );
  });
});

describe("latestDataDay", () => {
  const info = {
    hc_jsonstore: {
      data: [{ name: "A", x: [ms("2026-08-01"), ms("2026-09-01"), ms("2026-10-01")], y: [12, 11, 0.05] }],
    },
  };
  const range = { end_date: "2026-10-31" };

  it("marks the last period partial when the probe day falls inside it", () => {
    const p = build({ chartInfo: info, params: range, latestDataDay: "2026-10-01" });
    expect(p.data_through).toBe("2026-10-01");
    expect(p.last_data_period_partial).toBe(true);
    expect(partialPeriodNote(p)).toBe(
      "XDMoD has data only through Oct 1, 2026, so the Oct 2026 value may cover only part of that period. Don't read it as a change."
    );
  });

  it("keeps the series rule when the probe day is after the range", () => {
    const p = build({ chartInfo: info, params: range, latestDataDay: "2026-11-05" });
    expect(p.data_through).toBe("2026-10-01");
    // October is the last period and holds data: Oct 1 is only its start.
    expect(p.data_through_precision).toBe("period");
    expect(p.last_data_period_partial).toBe(false);
    expect(partialPeriodNote(p)).toBeUndefined();
  });

  it("says day precision when the probe sharpens a month", () => {
    const p = build({ chartInfo: info, params: range, latestDataDay: "2026-10-01" });
    expect(p.data_through_precision).toBe("day");
  });

  it("lets a series that ended earlier win over a later realm-wide day", () => {
    const anvil = {
      hc_jsonstore: {
        data: [{ name: "Anvil", x: [ms("2026-10-18"), ms("2026-10-19")], y: [4, 5] }],
      },
    };
    const p = build({
      chartInfo: anvil,
      params: { aggregation_unit: "Day", start_date: "2026-10-18", end_date: "2026-11-08" },
      latestDataDay: "2026-11-08",
    });
    expect(p.data_through).toBe("2026-10-19");
    expect(p.last_data_period_partial).toBe(true);
    expect(partialPeriodNote(p)).toContain("through Oct 19, 2026, so the Oct 19, 2026 value");
  });

  it("is not partial when the probe day is the last day of the period", () => {
    const p = build({ chartInfo: info, params: range, latestDataDay: "2026-10-31" });
    expect(p.data_through).toBe("2026-10-31");
    expect(p.last_data_period_partial).toBe(false);
  });
});

describe("aggregates and the latest data day", () => {
  const agg = (over: Parameters<typeof build>[0] = {}) =>
    build({
      ...over,
      params: { dataset_type: "aggregate", start_date: "2026-01-01", end_date: "2026-11-09", ...over.params },
      chartInfo: { hc_jsonstore: { data: [{ name: "m", x: ["a", "b"], y: [2, 1] }] } },
    });

  it("is incomplete when the range reaches today", () => {
    expect(agg().last_period_incomplete).toBe(true);
    expect(agg({ params: { end_date: "2026-10-31" } }).last_period_incomplete).toBe(false);
  });

  it("takes the probe day as data_through when it is before the end asked for", () => {
    const p = agg({ latestDataDay: "2026-10-01" });
    expect(p.data_through).toBe("2026-10-01");
    expect(p.data_through_precision).toBe("day");
    expect(aggregateDataNote(p)).toBe(
      "XDMoD has data only through Oct 1, 2026, but the range asked for runs to Nov 9, 2026, so these values leave out the rest of the range."
    );
  });

  it("has no data_through when the probe reaches the end, or is unknown", () => {
    expect(agg({ latestDataDay: "2026-11-09" }).data_through).toBeNull();
    const p = agg({ latestDataDay: null });
    expect(p.data_through).toBeNull();
    expect(p.data_through_precision).toBeNull();
    expect(aggregateDataNote(p)).toBeUndefined();
  });

  it("gives no aggregate note for a timeseries", () => {
    expect(aggregateDataNote(build({ latestDataDay: "2026-10-01" }))).toBeUndefined();
  });
});

describe("others_count", () => {
  it("is 0 with nothing left out, null when there is more but no count, and passed through", () => {
    expect(build({}).others_count).toBe(0);
    expect(build({ hasMore: true }).others_count).toBeNull();
    expect(build({ hasMore: true, othersCount: 38 }).others_count).toBe(38);
  });
});

describe("series that stop early", () => {
  const months = ["2026-08-01", "2026-09-01", "2026-10-01"];
  const trace = (name: string, ys: (number | null)[]) => ({ name, x: months.map(ms), y: ys });
  const since = "2026-07-13";
  const values = (p: ReturnType<typeof build>, i: number) => p.series![i].points.map((pt) => pt.value);

  it("fills a count's trailing empty months with 0 when the resource has data later (f1)", () => {
    // job_count by resource, filtered to one field: ACES ran none of its jobs
    // after August, but the probe shows ACES has data through Oct 30.
    const p = build({
      params: { end_date: "2026-10-31", filters: { fieldofscience: "Other humanities" } },
      chartInfo: { hc_jsonstore: { data: [trace("Bridges 2 RM", [1, 2, 3]), trace("Texas A&M U ACES", [4, null, null])] } },
      resourceDays: { since, days: { "Bridges 2 RM": "2026-10-31", "Texas A&M U ACES": "2026-10-30" } },
    });
    expect(values(p, 1)).toEqual([4, 0, 0]);
    // Oct 30 is inside the chart's last month, which runs to Oct 31.
    expect(p.series![1]).toMatchObject({ data_through: "2026-10-30", data_through_source: "resource" });
    expect(earlyEndNote(p)).toBe("XDMoD has no data from Texas A&M U ACES after Oct 30, 2026.");
    expect(earlyEndNote(p)).not.toMatch(/missing|not zero|later periods/);
  });

  it("fills only up to the resource's last day and says its data stops there", () => {
    const p = build({
      params: { end_date: "2026-10-31" },
      chartInfo: { hc_jsonstore: { data: [trace("A", [1, 2, 3]), trace("Anvil", [4, null, null])] } },
      resourceDays: { since, days: { A: "2026-10-31", Anvil: "2026-09-19" } },
    });
    expect(values(p, 1)).toEqual([4, 0, null]);
    expect(p.series![1]).toMatchObject({
      data_through: "2026-09-19",
      data_through_precision: "day",
      data_through_source: "resource",
    });
    expect(earlyEndNote(p)).toBe("XDMoD has no data from Anvil after Sep 19, 2026.");
  });

  it("says a day inside the last period without claiming later periods (t2)", () => {
    const p = build({
      params: { end_date: "2026-10-31" },
      chartInfo: { hc_jsonstore: { data: [trace("A", [1, 2, 3]), trace("B", [1, 2, 3])] } },
      resourceDays: { since, days: { A: "2026-10-31", B: "2026-10-19" } },
    });
    expect(p.series![0].data_through).toBeUndefined();
    expect(p.series![1]).toMatchObject({ data_through: "2026-10-19", data_through_precision: "day" });
    expect(earlyEndNote(p)).toBe("XDMoD has no data from B after Oct 19, 2026.");
  });

  it("a resource the probe hasn't seen since before its last period really stops there", () => {
    const p = build({
      params: { end_date: "2026-10-31" },
      chartInfo: { hc_jsonstore: { data: [trace("A", [1, 2, 3]), trace("Retired", [1, null, null])] } },
      resourceDays: { since: "2026-08-15", days: { A: "2026-10-31" } },
    });
    expect(values(p, 1)).toEqual([1, null, null]);
    expect(p.series![1]).toMatchObject({ data_through: "2026-08-01", data_through_source: "resource" });
    expect(earlyEndNote(p)).toBe("XDMoD has no data from Retired after Aug 2026.");
  });

  it("without the probe, leaves gaps and says only that nothing is recorded", () => {
    const p = build({
      params: { end_date: "2026-10-31" },
      chartInfo: { hc_jsonstore: { data: [trace("A", [1, 2, 3]), trace("B", [1, 2, null])] } },
      resourceDays: null,
    });
    expect(values(p, 1)).toEqual([1, 2, null]);
    expect(p.series![1]).toMatchObject({ data_through: "2026-09-01", data_through_precision: "period", data_through_source: "series" });
    expect(earlyEndNote(p)).toBe("Nothing is recorded for B after Sep 2026.");
  });

  it("a probe that saw the resource only before the window leaves it unexplained", () => {
    const p = build({
      params: { end_date: "2026-10-31" },
      chartInfo: { hc_jsonstore: { data: [trace("A", [1, 2, 3]), trace("Old", [1, null, null])] } },
      resourceDays: { since: "2026-10-01", days: { A: "2026-10-31" } },
    });
    expect(p.series![1].data_through_source).toBe("series");
  });

  it("fills a count's trailing empties for other dimensions, with no per-series note (t3)", () => {
    const p = build({
      params: { end_date: "2026-10-31", group_by: "fieldofscience" },
      chartInfo: { hc_jsonstore: { data: [trace("Physics", [1, 2, 3]), trace("Arts", [5, null, null])] } },
      resourceDays: { since, days: { Arts: "2026-08-02" } },
    });
    expect(values(p, 1)).toEqual([5, 0, 0]);
    expect(p.series![1].data_through).toBeUndefined();
    expect(earlyEndNote(p)).toBeUndefined();
  });

  it("an average's trailing empties stay gaps, with no note", () => {
    const p = build({
      params: { end_date: "2026-10-31", group_by: "fieldofscience", statistic: "avg_waitduration_hours" },
      chartInfo: { hc_jsonstore: { data: [trace("Physics", [1, 2, 3]), trace("Arts", [5, null, null])] } },
    });
    expect(values(p, 1)).toEqual([5, null, null]);
    expect(earlyEndNote(p)).toBeUndefined();
  });

  it("an average by resource stays a gap where the resource has data, without a note", () => {
    const p = build({
      params: { end_date: "2026-10-31", statistic: "avg_waitduration_hours" },
      chartInfo: { hc_jsonstore: { data: [trace("A", [1, 2, 3]), trace("B", [1, null, null])] } },
      resourceDays: { since, days: { A: "2026-10-31", B: "2026-10-31" } },
    });
    expect(values(p, 1)).toEqual([1, null, null]);
    expect(earlyEndNote(p)).toBeUndefined();
  });

  it("puts resources that stop on the same day together", () => {
    const p = build({
      params: { end_date: "2026-10-31" },
      chartInfo: {
        hc_jsonstore: {
          data: [trace("A", [1, 2, 3]), trace("B", [1, 2, 3]), trace("C", [1, 2, 3]), trace("D", [1, 2, 3])],
        },
      },
      resourceDays: { since, days: { A: "2026-10-31", B: "2026-10-30", C: "2026-10-30", D: "2026-10-19" } },
    });
    expect(earlyEndNote(p)).toBe(
      "XDMoD has no data from B and C after Oct 30, 2026; XDMoD has no data from D after Oct 19, 2026."
    );
  });

  it("a daily chart names the last day", () => {
    const days = ["2026-11-06", "2026-11-07", "2026-11-08"];
    const p = build({
      params: { start_date: "2026-11-06", end_date: "2026-11-08", aggregation_unit: "Day" },
      chartInfo: {
        hc_jsonstore: {
          data: [
            { name: "A", x: days.map(ms), y: [1, 2, 3] },
            { name: "B", x: days.map(ms), y: [1, null, null] },
          ],
        },
      },
      resourceDays: null,
    });
    expect(p.series![1]).toMatchObject({ data_through: "2026-11-06", data_through_precision: "day" });
    expect(earlyEndNote(p)).toBe("Nothing is recorded for B after Nov 6, 2026.");
  });

  it("an aggregate marks resources whose data stops before the chart's end", () => {
    const p = build({
      params: { dataset_type: "aggregate", start_date: "2026-10-01", end_date: "2026-11-09" },
      chartInfo: { hc_jsonstore: { data: [{ name: "m", x: ["A", "B", "C"], y: [3, 2, 1] }] } },
      latestDataDay: "2026-11-08",
      resourceDays: { since, days: { A: "2026-11-08", B: "2026-10-19", C: "2026-09-01" } },
    });
    expect(p.categories!.map((c) => c.data_through)).toEqual([undefined, "2026-10-19", undefined]);
    expect(earlyEndNote(p)).toBe("XDMoD has no data from B after Oct 19, 2026.");
  });
});

describe("empty ordered buckets", () => {
  const agg = (extra: Partial<Parameters<typeof build>[0]> = {}, params: Partial<ChartDataParams> = {}) =>
    build({
      params: { dataset_type: "aggregate", group_by: "jobsize", ...params },
      chartInfo: { hc_jsonstore: { data: [{ name: "m", x: ["5 - 8", "1"], y: [4, 9] }] } },
      dimensionOrder: ["1", "2 - 4", "5 - 8", "> 8"],
      dimensionComplete: true,
      ...extra,
    });

  it("fills a count's empty buckets with 0 in XDMoD's order", () => {
    expect(agg().categories).toEqual([
      { name: "1", value: 9 },
      { name: "2 - 4", value: 0 },
      { name: "5 - 8", value: 4 },
      { name: "> 8", value: 0 },
    ]);
  });

  it.each([
    ["an average", {}, { statistic: "avg_waitduration_hours" }],
    ["a cut-short bucket list", { dimensionComplete: false }, {}],
    ["more left out", { hasMore: true }, {}],
    ["an offset", {}, { offset: 1 }],
    ["a filter on the buckets", {}, { filters: { jobsize: "1" } }],
  ])("doesn't fill for %s", (_label, extra, params) => {
    expect(agg(extra, params).categories!.map((c) => c.name)).toEqual(["1", "5 - 8"]);
  });
});

describe("offsetNote", () => {
  it("says which ranks a page past the top holds", () => {
    const p = build({ params: { dataset_type: "aggregate", offset: 3 } });
    expect(p.offset).toBe(3);
    expect(offsetNote(p, 5)).toBe("These are ranks 4 to 8 by value: XDMoD's top 3 are left out (offset 3).");
    expect(offsetNote(p, 0)).toBeUndefined();
    expect(offsetNote(build({ params: { dataset_type: "aggregate" } }), 5)).toBeUndefined();
  });

  it("says an ordered dimension skips its first buckets, not the largest", () => {
    const p = build({ params: { dataset_type: "aggregate", group_by: "jobsize", offset: 2 } });
    expect(offsetNote(p, 4)).toBe(
      "These are buckets 3 to 6 in XDMoD's order: the first 2 are left out (offset 2)."
    );
    expect(offsetNote(build({ params: { dataset_type: "aggregate", group_by: "jobsize", offset: 1 } }), 1)).toBe(
      "These are buckets 2 to 2 in XDMoD's order: the first 1 is left out (offset 1)."
    );
  });
});
