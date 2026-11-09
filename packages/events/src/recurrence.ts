/**
 * High-level recurrence intent → Drupal recurring_events column shapes.
 * DRUPAL_CONTRACT mirrors the recurring_events FieldType/widget vocab; if Drupal
 * changes these, this block (and the drift test) must change with it. Sources:
 *   weekdays/full-lowercase: WeeklyRecurringDate widget getDayOptions()
 *   weekPositions: MonthlyRecurringDateWidget day_occurrence options
 *   months/"Mar": YearlyRecurringDateWidget month options (PHP `M` format)
 *   monthlyModes: MonthlyRecurringDate `type` discriminator
 */
export type Frequency = "daily" | "weekly" | "monthly" | "yearly" | "consecutive";

export interface RecurrenceIntent {
  frequency: Frequency;
  start_date: string;   // YYYY-MM-DD
  end_date: string;     // YYYY-MM-DD
  start_time?: string;  // HH:MM 24h (daily/weekly/monthly/yearly)
  duration_minutes?: number;
  ends_at?: string;     // HH:MM 24h — alternative to duration_minutes
  days?: string[];      // ["mon","wed"]
  monthly_mode?: "weekday" | "monthday";
  week_positions?: string[];
  days_of_month?: number[];
  year_interval?: number;
  months?: string[];    // ["mar","apr"]
  window_start?: string;  // HH:MM 24h (consecutive)
  window_end?: string;
  session_minutes?: number;
  gap_minutes?: number;
}

export const DRUPAL_CONTRACT = {
  weekdays: {
    mon: "monday", tue: "tuesday", wed: "wednesday", thu: "thursday",
    fri: "friday", sat: "saturday", sun: "sunday",
  } as Record<string, string>,
  weekPositions: ["first", "second", "third", "fourth", "last"],
  months: {
    jan: "Jan", feb: "Feb", mar: "Mar", apr: "Apr", may: "May", jun: "Jun",
    jul: "Jul", aug: "Aug", sep: "Sep", oct: "Oct", nov: "Nov", dec: "Dec",
  } as Record<string, string>,
  monthlyModes: ["weekday", "monthday"],
};

