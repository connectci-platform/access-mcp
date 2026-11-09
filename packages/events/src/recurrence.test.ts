import { describe, it, expect } from "vitest";
import { DRUPAL_CONTRACT, fmt12, validateRecurrence, RECURRENCE_EXAMPLES } from "./recurrence.js";
import { buildRuleField } from "./recurrence.js";

describe("DRUPAL_CONTRACT", () => {
  it("maps short weekdays to Drupal's full lowercase names", () => {
    expect(DRUPAL_CONTRACT.weekdays.mon).toBe("monday");
    expect(DRUPAL_CONTRACT.weekdays.sun).toBe("sunday");
    expect(Object.keys(DRUPAL_CONTRACT.weekdays)).toHaveLength(7);
  });
  it("maps short months to Drupal's capitalized 3-letter form", () => {
    expect(DRUPAL_CONTRACT.months.mar).toBe("Mar");
    expect(DRUPAL_CONTRACT.months.dec).toBe("Dec");
    expect(Object.keys(DRUPAL_CONTRACT.months)).toHaveLength(12);
  });
  it("lists all five week positions and both monthly modes", () => {
    expect(DRUPAL_CONTRACT.weekPositions).toEqual(["first","second","third","fourth","last"]);
    expect(DRUPAL_CONTRACT.monthlyModes).toEqual(["weekday","monthday"]);
  });
});

describe("fmt12", () => {
  it("converts 24h HH:MM to Drupal 12-hour uppercase", () => {
    expect(fmt12("14:00")).toBe("02:00 PM");
    expect(fmt12("09:00")).toBe("09:00 AM");
    expect(fmt12("00:00")).toBe("12:00 AM");
    expect(fmt12("12:00")).toBe("12:00 PM");
    expect(fmt12("23:30")).toBe("11:30 PM");
  });
});

const base = { start_date: "2026-09-01", end_date: "2026-09-30" };

describe("validateRecurrence", () => {
  it("accepts a valid weekly intent", () => {
    const r = validateRecurrence({ frequency: "weekly", ...base, start_time: "14:00", duration_minutes: 60, days: ["mon","wed"] });
    expect(r.ok).toBe(true);
    expect(r.errors).toEqual([]);
  });
  it("rejects an unknown frequency (validation_error)", () => {
    const r = validateRecurrence({ frequency: "fortnightly" as never, ...base });
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.code === "validation_error")).toBe(true);
  });
  it("rejects missing required field: weekly with no days", () => {
    const r = validateRecurrence({ frequency: "weekly", ...base, start_time: "14:00", duration_minutes: 60 });
    expect(r.errors.some((e) => e.code === "validation_error" && /days/.test(e.message))).toBe(true);
  });
  it("rejects over-fill: days_of_month on weekday mode (over_fill)", () => {
    const r = validateRecurrence({ frequency: "monthly", ...base, start_time: "14:00", duration_minutes: 60, monthly_mode: "weekday", week_positions: ["third"], days: ["tue"], days_of_month: [15] });
    expect(r.errors.some((e) => e.code === "over_fill")).toBe(true);
  });
  it("rejects both duration_minutes and ends_at together (over_fill)", () => {
    const r = validateRecurrence({ frequency: "daily", ...base, start_time: "09:00", duration_minutes: 60, ends_at: "17:00" });
    expect(r.errors.some((e) => e.code === "over_fill")).toBe(true);
  });
  it("rejects out-of-vocab weekday (out_of_vocab)", () => {
    const r = validateRecurrence({ frequency: "weekly", ...base, start_time: "14:00", duration_minutes: 60, days: ["funday"] });
    expect(r.errors.some((e) => e.code === "out_of_vocab")).toBe(true);
  });
  it("rejects end_date before start_date (out_of_vocab)", () => {
    const r = validateRecurrence({ frequency: "daily", start_date: "2026-09-30", end_date: "2026-09-01", start_time: "09:00", duration_minutes: 60 });
    expect(r.errors.some((e) => e.code === "out_of_vocab")).toBe(true);
  });
  it("rejects a non-bare (datetime-shaped) start_date (validation_error)", () => {
    const r = validateRecurrence({ frequency: "daily", start_date: "2026-09-01T00:00:00", end_date: "2026-09-30", start_time: "09:00", duration_minutes: 60 });
    expect(r.errors.some((e) => e.code === "validation_error" && /start_date must be a bare calendar date/.test(e.message))).toBe(true);
    // and it must NOT spuriously flag ordering
    expect(r.errors.some((e) => e.code === "out_of_vocab" && /before/.test(e.message))).toBe(false);
  });
  it("rejects a non-bare end_date (validation_error)", () => {
    const r = validateRecurrence({ frequency: "daily", start_date: "2026-09-01", end_date: "2026-09-30T12:00:00", start_time: "09:00", duration_minutes: 60 });
    expect(r.errors.some((e) => e.code === "validation_error" && /end_date must be a bare calendar date/.test(e.message))).toBe(true);
  });
  it("a mixed-shape same-day range does NOT falsely report end-before-start", () => {
    // start_date is datetime-shaped, end_date bare, same calendar day. The old
    // string compare "2026-10-01" < "2026-10-01T12:00:00" would spuriously fire.
    const r = validateRecurrence({ frequency: "daily", start_date: "2026-10-01T12:00:00", end_date: "2026-10-01", start_time: "09:00", duration_minutes: 60 });
    expect(r.errors.some((e) => e.code === "validation_error" && /start_date must be a bare/.test(e.message))).toBe(true);
    expect(r.errors.some((e) => e.code === "out_of_vocab" && /before/.test(e.message))).toBe(false);
  });
  it("returns ALL errors, not first-only", () => {
    const r = validateRecurrence({ frequency: "weekly", ...base, days: ["funday"] }); // missing start_time+duration AND bad weekday
    expect(r.errors.length).toBeGreaterThan(1);
  });
});

