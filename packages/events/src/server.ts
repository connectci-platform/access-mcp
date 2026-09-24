import {
  BaseAccessServer,
  handleApiError,
  projectFields,
  Tool,
  Resource,
  CallToolResult,
  DrupalAuthProvider,
  DrupalApiError,
  getRequestContext,
  coerceOffset,
  coerceLimit,
  type ToolWithAccess,
} from "@access-mcp/shared";
import {
  CallToolRequest,
  ReadResourceRequest,
  ReadResourceResult,
} from "@modelcontextprotocol/sdk/types.js";
import axios, { AxiosInstance } from "axios";
import { createRequire } from "module";
import { validateRecurrence, buildRuleField } from "./recurrence.js";
import type { RecurrenceIntent } from "./recurrence.js";
const require = createRequire(import.meta.url);
const { version } = require("../package.json");

interface SearchEventsParams {
  query?: string;
  type?: string;
  tags?: string;
  date?: string;
  date_range?: { start_date?: string; end_date?: string };
  skill?: string;
  has_video?: boolean;
  limit?: number;
  offset?: number;
  // When true, skip compactDescription's truncation so the agent gets the
  // full event description (e.g. needs the registration URL or wants to
  // summarize a workshop in detail). Default is the truncated form because
  // a full-corpus listing can otherwise blow past LLM context windows.
  full_description?: boolean;
  fields?: string[];
}

interface GetMyEventsParams {
  limit?: number;
  fields?: string[];
}

/** Content fields shared by create_event/update_event, whitelisted server-side by Drupal. */
interface EventContentFields {
  body?: string;
  field_summary?: string;
  field_location?: string;
  field_event_type?: string;
  field_skill_level?: string;
  field_tags?: string[];
  field_event_speakers?: string;
  field_event_virtual_meeting_link?: string;
  field_event_timezone?: string;
  field_event_in_person?: boolean;
}

interface CreateEventParams extends EventContentFields {
  title: string;
  recur_type?: string;
  recurrence?: RecurrenceIntent;
  field_affinity_group_node?: string[];
  custom_dates?: Array<{ start_date: string; end_date: string }>;
  confirmed?: boolean;
}

interface UpdateEventParams extends EventContentFields {
  eventseries_id: string;
  title?: string;
}

interface OccurrenceDate {
  value: string;
  end_value: string;
}

interface EditOccurrenceParams {
  eventinstance_id: string;
  confirmed?: boolean;
  date?: OccurrenceDate;
  field_location?: string;
}

interface AddOccurrenceParams {
  eventseries_id: string;
  date: OccurrenceDate;
}

interface RawEvent {
  title?: string;
  start_date?: string;
  end_date?: string;
  event_type?: string;
  skill_level?: string;
  tags?: string | string[];
  video?: string;
  description?: string;
  registration?: string;
  // The flat /api/2.4/events API serializes Drupal boolean fields as the
  // strings 'Yes'/'No' and numeric fields as strings ('0'/'11'), so these
  // arrive as strings in practice. Typed permissively and parsed at the map
  // (see parseDrupalBool / access_registration below) — do NOT treat the raw
  // value as a JS truthiness test, since Boolean('No') === true.
  registration_enabled?: string | boolean | number;
  registration_capacity?: string | number;
  registration_has_waitlist?: string | boolean | number;
  [key: string]: unknown;
}

const DESCRIPTION_MAX_CHARS = 250;

/**
 * Normalize a Drupal daterange value to an unambiguous ISO instant.
 *
 * Drupal serializes daterange fields as naive UTC strings with no zone
 * designator (e.g. "2026-07-23T20:00:00"). Appending "Z" marks them as UTC so
 * consumers don't interpret them in local time. Returns undefined for a missing
 * value, and leaves an already-zoned string untouched.
 */
export function isoInstant(value: string | undefined | null): string | undefined {
  if (!value) return undefined;
  return /[Z+-]\d{2}:?\d{2}$|Z$/.test(value) ? value : `${value}Z`;
}

/**
 * Canonicalize a daterange value to a UTC "…Z" instant, whatever zone form it
 * arrives in — so all read tools emit one uniform shape. Three cases:
 *  - already "…Z": returned unchanged.
 *  - offset-bearing ("…-05:00"): a correct instant, but a different string form;
 *    convert to the equivalent UTC "…Z" (e.g. 15:00:00-05:00 → 20:00:00Z).
 *  - naive (no zone): mark as UTC by appending "Z" (Drupal stores daterange in
 *    UTC), NOT via new Date(), which would parse a naive string as local time.
 * Returns undefined for a missing value; falls back to the raw value if a zoned
 * string somehow fails to parse (belt and suspenders — never throws).
 */
export function isoInstantUtc(value: string | undefined | null): string | undefined {
  if (!value) return undefined;
  const zoned = /[Z+-]\d{2}:?\d{2}$|Z$/.test(value);
  if (!zoned) return `${value}Z`; // naive → mark UTC (no local-time parse)
  if (/Z$/.test(value)) return value; // already canonical
  const ms = Date.parse(value); // offset-bearing → convert to UTC Z
  return Number.isNaN(ms) ? value : new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
}

/**
 * Drupal's preview body repeats status:"preview"/executed:false, which the write
 * envelope already carries at the top level. Strip them from the nested body so
 * each field appears once; keep every other preview field Drupal returns.
 */
function previewData(body: Record<string, unknown>): Record<string, unknown> {
  const rest = { ...body };
  delete rest.status;
  delete rest.executed;
  return rest;
}

export function compactDescription(
  raw: string | undefined,
  maxChars: number = DESCRIPTION_MAX_CHARS
): string | undefined {
  if (raw === undefined || raw === null) return raw;
  const stripped = raw
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
  if (stripped.length <= maxChars) return stripped;
  return stripped.slice(0, maxChars).trimEnd() + "…";
}

/**
 * Parse a Drupal boolean value that may arrive as a string. The flat
 * /api/2.4/events API renders boolean fields as the strings 'Yes'/'No'
 * (not JS booleans), so a naive `Boolean(value)` is wrong — Boolean('No')
 * is `true`. Treats 'yes'/'true'/'1'/true/1 as true; everything else
 * ('no'/'false'/'0'/''/false/0/null/undefined) as false. Mirrors the
 * jsm server's Yes/No convention.
 */
export function parseDrupalBool(value: unknown): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value === 1;
  const val = String(value ?? "").trim().toLowerCase();
  return val === "yes" || val === "true" || val === "1";
}

export class EventsServer extends BaseAccessServer {
  private _eventsHttpClient?: AxiosInstance;
  private drupalAuth?: DrupalAuthProvider;

  constructor() {
    super("access-mcp-events", version, "https://support.access-ci.org", {
      requireApiKey: true,
    });
  }

  protected listingLinks(
    context: "list" | "search" | "details" = "list"
  ): Record<string, string> | undefined {
    if (context === "list" || context === "search") {
      return { see_all_url: "https://support.access-ci.org/events" };
    }
    return undefined;
  }

  /**
   * Get or create the Drupal auth provider for authenticated operations.
   * Requires DRUPAL_API_URL, DRUPAL_USERNAME, and DRUPAL_PASSWORD env vars.
   */
  private getDrupalAuth(): DrupalAuthProvider {
    if (!this.drupalAuth) {
      const baseUrl = process.env.DRUPAL_API_URL;
      const username = process.env.DRUPAL_USERNAME;
      const password = process.env.DRUPAL_PASSWORD;

      if (!baseUrl || !username || !password) {
        throw new Error(
          "Authenticated operations require DRUPAL_API_URL, DRUPAL_USERNAME, and DRUPAL_PASSWORD environment variables"
        );
      }

      this.drupalAuth = new DrupalAuthProvider(baseUrl, username, password);
    }

    return this.drupalAuth;
  }