/** 24-hour "HH:MM" → Drupal's 12-hour uppercase "hh:MM AM/PM" (leading zero). */
export function fmt12(hhmm: string): string {
  const [h, m] = hhmm.split(":").map((n) => parseInt(n, 10));
  const period = h < 12 ? "AM" : "PM";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${String(h12).padStart(2, "0")}:${String(m).padStart(2, "0")} ${period}`;
}

/**
 * Worked examples shown to the model in the create_event recurrence
 * description. Typed as RecurrenceIntent so a wrong key fails to compile, and
 * tested to pass validateRecurrence, so the examples can't drift from the
 * schema the way hand-written prose did.
 */
export const RECURRENCE_EXAMPLES: ReadonlyArray<{ label: string; intent: RecurrenceIntent }> = [
  { label: "daily", intent: { frequency: "daily", start_date: "2025-01-01", end_date: "2025-02-28", start_time: "10:00", duration_minutes: 90 } },
  { label: "weekly", intent: { frequency: "weekly", start_date: "2025-01-06", end_date: "2025-03-31", days: ["mon", "wed"], start_time: "14:00", duration_minutes: 60 } },
  { label: "monthly, first Monday", intent: { frequency: "monthly", monthly_mode: "weekday", start_date: "2025-01-06", end_date: "2025-06-30", days: ["mon"], week_positions: ["first"], start_time: "15:00", ends_at: "16:30" } },
  { label: "monthly, the 15th", intent: { frequency: "monthly", monthly_mode: "monthday", start_date: "2025-01-15", end_date: "2025-12-31", days_of_month: [15], start_time: "10:00", duration_minutes: 120 } },
  { label: "yearly", intent: { frequency: "yearly", monthly_mode: "monthday", start_date: "2025-06-21", end_date: "2027-06-21", months: ["jun"], days_of_month: [21], year_interval: 1, start_time: "12:00", ends_at: "13:00" } },
  { label: "consecutive sessions each day", intent: { frequency: "consecutive", start_date: "2025-01-13", end_date: "2025-01-17", window_start: "09:00", window_end: "17:00", session_minutes: 180, gap_minutes: 30 } },
];

export interface RecurrenceError {
  code: "validation_error" | "over_fill" | "out_of_vocab";
  message: string;
}

const FREQUENCIES: Frequency[] = ["daily", "weekly", "monthly", "yearly", "consecutive"];
const DAILY_FAMILY = new Set<Frequency>(["daily", "weekly", "monthly", "yearly"]);
// start_date/end_date must be a bare calendar date with zero-padded month/day.
// Zero-padding IS enforced (2026-1-1 is rejected) — every caller/example sends
// YYYY-MM-DD, so this is intended, not a regression. Shape only: 2026-13-45
// passes here and is left for Drupal's calendar validation. The point is to
// reject datetime/timezone-suffixed strings (the mistake that caused PR #61).
const BARE_DATE = /^\d{4}-\d{2}-\d{2}$/;
// Zero-padded so the lexical ordering checks below are chronological, and so a
// date or other non-time never reaches fmt12, which would render it as NaN.
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const TIME_FIELDS = ["start_time", "ends_at", "window_start", "window_end"] as const;

export function validateRecurrence(intent: RecurrenceIntent): { ok: boolean; errors: RecurrenceError[] } {
  const errors: RecurrenceError[] = [];
  const err = (code: RecurrenceError["code"], message: string) => errors.push({ code, message });

  if (!FREQUENCIES.includes(intent.frequency)) {
    err("validation_error", `Unknown frequency "${intent.frequency}". Use one of: ${FREQUENCIES.join(", ")}.`);
    return { ok: false, errors }; // nothing else is checkable without a valid frequency
  }
  const f = intent.frequency;

  // Always required.
  if (!intent.start_date) err("validation_error", "start_date is required.");
  if (!intent.end_date) err("validation_error", "end_date is required.");
  // Format: a present date must be a bare YYYY-MM-DD (no time, no timezone).
  const badStart = !!intent.start_date && !BARE_DATE.test(intent.start_date);
  const badEnd = !!intent.end_date && !BARE_DATE.test(intent.end_date);
  if (badStart) err("validation_error", "start_date must be a bare calendar date (YYYY-MM-DD), no time or timezone.");
  if (badEnd) err("validation_error", "end_date must be a bare calendar date (YYYY-MM-DD), no time or timezone.");
  // Ordering: only compare when both are present AND bare — a lexical compare on
  // bare YYYY-MM-DD equals chronological. Gating on !badStart/!badEnd avoids a
  // spurious "end before start" when a value is malformed (which the accumulate-
  // all-errors flow would otherwise still push).
  if (intent.start_date && intent.end_date && !badStart && !badEnd
      && intent.end_date < intent.start_date) {
    err("out_of_vocab", "end_date is before start_date.");
  }
  const badTime = new Set<string>();
  for (const k of TIME_FIELDS) {
    const v = intent[k];
    if (v != null && !HHMM.test(v)) {
      badTime.add(k);
      err("validation_error", `${k} must be a 24-hour time (HH:MM), such as 14:00.`);
    }
  }

  // Daily-family time + length.
  if (DAILY_FAMILY.has(f)) {
    if (!intent.start_time) err("validation_error", "start_time is required for this frequency.");
    const hasDur = intent.duration_minutes != null;
    const hasEnds = intent.ends_at != null;
    if (!hasDur && !hasEnds) err("validation_error", "Provide exactly one of duration_minutes or ends_at.");
    if (hasDur && hasEnds) err("over_fill", "Provide only one of duration_minutes or ends_at, not both.");
    if (hasDur && intent.duration_minutes! < 0) err("out_of_vocab", "duration_minutes must be non-negative.");
    if (intent.start_time && intent.ends_at && !badTime.has("start_time") && !badTime.has("ends_at")
        && intent.ends_at <= intent.start_time) {
      err("out_of_vocab", "ends_at must be after start_time.");
    }
  }

  // days vocab (weekly, weekday-mode).
  const checkDays = () => {
    for (const d of intent.days ?? []) {
      if (!DRUPAL_CONTRACT.weekdays[d]) err("out_of_vocab", `Unknown weekday "${d}". Use short lowercase: mon,tue,…,sun.`);
    }
  };

  if (f === "weekly") {
    if (!intent.days?.length) err("validation_error", "days is required for weekly.");
    checkDays();
  }

  if (f === "monthly" || f === "yearly") {
    if (!intent.monthly_mode) err("validation_error", "monthly_mode ('weekday' or 'monthday') is required.");
    if (intent.monthly_mode && !DRUPAL_CONTRACT.monthlyModes.includes(intent.monthly_mode)) {
      err("out_of_vocab", `monthly_mode must be 'weekday' or 'monthday'.`);
    }
    if (intent.monthly_mode === "weekday") {
      if (!intent.week_positions?.length) err("validation_error", "week_positions is required for weekday mode.");
      if (!intent.days?.length) err("validation_error", "days is required for weekday mode.");
      for (const p of intent.week_positions ?? []) {
        if (!DRUPAL_CONTRACT.weekPositions.includes(p)) err("out_of_vocab", `Unknown week_position "${p}". Use: ${DRUPAL_CONTRACT.weekPositions.join(",")}.`);
      }
      checkDays();
      if (intent.days_of_month != null) err("over_fill", "days_of_month is not applicable in weekday mode.");
    }
    if (intent.monthly_mode === "monthday") {
      if (!intent.days_of_month?.length) err("validation_error", "days_of_month is required for monthday mode.");
      for (const d of intent.days_of_month ?? []) {
        if (d !== -1 && (d < 1 || d > 31)) err("out_of_vocab", `day_of_month ${d} out of range (1..31 or -1 for last day).`);
      }
      if (intent.week_positions != null) err("over_fill", "week_positions is not applicable in monthday mode.");
      if (intent.days != null) err("over_fill", "days is not applicable in monthday mode.");
    }
  }

  if (f === "yearly") {
    if (intent.year_interval == null) err("validation_error", "year_interval is required for yearly.");
    if (intent.year_interval != null && intent.year_interval < 1) err("out_of_vocab", "year_interval must be >= 1.");
    if (!intent.months?.length) err("validation_error", "months is required for yearly.");
    for (const mo of intent.months ?? []) {
      if (!DRUPAL_CONTRACT.months[mo]) err("out_of_vocab", `Unknown month "${mo}". Use short lowercase: jan,feb,…,dec.`);
    }
  } else {
    if (intent.months != null) err("over_fill", "months is only applicable to yearly.");
    if (intent.year_interval != null) err("over_fill", "year_interval is only applicable to yearly.");
  }

  if (f === "consecutive") {
    for (const [k, v] of [["window_start", intent.window_start], ["window_end", intent.window_end], ["session_minutes", intent.session_minutes], ["gap_minutes", intent.gap_minutes]] as const) {
      if (v == null) err("validation_error", `${k} is required for consecutive.`);
    }
    if (intent.window_start && intent.window_end && !badTime.has("window_start") && !badTime.has("window_end")
        && intent.window_end <= intent.window_start) {
      err("out_of_vocab", "window_end must be after window_start.");
    }
  } else {
    for (const [k, v] of [["window_start", intent.window_start], ["window_end", intent.window_end], ["session_minutes", intent.session_minutes], ["gap_minutes", intent.gap_minutes]] as const) {
      if (v != null) err("over_fill", `${k} is only applicable to consecutive.`);
    }
  }

  // days is not applicable to daily or to monthday/monthly-non-weekday — reject stray days.
  if ((f === "daily") && intent.days != null) err("over_fill", "days is not applicable to daily.");

  return { ok: errors.length === 0, errors };
}

const expandDays = (days: string[] = []) => days.map((d) => DRUPAL_CONTRACT.weekdays[d]).join(",");
const mapMonths = (months: string[] = []) => months.map((m) => DRUPAL_CONTRACT.months[m]).join(",");

/**
 * The rule-field date columns (value/end_value) are stored as Drupal `datetime`
 * fields (default storage format Y-m-d\TH:i:s), NOT date-only. A bare "Y-m-d"
 * fails DateTimeComputed's createFromFormat parse → NULL start_date → the
 * "recurrence needs a valid start and end date" refusal. Anchor the calendar
 * date at midnight so it parses; the actual time-of-day lives in the separate
 * `time` column, so the T00:00:00 here is only the date field's required format.
 */
const toRuleDate = (ymd: string): string => `${ymd}T00:00:00`;

/** Daily-family shared columns (value/end_value/time + duration-or-end_time branch). */
function dailyCore(intent: RecurrenceIntent): Record<string, unknown> {
  const core: Record<string, unknown> = {
    value: toRuleDate(intent.start_date),
    end_value: toRuleDate(intent.end_date),
    time: fmt12(intent.start_time!),
  };
  if (intent.duration_minutes != null) {
    core.duration_or_end_time = "duration";
    core.duration = intent.duration_minutes * 60;
    core.end_time = "";
  } else {
    core.duration_or_end_time = "end_time";
    core.end_time = fmt12(intent.ends_at!);
    core.duration = 0;
  }
  return core;
}

function monthlyColumns(intent: RecurrenceIntent): Record<string, unknown> {
  const cols = { ...dailyCore(intent), type: intent.monthly_mode! } as Record<string, unknown>;
  if (intent.monthly_mode === "weekday") {
    cols.day_occurrence = (intent.week_positions ?? []).join(",");
    cols.days = expandDays(intent.days);
    cols.day_of_month = "";
  } else {
    cols.day_of_month = (intent.days_of_month ?? []).join(",");
    cols.day_occurrence = "";
    cols.days = "";
  }
  return cols;
}

export function buildRuleField(intent: RecurrenceIntent): { recur_type: string; [k: string]: unknown } {
  switch (intent.frequency) {
    case "daily":
      return { recur_type: "daily_recurring_date", daily_recurring_date: dailyCore(intent) };
    case "weekly":
      return { recur_type: "weekly_recurring_date", weekly_recurring_date: { ...dailyCore(intent), days: expandDays(intent.days) } };
    case "monthly":
      return { recur_type: "monthly_recurring_date", monthly_recurring_date: monthlyColumns(intent) };
    case "yearly":
      return { recur_type: "yearly_recurring_date", yearly_recurring_date: { ...monthlyColumns(intent), year_interval: intent.year_interval, months: mapMonths(intent.months) } };
    case "consecutive":
      return {
        recur_type: "consecutive_recurring_date",
        consecutive_recurring_date: {
          value: toRuleDate(intent.start_date), end_value: toRuleDate(intent.end_date),
          time: fmt12(intent.window_start!), end_time: fmt12(intent.window_end!),
          duration: intent.session_minutes, duration_units: "minute",
          buffer: intent.gap_minutes, buffer_units: "minute",
        },
      };
  }
}