const win = { start_date: "2026-09-01", end_date: "2026-09-30" };

describe("buildRuleField — native key + exact columns", () => {
  it("weekly (duration branch)", () => {
    const out = buildRuleField({ frequency: "weekly", ...win, start_time: "14:00", duration_minutes: 60, days: ["mon","wed"] });
    expect(out.recur_type).toBe("weekly_recurring_date");
    expect(out.weekly_recurring_date).toEqual({
      value: "2026-09-01T00:00:00", end_value: "2026-09-30T00:00:00", time: "02:00 PM",
      duration_or_end_time: "duration", duration: 3600, end_time: "",
      days: "monday,wednesday",
    });
  });
  it("daily end-time branch sets end_time column + duration 0", () => {
    const out = buildRuleField({ frequency: "daily", ...win, start_time: "09:00", ends_at: "17:00" });
    expect(out.recur_type).toBe("daily_recurring_date");
    expect(out.daily_recurring_date).toMatchObject({
      duration_or_end_time: "end_time", end_time: "05:00 PM", duration: 0,
    });
  });
  it("monthly weekday mode (3rd Tuesday)", () => {
    const out = buildRuleField({ frequency: "monthly", ...win, start_time: "14:00", duration_minutes: 60, monthly_mode: "weekday", week_positions: ["third"], days: ["tue"] });
    expect(out.recur_type).toBe("monthly_recurring_date");
    expect(out.monthly_recurring_date).toMatchObject({
      type: "weekday", day_occurrence: "third", days: "tuesday", day_of_month: "",
    });
  });
  it("monthly monthday mode with -1 (last day)", () => {
    const out = buildRuleField({ frequency: "monthly", ...win, start_time: "14:00", duration_minutes: 60, monthly_mode: "monthday", days_of_month: [1,15,-1] });
    expect(out.monthly_recurring_date).toMatchObject({
      type: "monthday", day_of_month: "1,15,-1", day_occurrence: "", days: "",
    });
  });
  it("yearly maps months to capitalized 3-letter + year_interval", () => {
    const out = buildRuleField({ frequency: "yearly", ...win, start_time: "14:00", duration_minutes: 60, monthly_mode: "weekday", week_positions: ["first"], days: ["mon"], year_interval: 2, months: ["mar","apr"] });
    expect(out.recur_type).toBe("yearly_recurring_date");
    expect(out.yearly_recurring_date).toMatchObject({ year_interval: 2, months: "Mar,Apr", type: "weekday" });
  });
  it("consecutive wires window_end -> end_time (NOT end_value)", () => {
    const out = buildRuleField({ frequency: "consecutive", ...win, window_start: "09:00", window_end: "17:00", session_minutes: 10, gap_minutes: 5 });
    expect(out.recur_type).toBe("consecutive_recurring_date");
    expect(out.consecutive_recurring_date).toEqual({
      value: "2026-09-01T00:00:00", end_value: "2026-09-30T00:00:00", time: "09:00 AM", end_time: "05:00 PM",
      duration: 10, duration_units: "minute", buffer: 5, buffer_units: "minute",
    });
  });
});