  /**
   * Get the acting user's ACCESS ID for filtering.
   */
  private getActingUserAccessId(): string {
    const context = getRequestContext();
    if (context?.actingUser) {
      return context.actingUser;
    }

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

  protected get httpClient(): AxiosInstance {
    if (!this._eventsHttpClient) {
      const headers: Record<string, string> = {
        "User-Agent": `${this.serverName}/${this.version}`,
      };

      // Add authentication if API key is provided
      const apiKey = process.env.ACCESS_CI_API_KEY;
      if (apiKey) {
        headers["Authorization"] = `Bearer ${apiKey}`;
      }

      this._eventsHttpClient = axios.create({
        baseURL: this.baseURL,
        timeout: 10000, // 10 seconds for events API (can be slower)
        headers,
        validateStatus: () => true, // Don't throw on HTTP errors
      });
    }
    return this._eventsHttpClient;
  }

  protected getTools(): Tool[] {
    const tools: ToolWithAccess[] = [
      {
        name: "search_events",
        description:
          "Search ACCESS-CI events (workshops, webinars, training). Returns future events by default. Use date='past' or an absolute date_range for historical events. Returns {total, items}. Each event may carry `access_registration` (native ACCESS registration — when enabled, the user can register through ACCESS itself; manage it with get_event for live availability, register_for_event to sign up, get_my_registrations to list, and cancel_registration to cancel) and/or `registration_url` (an external link to register on the resource provider's own site — ACCESS does not manage these; direct the user to the URL). access_registration.enabled true means act via the ACCESS tools; registration_url means go offsite.",
        inputSchema: {
          type: "object",
          properties: {
            query: {
              type: "string",
              description: "Search titles, descriptions, speakers, tags",
            },
            type: {
              type: "string",
              description:
                "Filter by event type. The type facet indexes the option LABELS, so current events carry \"Conference\", \"Training\", \"Office Hours\", or \"Other\" (never the internal zz_other key). Events created before the option list existed may carry legacy raw values (training, webinar, workshop).",
            },
            tags: {
              type: "string",
              description:
                "Filter by tag name. Examples: python, gpu, hpc, ml, open-ondemand, NAIRR-pilot, mpi, quantum-computing, data-analysis, visualization. Tags are case-sensitive as entered by event organizers.",
            },
            date: {
              type: "string",
              description:
                "Quick date filter. Use 'past' for historical events. Defaults to 'upcoming' if omitted.",
              enum: ["today", "upcoming", "past", "this_week", "this_month"],
              default: "upcoming",
            },
            date_range: {
              type: "object",
              description:
                "Filter to events within an absolute date window (ISO-8601, YYYY-MM-DD). Use this when the user gives explicit dates (e.g. 'events in March 2026'). For relative windows ('this week', 'upcoming', 'past'), use the `date` parameter instead. When set, overrides `date`.",
              properties: {
                start_date: { type: "string", description: "Start date (YYYY-MM-DD)." },
                end_date: { type: "string", description: "End date (YYYY-MM-DD)." },
              },
            },
            skill: {
              type: "string",
              description: "Skill level filter",
              enum: ["beginner", "intermediate", "advanced"],
            },
            has_video: {
              type: "boolean",
              description:
                "Filter to events with recorded video available. Implies past events (video is only available for past events).",
            },
            limit: {
              type: "number",
              description: "Max results (default: 50)",
              default: 50,
            },
            offset: {
              type: "number",
              description:
                "Number of results to skip, for paging past the first `limit`. Default 0. Results beyond roughly the first 500 records are unreachable — paging past that ceiling returns a `capped` response with `total_lower_bound` instead of more records.",
            },
            full_description: {
              type: "boolean",
              description:
                "When true, return the full event description (with HTML) instead of the default 250-char plain-text compact form. Use when you need the registration URL embedded in the description, or want to summarize a workshop in detail. Pair with a small limit to stay within context.",
              default: false,
            },
            fields: {
              type: "array",
              items: { type: "string" },
              description:
                "Project the response down to only these fields. Dotted path syntax: 'total', 'items[].title', 'items[].start_date', 'metadata.pagination.has_more', etc. Use to reduce payload size when you only need specific fields. Omit to receive the full response.",
            },
          },
        },
        _meta: {
          supportsFieldProjection: true,
        },
        access: "public",
      },
      {
        name: "get_my_events",
        description: `Events the acting user CREATED or organized — NOT events they are attending. For events the user has registered to attend, use get_my_registrations instead.

Returns events the user has created or is associated with, including unpublished/draft events.
Requires authentication via X-Acting-User header or ACTING_USER environment variable.

Returns: {total, items: [{id, type, title, start_date, end_date, status}]} where status is the editorial moderation state (draft / ready_for_review / published).`,
        inputSchema: {
          type: "object",
          properties: {
            limit: {
              type: "number",
              description: "Max results (default: 50)",
              default: 50,
            },
            fields: {
              type: "array",
              items: { type: "string" },
              description:
                "Project the response down to only these fields. Dotted path syntax: 'total', 'items[].title', 'items[].status', 'metadata.pagination.has_more', etc. Use to reduce payload size when you only need specific fields. Omit to receive the full response.",
            },
          },
        },
        _meta: {
          supportsFieldProjection: true,
        },
        access: "authenticated",
      },
      {
        name: "get_my_registrations",
        description:
          "List the events the authenticated user has registered to attend (distinct from get_my_events, which lists events they CREATED). Returns one entry per registration: registrant_id (the handle for cancel_registration), eventinstance_id, event_title, start/end dates, location, virtual_meeting_link, event_type, waitlist status, and cancelled. cancelled:true means an organizer cancelled that occurrence (the event was archived) — the registration itself is KEPT (not removed) and the user was notified. If the organizer restores a cancelled event, its registrations reactivate (cancelled reverts to false); an occurrence the organizer cancelled individually stays cancelled until an editor restores it. Defaults to upcoming registrations; pass when=past or when=all to see past/all. Scoped to the authenticated acting user. Read-only.",
        inputSchema: {
          type: "object" as const,
          properties: {
            when: {
              type: "string",
              enum: ["upcoming", "past", "all"],
              description: "Which registrations to return (default: upcoming).",
            },
          },
          required: [],
        },
        access: "authenticated",
      },
      {
        name: "get_event",
        description:
          "Fetch one ACCESS event's full detail and LIVE registration state (seats_remaining, registration_open, and whether the acting user is already_registered). Use before register_for_event to show the user current availability. Read the top-level registration_path to decide how to register: \"native\" means native ACCESS registration is on — use register_for_event (any external offsite link is surfaced as external_registration_url, a labeled alternative); \"external\" means native registration is off but an offsite registration_url exists — direct the user there, register_for_event does NOT apply; \"none\" means no registration is available. Before reporting seat availability, read registration.capacity_type: \"limited\" means seats_remaining is a real count, \"unlimited\" means there is no cap — do not report a seat count.",
        inputSchema: {
          type: "object" as const,
          properties: {
            eventinstance_id: {
              type: "string",
              description: "The eventinstance id (from search_events `id`).",
            },
          },
          required: ["eventinstance_id"],
        },
        access: "public",
      },
      {
        name: "register_for_event",
        description:
          "Register the acting user for an ACCESS event via native ACCESS registration. WITHOUT `confirmed` (or confirmed:false) this returns a PREVIEW of what would happen (seat vs. waitlist) and writes NOTHING. WITH confirmed:true it registers. Returns the write-envelope shape {action:\"register\", status, executed, data}: read `status` (preview | registered | waitlisted | already_registered) and `executed` (true only when a write actually happened). status:\"preview\" means executed:false — nothing was written; call again with confirmed:true to commit. status:\"registered\"/\"waitlisted\" carries data.registrant_id. status:\"already_registered\" (executed:false) means the acting user already holds a seat — no change. Refusals (event_full, registration_closed, not_registrable, not_permitted) come back as errors with a machine-readable `code`. Pair with get_event (live availability before registering), get_my_registrations (list the acting user's registrations), and cancel_registration (cancel one, takes the registrant_id).",
        inputSchema: {
          type: "object" as const,
          properties: {
            eventinstance_id: {
              type: "string",
              description: "The eventinstance id (from search_events/get_event `id`).",
            },
            confirmed: {
              type: "boolean",
              description:
                "Omit or false for a no-write preview (status:\"preview\", executed:false — seat vs. waitlist); true to actually register (status:\"registered\"/\"waitlisted\", executed:true).",
            },
          },
          required: ["eventinstance_id"],
        },
        access: "authenticated",
        mutates: true,
      },
      {
        name: "cancel_registration",
        description:
          "Permanently cancel one of the authenticated user's OWN event registrations (this is the attendee withdrawing, distinct from an organizer cancelling the whole event or occurrence — see the cancelled field on get_my_registrations for that case). Pass registrant_id, obtained from get_my_registrations. This cannot cancel other users' registrations — it is scoped to the authenticated acting user. WITHOUT confirmed:true (confirmed:false or omitted) this returns a PREVIEW of what would be cancelled (the registration's event title and start date) and writes NOTHING — show it to the user for confirmation. WITH confirmed:true it permanently cancels the registration. Returns the write-envelope shape {action:\"cancel\", status, executed, data}: read `status` (preview | cancelled) and `executed` (true only when a cancel actually happened). status:\"preview\" means executed:false — nothing was cancelled; call again with confirmed:true to commit. An unknown registrant_id (or one that is not yours) comes back as an error with code:\"not_found\".",
        inputSchema: {
          type: "object" as const,
          properties: {
            registrant_id: {
              type: "string",
              description: "The registration id from get_my_registrations.",
            },
            confirmed: {
              type: "boolean",
              description:
                "Set to true only after the user has explicitly confirmed cancellation of THIS specific registration. Required.",
            },
          },
          required: ["registrant_id", "confirmed"],
        },
        access: "authenticated",
        mutates: true,
      },
      {
        name: "create_event",
        description:
          "Create a new event series as a DRAFT (organizer write; acting-user-gated). There is no self-publish path — every created series starts moderation_state:\"draft\" regardless of what you pass. The response's moderation block tells you what to do next: moderation.can_publish (whether the acting user may publish directly) and moderation.next_action (\"send_for_review\" when they cannot — call send_for_review to route it to an editor). Requires title, field_event_type, and field_location — the last two are required by the site's field validation (the same rule the browser form enforces), and creation is refused with code \"validation_error\" naming the field if they are missing or invalid. You must ALSO specify the schedule, exactly one of two ways: for a repeating event pass a recurrence object; for one-off or irregular dates pass recur_type:\"custom\" with custom_dates. The recurrence object describes the pattern with frequency (\"daily\", \"weekly\", \"monthly\", \"yearly\", \"consecutive\"), start_date, end_date, start_time, and either duration_minutes OR ends_at for daily/weekly/monthly/yearly. For monthly, use weekday mode (days + week_positions, e.g. [\"mon\"] + [\"first\"] for first Monday; use monthday mode (days_of_month, e.g. [15] or [-1] for last day) for 'the 15th' or 'last day' patterns. Yearly uses months + days/days_of_month. Consecutive uses window_start/window_end + session_minutes + gap_minutes. Invalid recurrence fields are refused with a coded error (validation_error/over_fill/out_of_vocab) naming the problem field before anything is written. Affinity group is optional: supply field_affinity_group_node only to publish the event to one or more groups the acting user coordinates (creation is refused with code \"not_coordinator\" if they do not coordinate ALL supplied groups); omit it to create an event not published to any group. For recur_type:\"custom\", pass custom_dates as [{start_date, end_date}, …]. Optional content fields: body, field_summary, field_skill_level, field_tags, field_event_speakers, field_event_virtual_meeting_link, field_event_in_person (physical venue vs online). Optional field_event_timezone (IANA name): set only when the user names a timezone different from their own — otherwise omit it and the event uses the acting user's account timezone. WITHOUT confirmed:true this returns a no-write PREVIEW (status:\"preview\", executed:false, with occurrence_count, total_occurrence_count, truncated, and occurrences — truncated is true only when a 1000-occurrence hard cap clipped the set, in which case total_occurrence_count is the real total while occurrence_count/occurrences hold the shown first 1000; report total_occurrence_count to the user) of the occurrence dates the recurrence would produce — show it to the user first. WITH confirmed:true it creates the series. Returns on commit: {series_id, instance_ids, title, moderation_state, moderation}; if a recurrence pattern produces zero occurrences the response also carries recurrence_warning.",
        inputSchema: {
          type: "object" as const,
          properties: {
            title: { type: "string", description: "Event title. Required." },
            recur_type: {
              type: "string",
              enum: ["custom"],
              description:
                "Set to \"custom\" for one-off or irregular dates, supplied via custom_dates. For a repeating event, use the recurrence object instead (it builds the rule internally).",
            },
            recurrence: {
              type: "object",
              description:
                "A high-level recurrence pattern for a REPEATING event, translated to the native Drupal rule-field columns server-side. Use this for any repeating pattern. Mutually exclusive with recur_type and with custom_dates (supplying more than one is refused with validation_error). Examples: daily (freq:daily, start_date:2025-01-01, end_date:2025-02-28, start_time:10:00, duration_minutes:90); weekly (freq:weekly, start_date:2025-01-06, end_date:2025-03-31, days:[mon,wed], start_time:14:00, duration_minutes:60); monthly weekday (freq:monthly, monthly_mode:weekday, start_date:2025-01-06, end_date:2025-06-30, days:[mon], week_positions:[first], start_time:15:00, ends_at:16:30); monthly monthday (freq:monthly, monthly_mode:monthday, start_date:2025-01-15, end_date:2025-12-31, days_of_month:[15], start_time:10:00, duration_minutes:120); yearly (freq:yearly, start_date:2025-06-21, end_date:2027-06-21, monthly_mode:monthday, months:[jun], days_of_month:[21], year_interval:1, start_time:12:00, ends_at:13:00); consecutive (freq:consecutive, start_date:2025-01-13, end_date:2025-01-17, window_start:2025-01-13, window_end:2025-01-17, session_minutes:180, gap_minutes:30). Invalid combinations are refused with code validation_error, over_fill, or out_of_vocab naming the problem field.",
              properties: {
                frequency: {
                  type: "string",
                  enum: ["daily", "weekly", "monthly", "yearly", "consecutive"],
                  description: "Recurrence frequency type.",
                },
                start_date: { type: "string", description: "Start date (YYYY-MM-DD). Required." },
                end_date: { type: "string", description: "End date (YYYY-MM-DD). Required; recurring events cannot create an open-ended series." },
                start_time: {
                  type: "string",
                  description: "Start time (24h HH:MM), interpreted in the acting user's profile timezone. Required for daily/weekly/monthly/yearly.",
                },
                duration_minutes: {
                  type: "number",
                  description:
                    "Event duration in minutes. Pick one: duration_minutes OR ends_at (not both). For daily/weekly/monthly/yearly.",
                },
                ends_at: {
                  type: "string",
                  description:
                    "End time (24h HH:MM), interpreted in the acting user's profile timezone. Pick one: duration_minutes OR ends_at (not both). For daily/weekly/monthly/yearly.",
                },
                days: {
                  type: "array",
                  items: { type: "string" },
                  description:
                    "Day abbreviations ([\"mon\",\"tue\",\"wed\",\"thu\",\"fri\",\"sat\",\"sun\"]). Required for weekly and weekday-mode monthly.",
                },
                monthly_mode: {
                  type: "string",
                  enum: ["weekday", "monthday"],
                  description:
                    "Monthly recurrence mode. Use weekday for patterns like 'first Monday' or 'last Friday' (pair with days + week_positions). Use monthday for 'the 15th' or 'the last day' (pair with days_of_month, where -1 = last day).",
                },
                week_positions: {
                  type: "array",
                  items: { type: "string" },
                  description:
                    "Week positions for weekday-mode monthly ([\"first\",\"second\",\"third\",\"fourth\",\"last\"]). Required for weekday-mode monthly.",
                },
                days_of_month: {
                  type: "array",
                  items: { type: "number" },
                  description:
                    "Day numbers (1-31) or -1 for last day. Required for monthday mode (monthly or yearly).",
                },
                year_interval: { type: "number", description: "Years between recurrences. Required for yearly." },
                months: {
                  type: "array",
                  items: { type: "string" },
                  description:
                    "Short lowercase month abbreviations ([\"jan\",\"feb\",\"mar\",…,\"dec\"]). Required for yearly.",
                },
                window_start: {
                  type: "string",
                  description: "Window start date (YYYY-MM-DD). Required for consecutive.",
                },
                window_end: {
                  type: "string",
                  description: "Window end date (YYYY-MM-DD). Required for consecutive.",
                },
                session_minutes: {
                  type: "number",
                  description: "Duration of each session in minutes (consecutive only).",
                },
                gap_minutes: {
                  type: "number",
                  description: "Minutes between consecutive sessions (consecutive only).",
                },
              },
            },
            field_affinity_group_node: {
              type: "array",
              items: { type: "string" },
              description:
                "Optional. Affinity-group node UUID(s) to publish this event to. Supply only if you want the event published to those groups; the acting user must coordinate ALL supplied groups or creation is refused (code: not_coordinator). An unresolvable UUID is also refused. Omit to create an event not published to any group.",
            },
            custom_dates: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  start_date: { type: "string" },
                  end_date: { type: "string" },
                },
              },
              description: "One-off occurrence dates. Required when recur_type is \"custom\".",
            },
            body: { type: "string", description: "Event description (HTML/basic_html allowed)." },
            field_summary: { type: "string" },
            field_location: {
              type: "string",
              description: "Event location. Required by site validation.",
            },
            // The enumerated allowed values here and in update_event mirror the
            // portal repo's field.storage.eventseries.field_event_type.yml /
            // field_skill_level.yml (required flags: field.field.eventseries.
            // default.*.yml). A site-config change there must update these
            // descriptions in the same release.
            field_event_type: {
              type: "string",
              description:
                "Event type. Required by site validation; allowed values: \"Conference\", \"Training\", \"Office Hours\", \"Other\" (case-insensitive; the API stores canonical keys, so the legacy internal key zz_other is also still accepted for Other). Any other value is refused (code: validation_error).",
            },
            field_skill_level: {
              type: "string",
              description:
                "Optional. Allowed values: \"Beginner\", \"Intermediate\", \"Advanced\" (case-insensitive); any other value is refused (code: validation_error).",
            },
            field_tags: { type: "array", items: { type: "string" } },
            field_event_speakers: { type: "string" },
            field_event_virtual_meeting_link: { type: "string" },
            field_event_timezone: {
              type: "string",
              description:
                "IANA timezone name (e.g. America/Los_Angeles) for the event's local time. Set this ONLY when the user names a timezone different from their own; otherwise omit it and the event uses the acting user's account timezone. An invalid name is refused with validation_error.",
            },
            field_event_in_person: {
              type: "boolean",
              description:
                "True if the event happens at a physical venue, false if it is online/virtual. For an in-person event with a timezone, times display in the venue's timezone for all viewers; an online event displays in each viewer's local timezone.",
            },
            confirmed: {
              type: "boolean",
              description:
                "Omit or false for a no-write PREVIEW of the occurrence dates this recurrence would produce (status:\"preview\", executed:false, with occurrence_count/total_occurrence_count/truncated/occurrences); true to actually create the series.",
            },
          },
          required: ["title", "field_event_type", "field_location"],
        },
        access: "authenticated",
        mutates: true,
      },
      {
        name: "update_event",
        description:
          "Edit an existing event series' CONTENT fields ONLY (title, body, field_summary, field_location, field_event_type, field_skill_level, field_tags, field_event_speakers, field_event_virtual_meeting_link, field_event_timezone, field_event_in_person). This tool NEVER changes dates/recurrence and NEVER changes moderation_state (note: changing field_event_timezone reschedules the event's displayed times, but does not alter the stored recurrence) — it applies immediately, with no preview step and no confirm flag. The API deliberately has NO whole-schedule rebuild operation: schedule changes are per-occurrence only — use edit_occurrence to move one occurrence's date, or add_occurrence/cancel_occurrence to add or remove a date. A series' recurrence pattern itself can never be rebuilt on any surface once it has registrations; the reschedule path there is cancel_occurrence → edit_occurrence (while dark) → restore_occurrence. For a state change (cancel, restore, send for review), use delete_event / restore_event / send_for_review. Edits are validated against the site's field rules (required fields, allowed values, link format); a violation is refused with code \"validation_error\" and a message naming the field — fix that field (or supply it, if the series was created without it) and retry. Returns {series_id, updated_fields}.",
        inputSchema: {
          type: "object" as const,
          properties: {
            eventseries_id: {
              type: "string",
              description: "The event series id (the get_event `series_id`, or the eventinstance id — either resolves to its series).",
            },
            title: { type: "string" },
            body: { type: "string" },
            field_summary: { type: "string" },
            field_location: { type: "string" },
            field_event_type: {
              type: "string",
              description:
                "Allowed values: \"Conference\", \"Training\", \"Office Hours\", \"Other\" (case-insensitive; legacy key zz_other also accepted). Any other value is refused (code: validation_error). Also the field to supply when repairing a draft created without it.",
            },
            field_skill_level: {
              type: "string",
              description:
                "Allowed values: \"Beginner\", \"Intermediate\", \"Advanced\" (case-insensitive); any other value is refused (code: validation_error).",
            },
            field_tags: { type: "array", items: { type: "string" } },
            field_event_speakers: { type: "string" },
            field_event_virtual_meeting_link: { type: "string" },
            field_event_timezone: {
              type: "string",
              description:
                "IANA timezone name (e.g. America/Los_Angeles) for the event's local time. An invalid name is refused with validation_error. Note: changing an event's timezone reschedules it.",
            },
            field_event_in_person: {
              type: "boolean",
              description:
                "True if the event happens at a physical venue, false if online/virtual. Controls whether times display in the venue's timezone (in-person) or each viewer's local timezone (online).",
            },
          },
          required: ["eventseries_id"],
        },
        access: "authenticated",
        mutates: true,
      },
      {
        name: "delete_event",
        description:
          "Cancel (archive) an event series — organizer write, acting-user-gated. A series that was ever published is ARCHIVED (its instances archive too; registrations are always KEPT and future registrants are notified). A series that was NEVER published is instead hard-deleted, UNLESS it carries any registrations (past or future — attendance history is protected), in which case it is refused with code \"registrations_exist\": those cannot be silently destroyed. WITHOUT confirmed:true this returns a no-write PREVIEW (status:\"preview\", executed:false) describing would_archive/would_hard_delete and registrants_affected — show it to the user first. WITH confirmed:true it executes. Returns on commit: {series_id, instances_archived, registrants_affected, notified, notifications_disabled, hard_deleted}. To reschedule instead of cancelling, prefer edit_occurrence (single date) or cancel_occurrence + restore_occurrence for partial changes — reserve delete_event for actually cancelling the whole series. To undo, use restore_event.",
        inputSchema: {
          type: "object" as const,
          properties: {
            eventseries_id: {
              type: "string",
              description: "The event series id (get_event `series_id`, or an eventinstance id — either resolves to its series).",
            },
            confirmed: {
              type: "boolean",
              description: "Omit or false for a no-write preview; true to execute the cancel/delete.",
            },
          },
          required: ["eventseries_id"],
        },
        access: "authenticated",
        mutates: true,
      },
      {
        name: "restore_event",
        description:
          "Un-cancel a previously archived event series — the inverse of delete_event. Only legal from an archived series; an already-published series is an idempotent no-op (instances_restored:0), and a series that was never archived (draft, needs_adjustment, …) is refused with code \"invalid_state\". IMPORTANT ordering: if you also need to move the series' dates, apply date edits (edit_occurrence per-occurrence) WHILE the series is still dark/archived, THEN restore — restoring first and editing dates after means registrants get notified of the stale date before the real one. On restore, every archived instance that was NOT individually cancelled (see cancel_occurrence) comes back published and its registrants are notified; an instance you individually cancelled while the series was dark stays cancelled through the restore (this is how a PARTIAL restore works: cancel_occurrence the instances you don't want back before calling restore_event, then only the rest return). No preview step. Returns {series_id, instances_restored, notified, notifications_disabled}.",
        inputSchema: {
          type: "object" as const,
          properties: {
            eventseries_id: {
              type: "string",
              description: "The event series id (get_event `series_id`, or an eventinstance id — either resolves to its series).",
            },
          },
          required: ["eventseries_id"],
        },
        access: "authenticated",
        mutates: true,
      },
      {
        name: "send_for_review",
        description:
          "Route a draft (or needs_adjustment) event series to an editor for approval — the author-facing path to publication when the acting user cannot publish directly (see create_event's moderation.next_action). Legal only from draft or needs_adjustment; any other current state (published, archived, ready_for_review already) is refused with code \"invalid_state\". No preview step; no confirm flag. Returns {series_id, moderation_state} with moderation_state now \"ready_for_review\".",
        inputSchema: {
          type: "object" as const,
          properties: {
            eventseries_id: {
              type: "string",
              description: "The event series id (get_event `series_id`, or an eventinstance id — either resolves to its series).",
            },
          },
          required: ["eventseries_id"],
        },
        access: "authenticated",
        mutates: true,
      },
      {
        name: "cancel_occurrence",
        description:
          "Cancel ONE occurrence of an event series without touching the rest — organizer write, acting-user-gated. This is the tool for a postponement: to move a single occurrence's date while keeping registrants informed, cancel_occurrence it first (registrants are notified it's off), THEN edit_occurrence its date while it's dark, THEN restore_occurrence to bring it back at the new time. (Contrast: to reschedule a still-LIVE occurrence with no gap, skip cancel entirely and just call edit_occurrence directly — that notifies registrants of the new date without ever cancelling.) For a PARTIAL series restore, cancel_occurrence each instance you want to STAY cancelled before calling restore_event on the parent series — restore_event skips any instance that is individually cancelled. Registrations on the occurrence are always KEPT (never destroyed) on cancel. WITHOUT confirmed:true, returns a no-write PREVIEW (status:\"preview\", executed:false, registrants_affected). WITH confirmed:true it executes: a published occurrence archives; an already-archived occurrence is idempotently flagged (so a series-wide restore will skip it); a draft occurrence is refused with code \"invalid_state\" (delete it instead — there's nothing published to cancel); any other state is also refused invalid_state. Returns {eventinstance_id, registrants_affected, notified, notifications_disabled}.",
        inputSchema: {
          type: "object" as const,
          properties: {
            eventinstance_id: {
              type: "string",
              description: "The eventinstance id (from search_events/get_event `id`, or get_my_events).",
            },
            confirmed: {
              type: "boolean",
              description: "Omit or false for a no-write preview; true to execute the cancel.",
            },
          },
          required: ["eventinstance_id"],
        },
        access: "authenticated",
        mutates: true,
      },
      {
        name: "restore_occurrence",
        description:
          "Un-cancel ONE previously cancelled (archived) occurrence — the inverse of cancel_occurrence. Only legal on an archived occurrence; a non-archived one is refused with code \"invalid_state\". Two outcomes depend on the PARENT series' current state: if the parent is published, the occurrence republishes immediately and its registrants are notified (returns_with_series is absent/false). If the parent series is itself dark (archived), the occurrence CANNOT publish while its series is dark — instead this just clears its individually-cancelled flag so it automatically rejoins the series the next time restore_event runs on the parent; the occurrence itself stays archived FOR NOW and the response carries returns_with_series:true, notified:0. Ordering matters: apply any date fix (edit_occurrence) to a cancelled occurrence WHILE it is still dark, before calling restore_occurrence — once it's back live, a further date change is a separate reschedule notice. If add_occurrence refuses with code \"duplicate_date\" because an existing occurrence at that exact time is a cancelled twin, use restore_occurrence on that existing occurrence instead of trying to add a new one. No preview step. Returns {eventinstance_id, notified, notifications_disabled} plus returns_with_series when applicable.",
        inputSchema: {
          type: "object" as const,
          properties: {
            eventinstance_id: {
              type: "string",
              description: "The eventinstance id to restore.",
            },
          },
          required: ["eventinstance_id"],
        },
        access: "authenticated",
        mutates: true,
      },
      {
        name: "edit_occurrence",
        description:
          "Edit ONE occurrence's own date or location — a content edit on that single instance; it does not touch sibling occurrences or the parent series. The API deliberately has no whole-schedule rebuild operation — this per-occurrence edit, plus add_occurrence/cancel_occurrence to add or remove a date, is how schedule changes work. This is the tool for rescheduling a still-LIVE occurrence: call it directly with the new date and registrants are notified of the move — no need to cancel first. (Contrast: to postpone with a gap — cancel now, fix the date later — use cancel_occurrence, THEN edit_occurrence while it's dark, THEN restore_occurrence.) A date change on a live (published) occurrence with existing registrants requires confirmed:true and previews first: WITHOUT confirmed:true you get a no-write PREVIEW (status:\"preview\", executed:false, registrants_to_notify — the count who would be notified of the move). A date change on a DARK (draft/archived) occurrence, a date change with no registrants, or a location-only edit all apply immediately without needing confirmed. Returns on commit: {eventinstance_id, registrants_affected}.",
        inputSchema: {
          type: "object" as const,
          properties: {
            eventinstance_id: {
              type: "string",
              description: "The eventinstance id to edit.",
            },
            confirmed: {
              type: "boolean",
              description: "Required true to commit a date change on a live occurrence with registrants; otherwise optional.",
            },
            date: {
              type: "object",
              properties: {
                value: { type: "string", description: "New start date/time (naive UTC, e.g. 2026-09-01T14:00:00)." },
                end_value: { type: "string", description: "New end date/time (naive UTC)." },
              },
              description: "New date range for this occurrence. Omit to leave the date unchanged.",
            },
            field_location: {
              type: "string",
              description: "New location for this occurrence. Omit to leave unchanged.",
            },
          },
          required: ["eventinstance_id"],
        },
        access: "authenticated",
        mutates: true,
      },
      {
        name: "add_occurrence",
        description:
          "Add ONE new occurrence directly to an event series — an unregistered, targeted addition (not a schedule rebuild: it touches only the one new row, with no risk to any other occurrence's registrants). The API deliberately has no whole-schedule rebuild operation; this tool, edit_occurrence (move one date), and cancel_occurrence (remove one date) are how a schedule changes — a series' recurrence pattern itself can never be rebuilt once it has registrations, on any surface. Its birth state follows the parent series: adding to a published series creates a published occurrence immediately; adding to an archived series creates an archived one that comes back the normal way when the series is restored. Adding to a DRAFT series is refused with code \"invalid_state\" (a draft's new occurrence would be born archived with no path to visible — publish or send_for_review the series first). Refused with code \"duplicate_date\" if an occurrence already exists at the exact requested start time; if that existing occurrence is itself a cancelled twin, the refusal message points you at restore_occurrence instead — re-adding at that same moment almost always means bringing the cancelled one back, not creating a competing duplicate. No preview step; no confirm flag. Returns {series_id, eventinstance_id, moderation_state}.",
        inputSchema: {
          type: "object" as const,
          properties: {
            eventseries_id: {
              type: "string",
              description: "The event series id to add an occurrence to (get_event `series_id`, or an eventinstance id — either resolves to its series).",
            },
            date: {
              type: "object",
              properties: {
                value: { type: "string", description: "Start date/time (naive UTC). Required." },
                end_value: { type: "string", description: "End date/time (naive UTC). Required." },
              },
              description: "The new occurrence's date range. Required.",
            },
          },
          required: ["eventseries_id", "date"],
        },
        access: "authenticated",
        mutates: true,
      },
    ];
    return tools;
  }

  protected getResources(): Resource[] {
    return [
      {
        uri: "accessci://events",
        name: "ACCESS-CI Events",
        description: "Comprehensive events data including workshops, webinars, and training",
        mimeType: "application/json",
      },
      {
        uri: "accessci://events/upcoming",
        name: "Upcoming Events",
        description: "Events scheduled for today and beyond",
        mimeType: "application/json",
      },
      {
        uri: "accessci://events/workshops",
        name: "Workshops",
        description: "Workshop events only",
        mimeType: "application/json",
      },
      {
        uri: "accessci://events/webinars",
        name: "Webinars",
        description: "Webinar events only",
        mimeType: "application/json",
      },
    ];
  }

  protected async handleToolCall(request: CallToolRequest): Promise<CallToolResult> {
    const { name, arguments: args = {} } = request.params;

    try {
      switch (name) {
        case "search_events":
          return await this.searchEvents(args as SearchEventsParams);
        case "get_my_events":
          return await this.getMyEvents(args as GetMyEventsParams);
        case "get_event":
          return await this.getEvent(args.eventinstance_id as string);
        case "register_for_event":
          return await this.registerForEvent(
            args.eventinstance_id as string,
            args.confirmed as boolean | undefined
          );
        case "get_my_registrations":
          return await this.getMyRegistrations(((args as { when?: string }).when) || "upcoming");
        case "cancel_registration":
          return await this.cancelRegistration(args.registrant_id as string, args.confirmed as boolean);
        case "create_event":
          return await this.createEvent(args as unknown as CreateEventParams);
        case "update_event":
          return await this.updateEvent(args as unknown as UpdateEventParams);
        case "delete_event":
          return await this.deleteEvent(args.eventseries_id as string, args.confirmed as boolean | undefined);
        case "restore_event":
          return await this.restoreEvent(args.eventseries_id as string);
        case "send_for_review":
          return await this.sendForReview(args.eventseries_id as string);
        case "cancel_occurrence":
          return await this.cancelOccurrence(args.eventinstance_id as string, args.confirmed as boolean | undefined);
        case "restore_occurrence":
          return await this.restoreOccurrence(args.eventinstance_id as string);
        case "edit_occurrence":
          return await this.editOccurrence(args as unknown as EditOccurrenceParams);
        case "add_occurrence":
          return await this.addOccurrence(args as unknown as AddOccurrenceParams);
        default:
          return this.errorResponse(`Unknown tool: ${name}`);
      }
    } catch (error) {
      // Paths that use the THROWING auth accessors (get/post/patch/delete —
      // get_my_registrations, get_my_events, the write tools) raise a
      // DrupalApiError. A persistent auth failure among those must land on the
      // structured envelope, not the raw "Drupal API error: 307 Temporary
      // Redirect" text that leaked to production users. The shared base-server
      // helper branches on .status/.code structurally, never on the message.
      const authError = this.drupalAuthError(error);
      if (authError) return authError;
      return this.errorResponse(handleApiError(error));
    }
  }

  protected async handleResourceRead(request: ReadResourceRequest): Promise<ReadResourceResult> {
    const { uri } = request.params;

    switch (uri) {
      case "accessci://events": {
        const allEvents = await this.searchEvents({});
        const content = allEvents.content[0];
        const text = content.type === "text" ? content.text : "";
        return this.createJsonResource(uri, JSON.parse(text));
      }
      case "accessci://events/upcoming": {
        const upcomingEvents = await this.searchEvents({ date: "upcoming" });
        const content = upcomingEvents.content[0];
        const text = content.type === "text" ? content.text : "";
        return this.createJsonResource(uri, JSON.parse(text));
      }
      case "accessci://events/workshops": {
        const workshops = await this.searchEvents({ type: "workshop" });
        const content = workshops.content[0];
        const text = content.type === "text" ? content.text : "";
        return this.createJsonResource(uri, JSON.parse(text));
      }
      case "accessci://events/webinars": {
        const webinars = await this.searchEvents({ type: "webinar" });
        const content = webinars.content[0];
        const text = content.type === "text" ? content.text : "";
        return this.createJsonResource(uri, JSON.parse(text));
      }
      default:
        throw new Error(`Unknown resource: ${uri}`);
    }
  }

  // Allowed values for the Drupal view's exposed items_per_page pager. Must
  // stay in sync with the view's items_per_page_options; a value outside the
  // list fails the exposed-pager select validation and returns an empty page.
  private static readonly ALLOWED_PAGE_SIZES = [1, 5, 10, 20, 25, 50, 100, 250, 500];

  // Single source of truth for the offset/limit/needed/fetchSize window math
  // shared by buildEventsUrl (sizes the actual fetch) and getEvents (sizes
  // the has_more/capped arithmetic over the fetched array). They MUST derive
  // the same limit default — the fetch and the arithmetic silently
  // disagreeing here (one defaulting to 50, the other falling back to the
  // fetched array's own length) is what let a default no-limit search report
  // wrong has_more/capped metadata without either function's own logic
  // being wrong in isolation. coerceLimit (not `?? 50` alone) is required:
  // limit:0 is the deliberate count-only contract and must survive as 0, not
  // become 50 — but a negative/NaN/Infinity limit must NOT survive, or it
  // becomes a slice-from-the-end footgun below (slice(offset, offset+limit)
  // with a negative limit reads backward from offset instead of forward).
  private resolveEventsPageWindow(params: SearchEventsParams): {
    offset: number;
    limit: number;
    needed: number;
    fetchSize: number;
  } {
    const offset = coerceOffset(params.offset);
    const limit = coerceLimit(params.limit, 50);
    const needed = offset + limit + 1;
    const fetchSize = EventsServer.ALLOWED_PAGE_SIZES.find((s) => s >= needed)
      || EventsServer.ALLOWED_PAGE_SIZES[EventsServer.ALLOWED_PAGE_SIZES.length - 1];
    return { offset, limit, needed, fetchSize };
  }

  private buildEventsUrl(params: SearchEventsParams): string {
    // /api/2.4 emits start_date/end_date as true UTC instants (…Z). v2.3 and
    // earlier appended Z to a clock already converted to site-local, so the
    // values were offset from the real instant (4h summer / 5h winter for a US
    // Eastern site). isoInstant leaves the already-zoned 2.4 values untouched.
    const url = new URL("/api/2.4/events", this.baseURL);

    // Fetch-from-page-0 + local slice (NOT Drupal page-number paging — an
    // arbitrary offset can't be expressed as a page boundary). Size the
    // single fetched page to cover the requested window PLUS one extra
    // record (the has_more probe), capped at the largest allowed page size
    // (items_per_page > 500 fails the pager's validation and returns an
    // empty array, so 500 is a hard ceiling, not just a default).
    const { fetchSize: itemsPerPage } = this.resolveEventsPageWindow(params);
    url.searchParams.set("items_per_page", String(itemsPerPage));

    if (params.query) {
      url.searchParams.set("search_api_fulltext", params.query);
    }

    // Explicit date_range overrides the date shortcut. ISO-only: routes
    // exclusively to the absolute beginning_date/end_date Drupal params (no
    // relative detection — that's the enum's job, in the else branch below).
    if (params.date_range && (params.date_range.start_date || params.date_range.end_date)) {
      if (params.date_range.start_date) {
        url.searchParams.set("beginning_date", params.date_range.start_date);
      }
      if (params.date_range.end_date) {
        url.searchParams.set("end_date", params.date_range.end_date);
      }
    } else {
      // Map date shortcut to API params
      // has_video implies past events since only past events have recordings
      const dateMap: Record<string, { start: string; end?: string }> = {
        today: { start: "today" },
        upcoming: { start: "today" },
        past: { start: "-1year", end: "today" },
        this_week: { start: "today", end: "+1week" },
        this_month: { start: "today", end: "+1month" },
      };

      const dateKey = params.date || (params.has_video ? "past" : null);
      if (dateKey && dateMap[dateKey]) {
        url.searchParams.set("beginning_date_relative", dateMap[dateKey].start);
        if (dateMap[dateKey].end) {
          url.searchParams.set("end_date_relative", dateMap[dateKey].end!);
        }
      }
    }

    // Faceted filters — Drupal's f[0]=<facet-url_alias>:value format. The key
    // MUST be the facet's url_alias (what the Facets QueryString URL processor
    // parses), NOT its internal field_identifier. For custom_event_type the two
    // coincide; for tags and skill they differ, so the field_identifier form
    // silently no-ops (Drupal drops the unrecognized filter and returns
    // unfiltered results). url_alias values are from the site's
    // facets.facet.*.yml config.
    let facetIndex = 0;
    if (params.type) {
      url.searchParams.set(`f[${facetIndex++}]`, `custom_event_type:${params.type}`);
    }
    if (params.tags) {
      url.searchParams.set(`f[${facetIndex++}]`, `tags:${params.tags}`);
    }
    if (params.skill) {
      // The facet VALUE must match the indexed field_skill_level allowed-value,
      // which is capitalized ("Beginner"/"Intermediate"/"Advanced") and matched
      // exactly (string index field, no case folding). The tool's input enum is
      // lowercase for caller convenience, so capitalize before filtering — a
      // lowercase value silently matches nothing.
      const skill = params.skill.charAt(0).toUpperCase() + params.skill.slice(1).toLowerCase();
      url.searchParams.set(`f[${facetIndex++}]`, `custom_event_skill_level:${skill}`);
    }

    return url.toString();
  }

  private async getEvents(params: SearchEventsParams): Promise<CallToolResult> {
    const url = this.buildEventsUrl(params);
    const response = await this.httpClient.get(url);

    if (response.status !== 200) {
      throw new Error(`API error ${response.status}`);
    }

    // Ensure response is an array (non-array means unexpected response like 403 HTML)
    const events: RawEvent[] = Array.isArray(response.data) ? response.data : [];

    const enhancedEvents = events.map((event: RawEvent) => {
      const {
        registration,
        registration_enabled,
        registration_capacity,
        registration_has_waitlist,
        ...rest
      } = event;
      // Normalize the daterange fields to unambiguous instants ONCE, and use
      // them for both the emitted fields and the duration/starts math. Using the
      // raw value in `new Date()` is unsafe: a naive string (no zone) parses as
      // LOCAL time on a non-UTC runtime, so starts_in_hours — and the sort that
      // depends on it — would drift by the runtime offset. isoInstant yields a
      // zoned instant (…Z / +00:00 / offset), which Date parses unambiguously.
      const startNorm = isoInstant(event.start_date) ?? event.start_date;
      const endNorm = isoInstant(event.end_date) ?? event.end_date;
      return {
        ...rest,
        // Emit zoned instants. /api/2.4 already returns …Z, so isoInstant is a
        // no-op here; the fallback covers any non-zoned value. (get_event also
        // emits zoned instants; get_my_events reads a different jsonapi path and
        // is not guaranteed identical — do not assume cross-tool parity.)
        start_date: startNorm,
        end_date: endNorm,
        description: params.full_description
          ? event.description
          : compactDescription(event.description),
        tags:
          typeof event.tags === "string" && event.tags.trim()
            ? event.tags.split(",").map((t: string) => t.trim())
            : Array.isArray(event.tags)
              ? event.tags
              : [],
        duration_hours: endNorm
          ? Math.round(
              (new Date(endNorm).getTime() - new Date(startNorm || "").getTime()) / 3600000
            )
          : null,
        starts_in_hours: Math.max(
          0,
          Math.round((new Date(startNorm || "").getTime() - Date.now()) / 3600000)
        ),
        // Native ACCESS registration (managed via the registration tools),
        // distinct from the external registration_url below. The flat API
        // sends these as Drupal strings ('Yes'/'No', '0'/'11'), so parse
        // rather than testing raw truthiness (Boolean('No') === true).
        access_registration: parseDrupalBool(registration_enabled)
          ? {
              enabled: true,
              // capacity 0 means unlimited → null; also NaN/absent → null.
              capacity: (() => {
                const n = parseInt(String(registration_capacity), 10);
                return Number.isNaN(n) || n === 0 ? null : n;
              })(),
              has_waitlist: parseDrupalBool(registration_has_waitlist),
            }
          : { enabled: false },
        // External offsite registration link (ACCESS does not manage these).
        registration_url: registration && registration.trim() ? registration : null,
      };
    });

    // Sort by starts_in_hours ascending so nearest events come first
    enhancedEvents.sort((a, b) => a.starts_in_hours - b.starts_in_hours);

    // Client-side filter: has_video
    const filtered = params.has_video
      ? enhancedEvents.filter((e) => typeof e.video === "string" && e.video.trim() !== "")
      : enhancedEvents;

    // Local slice of the single fetched (page-0) response — see buildEventsUrl
    // for why offset can't be expressed as a Drupal page number. offset/limit
    // MUST come from the SAME resolveEventsPageWindow helper buildEventsUrl
    // used to size the fetch, or the reported metadata can drift from what
    // was actually fetched (the nsf-awards bug this pattern was built to
    // avoid) — a bare `filtered.length` fallback here previously disagreed
    // with buildEventsUrl's default and made default (no-limit) searches
    // silently over-return with dishonest has_more/capped metadata.
    const { offset, limit, needed, fetchSize } = this.resolveEventsPageWindow(params);
    // Single honest trigger for the ceiling: true when the fetch was sized to
    // include the +1 probe record, false when the 500-record cap ate it. At
    // offset+limit===500 (needed=501, no allowed bucket >= 501) this is
    // false — the probe was lost even though a full window came back, so
    // has_more must fall to the "assume more" branch below, not a clean
    // false. (This is `fetchSize < needed`, i.e. `offset+limit >= 500` —
    // NOT `> 500`, which would miss exactly that boundary.)
    const probePreserved = fetchSize >= needed;
    // window: local slice, not the old slice(0, limit) — an offset must
    // return records [offset, offset+limit), never records from the start.
    // limit:0 (deliberate count-only contract) naturally yields [] here —
    // slice(offset, offset+0) — no special case needed.
    const window = filtered.slice(offset, offset + limit);
    const has_more = probePreserved
      ? filtered.length > offset + limit
      : filtered.length >= fetchSize;
    // Bare-array upstream has no true count, so total is always a lower
    // bound: what we can prove exists (offset + what we actually sliced).
    const total_lower_bound = offset + window.length;

    const pagination: {
      limit: number;
      offset: number;
      total_lower_bound: number;
      has_more: boolean;
      capped?: true;
    } = {
      limit,
      offset,
      total_lower_bound,
      has_more,
      ...(probePreserved ? {} : { capped: true as const }),
    };

    const envelope = {
      // Required top-level `total` stays a number via the lower-bound
      // fallback (nsf-awards' shape) — there is no true count to report.
      total: total_lower_bound,
      items: window,
      metadata: {
        pagination,
        query_relevance: params.query ? ("loose_match" as const) : ("exact" as const),
        filters_applied: {
          query: params.query ?? null,
          type: params.type ?? null,
          tags: params.tags ?? null,
          date: params.date ?? null,
          date_range: params.date_range ?? null,
          skill: params.skill ?? null,
          has_video: params.has_video ?? null,
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
          text: JSON.stringify(projectFields(envelope, params.fields)),
        },
      ],
    };
  }

  private async searchEvents(params: SearchEventsParams): Promise<CallToolResult> {
    // Validate enum parameters
    const validDateValues = ["today", "upcoming", "past", "this_week", "this_month"];
    const validSkillValues = ["beginner", "intermediate", "advanced"];

    if (params.date && !validDateValues.includes(params.date)) {
      return this.errorResponse(
        `Invalid date value: '${params.date}'`,
        { hint: `Valid values are: ${validDateValues.join(", ")}` }
      );
    }

    if (params.skill && !validSkillValues.includes(params.skill)) {
      return this.errorResponse(
        `Invalid skill value: '${params.skill}'`,
        { hint: `Valid values are: ${validSkillValues.join(", ")}` }
      );
    }

    return await this.getEvents(params);
  }

  /**
   * Get events for the authenticated user via the unified Drupal view.
   * Uses the /jsonapi/views/event_instance_mine/mcp_my_events endpoint
   * which filters by X-Acting-User header.
   */
  private async getMyEvents(params: GetMyEventsParams): Promise<CallToolResult> {
    const auth = this.getDrupalAuth();

    // Ensure we have an acting user
    const actingUser = this.getActingUserAccessId();

    // coerceLimit (not `|| 50`): `||` turned an explicit 0 into 50, diverging
    // from search_events' count-only contract where limit:0 stays 0. It also
    // left a negative limit unclamped into this tool's own `slice(0, limit)`
    // below (a negative limit there is also a slice-from-the-end footgun).
    const limit = coerceLimit(params.limit, 50);

    // Fetch one extra so has_more can distinguish exact-limit from
    // limit-plus-more (avoids the >=limit false-positive when the
    // user's total is exactly the requested cap).
    const result = await auth.get(
      actingUser,
      `/jsonapi/views/event_instance_mine/mcp_my_events?page[limit]=${limit + 1}`
    );

    const fetchedItems = result.data || [];
    const hasMore = fetchedItems.length > limit;
    const slicedItems = fetchedItems.slice(0, limit);

    // jsonapi_views serializes only the base eventinstance entity (it drops
    // configured view fields / Twig rewrites), so we read the base-entity
    // attributes directly: `date` is a daterange ({value, end_value}, naive
    // UTC), `status` is the publish boolean, and `moderation_state` carries the
    // real editorial state (draft/ready_for_review/published) shown in the view.
    // We deliberately do NOT spread ...item.attributes — that re-added the raw
    // boolean `status`, clobbering the mapped value, and leaked revision/langcode
    // internals into the response.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- JSON:API response shape is dynamic
    const events = slicedItems.map((item: any) => {
      const attrs = item.attributes ?? {};
      const dateRange = Array.isArray(attrs.date) ? attrs.date[0] : attrs.date;
      return {
        id: item.id,
        type: item.type,
        title: attrs.title,
        // The jsonapi view emits offset-bearing values (e.g. "…-05:00");
        // canonicalize to UTC "…Z" so get_my_events matches search_events /
        // get_event's date form. Correct instant either way — this is uniformity.
        start_date: isoInstantUtc(dateRange?.value),
        end_date: isoInstantUtc(dateRange?.end_value),
        status: attrs.moderation_state,
      };
    });

    // Bare page-length was reported as `total` before, which is a lie once
    // has_more is true (there's more beyond what was fetched). No true count
    // is available from this jsonapi view, so total is a lower bound — what
    // we can prove exists (there's no paging here, so that's just the
    // returned page length). offset stays 0, but now legitimately: this tool
    // does not page (jsonapi `page[offset]` support is unverified against an
    // authed endpoint), so record 0 really is where every call starts.
    const total_lower_bound = events.length;

    const envelope = {
      total: total_lower_bound,
      items: events,
      metadata: {
        pagination: {
          limit,
          offset: 0,
          total_lower_bound,
          has_more: hasMore,
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
          text: JSON.stringify(projectFields(envelope, params.fields)),
        },
      ],
    };
  }

  /**
   * Wrap a Drupal response body as an MCP text content block. Guards against a
   * missing/undefined body: JSON.stringify(undefined) returns undefined (not a
   * string), which produces a content[0] with no `text` field and fails MCP
   * response validation. Emit an explicit message instead.
   */
  private jsonContent(data: unknown): CallToolResult {
    const text =
      data === undefined || data === null || data === ""
        ? "The request succeeded but returned no data."
        : JSON.stringify(data, null, 2);
    return { content: [{ type: "text", text }] };
  }

  /**
   * Fetch one event's full detail + live registration state via the Drupal
   * GET /api/2.3/events/{eventinstance_id} route. Stays on 2.3 deliberately:
   * the offset bug is LIST-ONLY — verified against prod, the 2.3 DETAIL endpoint
   * already returns true-UTC start_date/end_date (…Z), and there is NO 2.4
   * detail endpoint (/api/2.4/events/{id} 404s). Only search_events (the list)
   * moves to 2.4. Do not flip this to 2.4 — it does not exist there.
   * Drupal shapes the registration block, so this is a thin passthrough with
   * error handling. Uses the non-throwing requestRaw accessor so a 404 is
   * surfaced as a first-class error rather than a thrown exception.
   */
  private async getEvent(eventinstanceId: string): Promise<CallToolResult> {
    if (!eventinstanceId || typeof eventinstanceId !== "string") {
      return this.errorResponse(
        "eventinstance_id is required",
        { hint: "Pass the event `id` from search_events." }
      );
    }
    const actingUser = this.getActingUserAccessId(); // throws → aligned auth error if no acting user
    const auth = this.getDrupalAuth();
    const { status, data } = await auth.requestRaw(
      actingUser,
      "GET",
      `/api/2.3/events/${encodeURIComponent(eventinstanceId)}`
    );
    if (status === 404) {
      return this.errorResponse(
        `No event found with id ${eventinstanceId}`,
        { hint: "Check the id via search_events." }
      );
    }
    const authError = this.authRedirectError(status);
    if (authError) return authError;
    if (status < 200 || status >= 300) {
      return this.errorResponse(
        `Events service error (${status})`,
        { hint: "Try again shortly.", code: "upstream_error" }
      );
    }
    // Compute a single top-level registration_path so a caller reads one value
    // instead of inferring intent from two peer fields (native registration vs
    // an external URL). When native is enabled AND an external URL is present,
    // relocate the URL to a labeled external_registration_url and drop the
    // ambiguous registration_url key.
    const detail = data as Record<string, unknown>;
    const registration = detail.registration as { enabled?: unknown } | undefined;
    const nativeEnabled = registration?.enabled === true;
    const externalUrl =
      typeof detail.registration_url === "string" ? detail.registration_url : undefined;
    let registration_path: "native" | "external" | "none";
    if (nativeEnabled) {
      registration_path = "native";
      if (externalUrl) {
        detail.external_registration_url = externalUrl;
        delete detail.registration_url;
      }
    } else if (externalUrl) {
      registration_path = "external";
    } else {
      registration_path = "none";
    }
    detail.registration_path = registration_path;
    return this.jsonContent(detail);
  }

  /**
   * Register the acting user for an event via the Drupal
   * POST /api/1.0/events/{eventinstance_id}/register route.
   * Without confirmed → a no-write preview; confirmed:true → commit + registrant_id.
   *
   * Every non-error outcome returns the StandardWriteResponse envelope
   * ({action:"register", status, executed, data?}); errors go through
   * errorResponse ({status:"error", executed:false, error:{code,message,hint?}},
   * isError:true).
   *
   * Status branching (via the non-throwing requestRaw accessor):
   *  - 2xx → a writeResponse. status "registered"/"waitlisted" with executed:true
   *    (a commit) when confirmed:true, else status "preview" with executed:false
   *    (the projected outcome_if_confirmed; no write performed). The raw Drupal
   *    body is NOT passed through — it is remapped onto the envelope.
   *  - 409 = state-based refusal. already_registered is the ONLY 409 that is a
   *    terminal, non-error writeResponse (status "already_registered",
   *    executed:false — the user already holds a seat). Every OTHER 409 code
   *    (event_full, registration_closed, not_permitted) is an errorResponse
   *    carrying the Drupal `code` (isError:true). The Drupal route returns
   *    not_permitted as 409, so role refusals arrive here too.
   *  - 403 → a genuine identity/auth failure from the acting-user gate
   *    (ActingUserAccess / acting_user_uid resolution; the acting-user could not
   *    be resolved/authorized). This is NOT a state refusal and must not be
   *    conflated with 409 — errorResponse with code "auth_required".
   *  - 404 → no such event; errorResponse with code "not_found".
   *  - other non-2xx → errorResponse with code "upstream_error".
   */
  private async registerForEvent(
    eventinstanceId: string,
    confirmed?: boolean
  ): Promise<CallToolResult> {
    if (!eventinstanceId || typeof eventinstanceId !== "string") {
      return this.errorResponse(
        "eventinstance_id is required",
        { hint: "Pass the event `id` from search_events or get_event." }
      );
    }
    const actingUser = this.getActingUserAccessId(); // throws → aligned auth error if no acting user
    const auth = this.getDrupalAuth();
    const { status, data } = await auth.requestRaw(
      actingUser,
      "POST",
      `/api/1.0/events/${encodeURIComponent(eventinstanceId)}/register`,
      { confirmed: confirmed === true }
    );

    if (status >= 200 && status < 300) {
      // Commit (confirmed:true) → Drupal returns a terminal status; preview
      // (confirmed omitted/false) → the projected outcome, no write performed.
      if (data?.status === "registered" || data?.status === "waitlisted") {
        return this.writeResponse({
          action: "register",
          status: data.status,
          executed: true,
          data: { registrant_id: data.registrant_id },
        });
      }
      // The real Drupal preview body always carries outcome_if_confirmed (see the
      // spec Ground Truth), so no guard is needed here — reading it unconditionally
      // is safe. If it were ever absent, JSON.stringify drops the undefined key and
      // data serializes to {}; the envelope stays conformant either way.
      return this.writeResponse({
        action: "register",
        status: "preview",
        executed: false,
        data: {
          outcome_if_confirmed: data?.outcome_if_confirmed,
          ...(data?.waitlisted_count != null && {
            waitlisted_count: data.waitlisted_count,
          }),
        },
      });
    }

    // 409 = state-based refusal. already_registered is a terminal, non-error
    // status (the user already holds a seat); every other 409 code is an
    // actionable error carrying the Drupal code. The Drupal route returns
    // not_permitted as 409, so role refusals also arrive here.
    if (status === 409) {
      if (data?.error === "already_registered") {
        return this.writeResponse({
          action: "register",
          status: "already_registered",
          executed: false,
        });
      }
      return this.errorResponse(
        data?.message ?? "Registration refused.",
        { hint: "See the event's registration state via get_event.", code: data?.error }
      );
    }

    // A bare 403 (no not_permitted state code) is an identity/auth failure from
    // the acting-user gate, not a state refusal — never conflate it with 409.
    if (status === 403) {
      return this.errorResponse(
        "Not authorized to register — your acting-user identity could not be resolved or authorized.",
        { hint: "Re-authenticate the ACCESS connector and try again.", code: "auth_required" }
      );
    }

    if (status === 404) {
      return this.errorResponse(
        `No event found with id ${eventinstanceId}`,
        { hint: "Check the id via search_events.", code: "not_found" }
      );
    }

    const authError = this.authRedirectError(status);
    if (authError) return authError;

    return this.errorResponse(
      `Events service error (${status})`,
      { hint: "Try again shortly.", code: "upstream_error" }
    );
  }

  /**
   * List the acting user's event registrations via the Drupal
   * /api/1.0/registrations endpoint. The response body is
   * { registrations: [...] } at the top level (no data wrapper).
   */
  private async getMyRegistrations(when: string): Promise<CallToolResult> {
    const actingUser = this.getActingUserAccessId(); // throws → aligned auth error if no acting user
    const auth = this.getDrupalAuth();
    const body = await auth.get(
      actingUser,
      `/api/1.0/registrations?when=${encodeURIComponent(when)}`
    );
    return this.jsonContent(body); // body === { registrations: [...] }
  }

  /**
   * Cancel one of the acting user's registrations via the Drupal
   * DELETE /api/1.0/registrations/{registrant_id} endpoint. PREVIEW-by-default:
   *
   *  - confirmed !== true → a no-write PREVIEW. Looks the registration up in the
   *    acting user's when=all registration list (when=all, NOT the default
   *    upcoming, so a past-dated registration still previews) and returns the
   *    write envelope {action:"cancel", status:"preview", executed:false, data:
   *    {registrant_id, event}}. STRICT === true gates the destructive path — a
   *    truthy-but-not-true value (1, "true") lands here, never on the delete.
   *    An unknown registrant_id (not in the when=all list) → errorResponse
   *    code:"not_found".
   *  - confirmed === true → EXECUTE the DELETE. On 2xx → {action:"cancel",
   *    status:"cancelled", executed:true, data:{registrant_id}}. auth.delete
   *    throws DrupalApiError on non-2xx: 404 (unknown/other id) → code:"not_found",
   *    403 (non-owner) → code:"forbidden", else → code:"upstream_error". Branches
   *    on DrupalApiError.status structurally, never on the message string.
   */
  private async cancelRegistration(registrantId: string, confirmed?: boolean): Promise<CallToolResult> {
    if (!registrantId || typeof registrantId !== "string") {
      return this.errorResponse(
        "registrant_id is required",
        { hint: "Call get_my_registrations to find the registrant_id of the registration to cancel." }
      );
    }
    const actingUser = this.getActingUserAccessId(); // throws → aligned auth error if no acting user
    const auth = this.getDrupalAuth();

    // PREVIEW (confirmed omitted/false, or any truthy-but-not-true value). Never
    // deletes — enforce STRICT boolean true so 1/"true"/{} cannot trigger an
    // irreversible cancel. Look the registration up in the acting user's when=all
    // list so a past-dated registration still previews.
    if (confirmed !== true) {
      let body: { registrations?: Array<Record<string, unknown>> } | undefined;
      try {
        body = await auth.get(actingUser, `/api/1.0/registrations?when=all`);
      } catch (error) {
        // The preview lookup can itself fail. Carry the same machine-readable
        // code as the execute path so callers branch identically (403→forbidden,
        // else→upstream_error); a failed read never means the registration is
        // absent, so it must NOT map to not_found.
        if (error instanceof DrupalApiError) {
          if (error.status === 403) {
            return this.errorResponse(
              "Not authorized to look up your registrations.",
              { hint: "Re-authenticate the ACCESS connector and try again.", code: "forbidden" }
            );
          }
          return this.errorResponse(
            `Events service error (${error.status})`,
            { hint: "Try again shortly.", code: "upstream_error" }
          );
        }
        throw error;
      }
      const registrations = (body?.registrations ?? []) as Array<Record<string, unknown>>;
      const row = registrations.find((r) => r.registrant_id === registrantId);
      if (!row) {
        return this.errorResponse(
          "Registration not found (or not yours).",
          { hint: "Call get_my_registrations to find your registrant_id.", code: "not_found" }
        );
      }
      return this.writeResponse({
        action: "cancel",
        status: "preview",
        executed: false,
        data: {
          registrant_id: registrantId,
          event: {
            title: row.event_title,
            start_date: row.start_date,
          },
        },
      });
    }

    // EXECUTE the destructive cancel. auth.delete throws DrupalApiError on
    // non-2xx; branch on the structured .status (not the message string).
    try {
      await auth.delete(
        actingUser,
        `/api/1.0/registrations/${encodeURIComponent(registrantId)}`
      );
    } catch (error) {
      if (error instanceof DrupalApiError) {
        if (error.status === 404) {
          return this.errorResponse(
            "Registration not found (or not yours).",
            { hint: "Call get_my_registrations to find your registrant_id.", code: "not_found" }
          );
        }
        if (error.status === 403) {
          return this.errorResponse(
            "Not authorized to cancel this registration — you may only cancel your own.",
            { hint: "Confirm the registrant_id belongs to you via get_my_registrations.", code: "forbidden" }
          );
        }
        return this.errorResponse(
          `Events service error (${error.status})`,
          { hint: "Try again shortly.", code: "upstream_error" }
        );
      }
      throw error;
    }

    return this.writeResponse({
      action: "cancel",
      status: "cancelled",
      executed: true,
      data: { registrant_id: registrantId },
    });
  }

  /**
   * Map a Drupal refuse() error code to the errorResponse it should surface.
   * Every organizer write route replies to a refusal with the same flat
   * {error, message} body (see EventCrudApiController::refuse()), so this is
   * shared across all nine write tools. `defaultHint` is used when no
   * code-specific hint is more useful.
   */
  private eventWriteError(status: number, data: unknown, fallbackMessage: string): CallToolResult {
    const body = (data ?? {}) as { error?: string; message?: string };
    const code = body.error ?? "upstream_error";
    const message = body.message ?? fallbackMessage;
    const hints: Record<string, string> = {
      not_found: "Check the id via search_events/get_event/get_my_events.",
      not_coordinator: "Only a coordinator of this event's affinity group(s) may manage it.",
      forbidden: "You may not hold the required editorial permission for this action.",
      registrations_exist: "This draft has registrations and cannot be silently destroyed.",
      invalid_state: "Check the event/occurrence's current status before retrying.",
      duplicate_date: "An occurrence already exists at that exact time; consider restore_occurrence instead.",
      validation_error: "Check the required fields for this call.",
    };
    return this.errorResponse(message, { code, hint: hints[code] });
  }

  /**
   * Shared dispatch for the nine organizer write routes: resolves the acting
   * user, calls requestRaw, and handles the auth-redirect / 403 / non-2xx
   * cases identically. Returns either a parsed 2xx body for the caller to map
   * into a writeResponse, or a terminal CallToolResult (error) to return
   * as-is.
   */
  private async eventWriteRequest(
    method: "GET" | "POST" | "PATCH" | "DELETE",
    path: string,
    body: unknown,
    fallbackMessage: string
  ): Promise<{ data: Record<string, unknown> } | { result: CallToolResult }> {
    const actingUser = this.getActingUserAccessId(); // throws → aligned auth error if no acting user
    const auth = this.getDrupalAuth();
    const { status, data } = await auth.requestRaw(actingUser, method, path, body);

    if (status >= 200 && status < 300) {
      return { data: (data ?? {}) as Record<string, unknown> };
    }

    const authError = this.authRedirectError(status);
    if (authError) return { result: authError };

    // A 403 from the write controllers carries {error:"forbidden", message}
    // for TWO distinct meanings. Only the identity failure (acting_user_uid < 1,
    // the controller's exact "No acting user." refusal) is a genuine
    // auth-challenge; every other forbidden 403 is a state/permission REFUSAL
    // whose real message must reach the caller (e.g. "You may not archive this
    // event.", "…requires the events-editor permission."). Rewriting those to
    // "re-authenticate" is a dead end that drops the actionable message.
    if (status === 403) {
      const body = (data ?? {}) as { error?: string; message?: string };
      const isIdentityRefusal =
        body.error === "forbidden" &&
        typeof body.message === "string" &&
        body.message.toLowerCase().includes("no acting user");
      if (isIdentityRefusal) {
        return {
          result: this.errorResponse(
            "Not authorized — your acting-user identity could not be resolved or authorized.",
            { hint: "Re-authenticate the ACCESS connector and try again.", code: "auth_required" }
          ),
        };
      }
      // Real state/permission refusal: surface the Drupal message + code.
      return { result: this.eventWriteError(status, data, fallbackMessage) };
    }

    return { result: this.eventWriteError(status, data, fallbackMessage) };
  }

  /**
   * POST /api/2.3/events — create a draft event series. Always creates
   * moderation_state:"draft" (Drupal ignores any caller-supplied state).
   * PREVIEW-by-default: confirmed omitted/false sends ?confirmed=false, then
   * branches on Drupal's RESPONSE (not the local confirmed flag, mirroring
   * deleteEvent): outcome.data.status === "preview" returns Drupal's
   * computed occurrence preview (occurrence_count/truncated/occurrences,
   * forwarded verbatim) as a no-write writeResponse; otherwise Drupal did
   * not preview (e.g. it doesn't yet understand ?confirmed=false and
   * committed instead) and the same commit mapping below is used, so the
   * caller is told the truth. confirmed:true sends ?confirmed=true and
   * always takes the commit mapping: series_id/instance_ids/title/
   * moderation_state/moderation as the write envelope's data.
   */
  private async createEvent(params: CreateEventParams): Promise<CallToolResult> {
    if (!params?.title) {
      return this.errorResponse("title is required", { hint: "Pass an event title." });
    }
    // Guard: need EITHER a recurrence object OR a raw recur_type (custom path).
    if (!params?.recur_type && !params?.recurrence) {
      return this.errorResponse("recur_type or recurrence is required", {
        code: "validation_error",
        hint: "Pass a recurrence object, or recur_type:\"custom\" with custom_dates.",
      });
    }
    if (params.recurrence && params.custom_dates) {
      return this.errorResponse("recurrence and custom_dates are mutually exclusive", {
        code: "validation_error",
        hint: "Use recurrence for rule recurrences, or custom_dates for one-off dates — not both.",
      });
    }
    // recurrence and recur_type are mutually exclusive. Without this guard, both
    // being set falls through and buildRuleField silently overwrites recur_type
    // with the value it derives from recurrence, discarding the caller's
    // recur_type with no error — the same silent-failure class this tool's
    // recurrence guidance exists to close. Reject explicitly instead.
    if (params.recurrence && params.recur_type) {
      return this.errorResponse("recurrence and recur_type are mutually exclusive", {
        code: "validation_error",
        hint: "Pass a recurrence object for a repeating event, OR recur_type:\"custom\" with custom_dates for one-off dates — not both.",
      });
    }
    // Redirect the dead-door path: a raw rule recur_type (e.g.
    // "weekly_recurring_date") without a recurrence object cannot work — the
    // matching raw *_recurring_date rule field is stripped below and never
    // reaches Drupal. Only recur_type:"custom" is a valid standalone recur_type.
    // Reject here with the equivalent recurrence object so a caller who tries
    // the raw path is redirected instead of silently producing a Drupal error.
    if (params.recur_type && params.recur_type !== "custom" && !params.recurrence) {
      return this.errorResponse(
        `Rule recurrences are not specified with recur_type "${params.recur_type}" — use the recurrence object.`,
        {
          code: "validation_error",
          hint:
            'Describe the pattern with the recurrence object instead, e.g. ' +
            '{"frequency":"weekly","days":["mon"],"start_date":"2026-10-01","end_date":"2026-10-31","start_time":"09:00","duration_minutes":60}. ' +
            'recur_type is only for "custom" (one-off dates via custom_dates); every rule pattern (daily/weekly/monthly/yearly/consecutive) goes through recurrence.',
        }
      );
    }
    // Affinity group is optional: a group is supplied only to publish the event
    // to it, and Drupal applies its own coordinator check on any supplied group.

    // Clean break: strip any raw *_recurring_date keys from content so they can
    // never reach Drupal (which validates nothing about them). recurrence is the
    // only supported way to specify a rule recurrence.
    const { title, recur_type: rawRecurType, field_affinity_group_node, custom_dates, recurrence, confirmed, ...restContent } = params;
    const content: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(restContent)) {
      if (k.endsWith("_recurring_date")) continue; // dropped by design
      content[k] = v;
    }

    let recur_type = rawRecurType;
    let ruleFieldEntry: Record<string, unknown> = {};
    if (recurrence) {
      const { ok, errors } = validateRecurrence(recurrence);
      if (!ok) {
        const first = errors[0];
        return this.errorResponse(
          errors.map((e) => e.message).join(" "),
          { code: first.code, hint: "Fix the recurrence fields and retry." }
        );
      }
      const { recur_type: builtRecurType, ...rule } = buildRuleField(recurrence);
      recur_type = builtRecurType;
      ruleFieldEntry = rule; // e.g. { weekly_recurring_date: {...cols} }
    }

    const payload = { title, recur_type, field_affinity_group_node, custom_dates, ...ruleFieldEntry, ...content };

    if (confirmed !== true) {
      const outcome = await this.eventWriteRequest(
        "POST",
        "/api/2.3/events?confirmed=false",
        payload,
        "Could not preview the event."
      );
      if ("result" in outcome) return outcome.result;

      if (outcome.data.status === "preview") {
        return this.writeResponse({
          action: "create",
          status: "preview",
          executed: false,
          data: previewData(outcome.data),
        });
      }
      // Drupal did NOT preview (e.g. it committed because it doesn't yet
      // understand ?confirmed=false) — fall through to the same commit
      // mapping the confirmed:true path uses, so the caller is told the
      // truth about what actually happened.
      return this.createdEventResponse(outcome.data);
    }

    const outcome = await this.eventWriteRequest(
      "POST",
      "/api/2.3/events?confirmed=true",
      payload,
      "Could not create the event."
    );
    if ("result" in outcome) return outcome.result;

    return this.createdEventResponse(outcome.data);
  }

  /** Shared "created" envelope mapping for createEvent's confirmed:true path
   * and its preview-fell-through-to-commit case (Drupal ignored an unknown
   * ?confirmed=false and created anyway). */
  private createdEventResponse(data: Record<string, unknown>): CallToolResult {
    const instanceIds = data.instance_ids;
    return this.writeResponse({
      action: "create",
      status: "created",
      executed: true,
      data: {
        series_id: data.series_id,
        instance_ids: instanceIds,
        title: data.title,
        moderation_state: data.moderation_state,
        moderation: data.moderation,
        ...(Array.isArray(instanceIds) && instanceIds.length === 0
          ? { recurrence_warning: "This recurrence produced no occurrences — verify the day/date-range combination." }
          : {}),
      },
    });
  }

  /**
   * PATCH /api/2.3/event-series/{id} — edit a series' content fields.
   * Content-only, by design: it never writes moderation_state and never
   * touches recurrence/date config, so it applies immediately with no
   * preview step and no confirm flag. The API deliberately has no
   * whole-schedule rebuild operation at all (verified absent from
   * access_events.routing.yml) — schedule changes are per-occurrence only,
   * via editOccurrence/addOccurrence/cancelOccurrence.
   */
  private async updateEvent(params: UpdateEventParams): Promise<CallToolResult> {
    if (!params?.eventseries_id) {
      return this.errorResponse(
        "eventseries_id is required",
        { hint: "Pass the series id from get_event/get_my_events." }
      );
    }
    const { eventseries_id, ...body } = params;
    const outcome = await this.eventWriteRequest(
      "PATCH",
      `/api/2.3/event-series/${encodeURIComponent(eventseries_id)}`,
      body,
      "Could not update the event."
    );
    if ("result" in outcome) return outcome.result;

    return this.writeResponse({
      action: "update",
      status: "updated",
      executed: true,
      data: {
        series_id: outcome.data.series_id,
        updated_fields: outcome.data.updated_fields,
      },
    });
  }

  /**
   * DELETE /api/2.3/event-series/{id} — cancel (archive or hard-delete) a
   * series. PREVIEW-by-default: confirmed omitted/false returns the Drupal
   * preview body (would_archive/would_hard_delete/registrants_affected,
   * plus refusal/registrations_total when the never-published-with-
   * registrations guard would block it) as a no-write writeResponse.
   * confirmed:true executes; a registrations_exist 409 refusal on the
   * confirmed path is an errorResponse via eventWriteError.
   */
  private async deleteEvent(eventseriesId: string, confirmed?: boolean): Promise<CallToolResult> {
    if (!eventseriesId) {
      return this.errorResponse(
        "eventseries_id is required",
        { hint: "Pass the series id from get_event/get_my_events." }
      );
    }
    const outcome = await this.eventWriteRequest(
      "DELETE",
      `/api/2.3/event-series/${encodeURIComponent(eventseriesId)}?confirmed=${confirmed === true ? "true" : "false"}`,
      undefined,
      "Could not cancel the event."
    );
    if ("result" in outcome) return outcome.result;

    if (outcome.data.status === "preview") {
      return this.writeResponse({
        action: "delete",
        status: "preview",
        executed: false,
        data: previewData(outcome.data),
      });
    }

    return this.writeResponse({
      action: "delete",
      status: "deleted",
      executed: true,
      data: {
        series_id: outcome.data.series_id,
        instances_archived: outcome.data.instances_archived ?? 0,
        registrants_affected: outcome.data.registrants_affected,
        notified: outcome.data.notified ?? 0,
        notifications_disabled: outcome.data.notifications_disabled ?? false,
        hard_deleted: outcome.data.hard_deleted,
      },
    });
  }

  /**
   * POST /api/2.3/event-series/{id}/restore — un-archive a series. No
   * preview step. invalid_state (409) when the series was never archived.
   */
  private async restoreEvent(eventseriesId: string): Promise<CallToolResult> {
    if (!eventseriesId) {
      return this.errorResponse(
        "eventseries_id is required",
        { hint: "Pass the series id from get_event/get_my_events." }
      );
    }
    const outcome = await this.eventWriteRequest(
      "POST",
      `/api/2.3/event-series/${encodeURIComponent(eventseriesId)}/restore`,
      undefined,
      "Could not restore the event."
    );
    if ("result" in outcome) return outcome.result;

    return this.writeResponse({
      action: "update",
      status: "updated",
      executed: true,
      data: {
        series_id: outcome.data.series_id,
        instances_restored: outcome.data.instances_restored ?? 0,
        notified: outcome.data.notified ?? 0,
        notifications_disabled: outcome.data.notifications_disabled ?? false,
      },
    });
  }

  /**
   * POST /api/2.3/event-series/{id}/send-for-review — route a draft/
   * needs_adjustment series to an editor. No preview step. invalid_state
   * (409) when the series is not currently draft or needs_adjustment.
   */
  private async sendForReview(eventseriesId: string): Promise<CallToolResult> {
    if (!eventseriesId) {
      return this.errorResponse(
        "eventseries_id is required",
        { hint: "Pass the series id from get_event/get_my_events." }
      );
    }
    const outcome = await this.eventWriteRequest(
      "POST",
      `/api/2.3/event-series/${encodeURIComponent(eventseriesId)}/send-for-review`,
      undefined,
      "Could not send the event for review."
    );
    if ("result" in outcome) return outcome.result;

    return this.writeResponse({
      action: "update",
      status: "updated",
      executed: true,
      data: {
        series_id: outcome.data.series_id,
        moderation_state: outcome.data.moderation_state,
      },
    });
  }

  /**
   * DELETE /api/2.3/event-occurrences/{id} — cancel one occurrence.
   * PREVIEW-by-default like deleteEvent. confirmed:true executes: a published
   * occurrence archives; an already-archived one is idempotently (re-)flagged
   * individually-cancelled; a draft (or any other non-cancellable state) is
   * refused invalid_state.
   */
  private async cancelOccurrence(eventinstanceId: string, confirmed?: boolean): Promise<CallToolResult> {
    if (!eventinstanceId) {
      return this.errorResponse(
        "eventinstance_id is required",
        { hint: "Pass the eventinstance id from search_events/get_event/get_my_events." }
      );
    }
    const outcome = await this.eventWriteRequest(
      "DELETE",
      `/api/2.3/event-occurrences/${encodeURIComponent(eventinstanceId)}?confirmed=${confirmed === true ? "true" : "false"}`,
      undefined,
      "Could not cancel the occurrence."
    );
    if ("result" in outcome) return outcome.result;

    if (outcome.data.status === "preview") {
      return this.writeResponse({
        action: "delete",
        status: "preview",
        executed: false,
        data: previewData(outcome.data),
      });
    }

    return this.writeResponse({
      action: "delete",
      status: "deleted",
      executed: true,
      data: {
        eventinstance_id: outcome.data.eventinstance_id,
        registrants_affected: outcome.data.registrants_affected,
        notified: outcome.data.notified ?? 0,
        notifications_disabled: outcome.data.notifications_disabled ?? false,
        note: outcome.data.note,
      },
    });
  }

  /**
   * POST /api/2.3/event-occurrences/{id}/restore — un-cancel one occurrence.
   * No preview step. invalid_state (409) when the occurrence is not
   * currently archived. When the parent series is dark, this only clears the
   * individually-cancelled flag (returns_with_series:true) rather than
   * publishing — see the tool doc.
   */
  private async restoreOccurrence(eventinstanceId: string): Promise<CallToolResult> {
    if (!eventinstanceId) {
      return this.errorResponse(
        "eventinstance_id is required",
        { hint: "Pass the eventinstance id to restore." }
      );
    }
    const outcome = await this.eventWriteRequest(
      "POST",
      `/api/2.3/event-occurrences/${encodeURIComponent(eventinstanceId)}/restore`,
      undefined,
      "Could not restore the occurrence."
    );
    if ("result" in outcome) return outcome.result;

    return this.writeResponse({
      action: "update",
      status: "updated",
      executed: true,
      data: {
        eventinstance_id: outcome.data.eventinstance_id,
        notified: outcome.data.notified ?? 0,
        notifications_disabled: outcome.data.notifications_disabled ?? false,
        returns_with_series: outcome.data.returns_with_series,
      },
    });
  }

  /**
   * PATCH /api/2.3/event-occurrences/{id} — edit one occurrence's date/
   * location. A date change on a live, registered occurrence requires
   * confirmed:true and previews first (registrants_to_notify); everything
   * else (location-only, dark-instance date change, no-registrant date
   * change) applies immediately.
   */
  private async editOccurrence(params: EditOccurrenceParams): Promise<CallToolResult> {
    if (!params?.eventinstance_id) {
      return this.errorResponse(
        "eventinstance_id is required",
        { hint: "Pass the eventinstance id to edit." }
      );
    }
    const { eventinstance_id, confirmed, ...body } = params;
    const outcome = await this.eventWriteRequest(
      "PATCH",
      `/api/2.3/event-occurrences/${encodeURIComponent(eventinstance_id)}?confirmed=${confirmed === true ? "true" : "false"}`,
      body,
      "Could not edit the occurrence."
    );
    if ("result" in outcome) return outcome.result;

    if (outcome.data.status === "preview") {
      return this.writeResponse({
        action: "update",
        status: "preview",
        executed: false,
        data: previewData(outcome.data),
      });
    }

    return this.writeResponse({
      action: "update",
      status: "updated",
      executed: true,
      data: {
        eventinstance_id: outcome.data.eventinstance_id,
        registrants_affected: outcome.data.registrants_affected,
      },
    });
  }

  /**
   * POST /api/2.3/event-series/{id}/occurrence — add one new occurrence.
   * No preview step. invalid_state (409) when the parent series is a draft;
   * duplicate_date (409) when an occurrence already exists at the exact
   * requested start (the error message points to restore_occurrence when the
   * collision is a cancelled twin).
   */
  private async addOccurrence(params: AddOccurrenceParams): Promise<CallToolResult> {
    if (!params?.eventseries_id) {
      return this.errorResponse(
        "eventseries_id is required",
        { hint: "Pass the series id to add an occurrence to." }
      );
    }
    if (!params?.date?.value || !params?.date?.end_value) {
      return this.errorResponse(
        "date.value and date.end_value are required",
        { hint: "Pass the new occurrence's start/end (naive UTC)." }
      );
    }
    const outcome = await this.eventWriteRequest(
      "POST",
      `/api/2.3/event-series/${encodeURIComponent(params.eventseries_id)}/occurrence`,
      { date: params.date },
      "Could not add the occurrence."
    );
    if ("result" in outcome) return outcome.result;

    return this.writeResponse({
      action: "create",
      status: "created",
      executed: true,
      data: {
        series_id: outcome.data.series_id,
        eventinstance_id: outcome.data.eventinstance_id,
        moderation_state: outcome.data.moderation_state,
      },
    });
  }
}