describe("DRUPAL_CONTRACT drift guard", () => {
  // If any of these fail, Drupal's recurring_events vocab may have changed —
  // re-verify against the FieldType/widget source before editing these numbers.
  // Source pointers are in recurrence.ts's DRUPAL_CONTRACT comment.
  it("has exactly the Drupal-verified vocab sizes", () => {
    expect(Object.keys(DRUPAL_CONTRACT.weekdays)).toHaveLength(7);
    expect(Object.values(DRUPAL_CONTRACT.weekdays)).toContain("monday"); // full lowercase, not "mon"
    expect(DRUPAL_CONTRACT.weekPositions).toHaveLength(5);
    expect(Object.keys(DRUPAL_CONTRACT.months)).toHaveLength(12);
    expect(Object.values(DRUPAL_CONTRACT.months)).toContain("Mar"); // capitalized 3-letter
    expect(DRUPAL_CONTRACT.monthlyModes).toEqual(["weekday", "monthday"]);
  });
});

describe("RECURRENCE_EXAMPLES", () => {
  it.each(RECURRENCE_EXAMPLES.map((e) => [e.label, e.intent] as const))("%s passes validation", (_label, intent) => {
    expect(validateRecurrence(intent)).toEqual({ ok: true, errors: [] });
  });
});

describe("validateRecurrence time format", () => {
  it.each([
    ["start_time", { frequency: "daily", ...base, start_time: "2026-09-01", duration_minutes: 60 }],
    ["ends_at", { frequency: "daily", ...base, start_time: "09:00", ends_at: "5pm" }],
    ["start_time", { frequency: "daily", ...base, start_time: "9:00", duration_minutes: 60 }],
    ["window_start", { frequency: "consecutive", ...base, window_start: "2026-09-01", window_end: "17:00", session_minutes: 30, gap_minutes: 0 }],
    ["window_end", { frequency: "consecutive", ...base, window_start: "09:00", window_end: "24:00", session_minutes: 30, gap_minutes: 0 }],
  ] as const)("refuses a malformed %s", (field, intent) => {
    const r = validateRecurrence(intent as never);
    expect(r.ok).toBe(false);
    expect(r.errors).toEqual([
      { code: "validation_error", message: `${field} must be a 24-hour time (HH:MM), such as 14:00.` },
    ]);
  });

  it("refuses dates for the consecutive window without a spurious ordering error", () => {
    const r = validateRecurrence({ frequency: "consecutive", ...base, window_start: "2025-01-13", window_end: "2025-01-17", session_minutes: 180, gap_minutes: 30 });
    expect(r.errors.map((e) => e.message)).toEqual([
      "window_start must be a 24-hour time (HH:MM), such as 14:00.",
      "window_end must be a 24-hour time (HH:MM), such as 14:00.",
    ]);
  });
});
