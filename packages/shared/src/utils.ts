import { createLogger, Logger } from "./logger.js";

export function sanitizeGroupId(groupId: string): string {
  if (!groupId) {
    throw new Error("groupId parameter is required and cannot be null or undefined");
  }
  return groupId.replace(/[^a-zA-Z0-9.-]/g, "");
}

export function formatApiUrl(version: string, endpoint: string): string {
  return `/${version}/${endpoint}`;
}

interface AxiosErrorLike {
  response?: {
    data?: unknown;
    status?: number;
    statusText?: string;
  };
  message?: string;
  isAxiosError?: boolean;
  // DrupalApiError carries these directly instead of on `response`.
  status?: number;
  body?: unknown;
}

/**
 * The one gate for showing upstream text to a caller. A 4xx is a deliberate
 * refusal written for the user; any other status can carry internal text.
 */
export function isCallerSafeStatus(status: number | undefined): status is number {
  return status !== undefined && status >= 400 && status < 500;
}

/**
 * The text of an upstream error that is safe to show a caller, or undefined
 * when there is none. Only a 4xx qualifies (see isCallerSafeStatus); callers
 * fall back to a fixed status line otherwise.
 *
 * Accepted body shapes, in order:
 *  - {message, error?}: message is shown, error becomes the code.
 *  - {error}: a flat error string (UKY, peer MCP servers) is shown as the
 *    message, with no code.
 *  - {errors: [{detail}]}: JSON:API details, joined.
 */
export function callerSafeUpstreamError(
  status: number | undefined,
  body: unknown
): { message: string; code?: string } | undefined {
  if (!isCallerSafeStatus(status)) return undefined;
  if (typeof body !== "object" || body === null) return undefined;
  const { message, error, errors } = body as {
    message?: unknown;
    error?: unknown;
    errors?: unknown;
  };
  if (typeof message === "string" && message !== "") {
    return { message, code: typeof error === "string" && error !== "" ? error : undefined };
  }
  if (typeof error === "string" && error !== "") {
    return { message: error, code: undefined };
  }
  if (Array.isArray(errors)) {
    const details = errors
      .map((e) => (e as { detail?: unknown } | null)?.detail)
      .filter((d): d is string => typeof d === "string" && d !== "");
    if (details.length > 0) return { message: details.join("; ") };
  }
  return undefined;
}

/**
 * What an operator may learn about a failed upstream call. Every field is
 * metadata; there is deliberately no place for a body, an exception message,
 * a query string, headers, a token, or the acting user.
 */
export interface UpstreamFailure {
  /** drupal, xdmod, uky, jsm-proxy, cilogon, or a peer server name. */
  upstream: string;
  method?: string;
  /** Request path. Any query string or fragment is dropped here. */
  path?: string;
  status?: number;
  /** Transport error code such as ECONNREFUSED, for failures with no response. */
  code?: string;
  /** Target host, for failures with no response. */
  host?: string;
}

const SCHEME_HOST = /^[a-z][a-z0-9+.-]*:\/\/[^/?#]*/i;

function pathOnly(url: string | undefined): string | undefined {
  if (!url) return undefined;
  const scheme = SCHEME_HOST.exec(url);
  const path = scheme ? url.slice(scheme[0].length) : url;
  return path.split(/[?#]/)[0] || "/";
}

function hostOnly(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    return new URL(url).host;
  } catch {
    return undefined;
  }
}

/**
 * Write one stderr line saying an upstream call failed and its text was
 * withheld from the caller. Fields are copied one by one so nothing else
 * can ride along in the context object.
 */
export function logUpstreamFailure(logger: Logger, failure: UpstreamFailure): void {
  const context: Record<string, unknown> = { upstream: failure.upstream };
  if (failure.method) context.method = failure.method.toUpperCase();
  const path = pathOnly(failure.path);
  if (path) context.path = path;
  if (failure.status !== undefined) context.status = failure.status;
  if (failure.code) context.code = failure.code;
  if (failure.host) context.host = failure.host;
  logger.error("Upstream call failed; details withheld from caller", context);
}

interface AxiosConfigLike {
  method?: string;
  url?: string;
  baseURL?: string;
}

/**
 * Build an UpstreamFailure from an axios-style error or a raw axios response
 * (both carry `config`). Reads only status, code, method, and url.
 */
export function describeAxiosFailure(error: unknown, upstream: string): UpstreamFailure {
  const e = error as {
    code?: unknown;
    status?: unknown;
    response?: { status?: number; config?: AxiosConfigLike };
    config?: AxiosConfigLike;
  };
  const config = e.config ?? e.response?.config;
  const status = e.response?.status ?? (typeof e.status === "number" ? e.status : undefined);
  const failure: UpstreamFailure = {
    upstream,
    method: config?.method,
    path: config?.url,
    status,
  };
  if (status === undefined) {
    if (typeof e.code === "string") failure.code = e.code;
    const url = config?.url;
    failure.host = hostOnly(url && SCHEME_HOST.test(url) ? url : config?.baseURL);
  }
  return failure;
}

const sharedLogger = createLogger("access-mcp-shared");

export interface HandleApiErrorOptions {
  /** Which upstream this call went to, for the failure log line. */
  upstream?: string;
  logger?: Logger;
}

export function handleApiError(error: unknown, options: HandleApiErrorOptions = {}): string {
  const axiosError = error as AxiosErrorLike;
  const status = axiosError.status ?? axiosError.response?.status;
  const safe = callerSafeUpstreamError(status, axiosError.body ?? axiosError.response?.data);
  if (safe) return safe.message;
  // A DrupalApiError was already logged where it was raised.
  const log = () => {
    if (error instanceof Error && error.name === "DrupalApiError") return;
    logUpstreamFailure(
      options.logger ?? sharedLogger,
      describeAxiosFailure(error, options.upstream ?? "unspecified")
    );
  };
  if (axiosError.response?.status) {
    log();
    return `API error: ${axiosError.response.status} ${axiosError.response.statusText}`;
  }
  // A transport failure's text names internal hosts and ports.
  if (axiosError.isAxiosError) {
    log();
    return "Could not reach the upstream service";
  }
  if (error instanceof Error) {
    return error.message;
  }
  return "Unknown API error";
}

/**
 * LLM-Friendly Response Utilities
 *
 * These utilities help create responses that guide LLMs through multi-step workflows,
 * provide clear next actions, and improve error handling.
 */

export interface NextStep {
  action: string;
  description: string;
  tool?: string;
  parameters?: Record<string, unknown>;
}

export interface LLMResponse<T = unknown> {
  data?: T;
  count?: number;
  next_steps?: NextStep[];
  suggestions?: string[];
  related_tools?: string[];
  context?: Record<string, unknown>;
}

export interface LLMError {
  error: string;
  error_type: "validation" | "not_found" | "api_error" | "invalid_parameter";
  suggestions?: string[];
  next_steps?: NextStep[];
  did_you_mean?: string[];
  related_queries?: string[];
}

/**
 * Add helpful next steps to a successful response
 */
export function addNextSteps<T>(data: T, nextSteps: NextStep[]): LLMResponse<T> {
  return {
    data,
    next_steps: nextSteps,
  };
}

/**
 * Create an LLM-friendly error response with suggestions
 */
export function createLLMError(
  error: string,
  errorType: LLMError["error_type"],
  options: {
    suggestions?: string[];
    nextSteps?: NextStep[];
    didYouMean?: string[];
    relatedQueries?: string[];
  } = {}
): LLMError {
  return {
    error,
    error_type: errorType,
    ...options,
  };
}

/**
 * Add discovery suggestions when returning empty results
 */
export function addDiscoverySuggestions<T>(
  data: T[],
  discoverySteps: NextStep[]
): LLMResponse<T[]> {
  if (data.length === 0) {
    return {
      data,
      count: 0,
      next_steps: discoverySteps,
      suggestions: [
        "No results found. Try the suggested next steps to discover available options.",
      ],
    };
  }
  return {
    data,
    count: data.length,
  };
}

/**
 * Common next step templates for cross-server consistency
 */
export const CommonNextSteps = {
  discoverResources: {
    action: "discover_resources",
    description: "Find available compute resources to filter by",
    tool: "search_resources",
    parameters: { include_resource_ids: true },
  },

  narrowResults: (currentCount: number, suggestedFilters: string[]) => ({
    action: "narrow_results",
    description: `Currently showing ${currentCount} results. Add filters to narrow down: ${suggestedFilters.join(", ")}`,
  }),

  exploreRelated: (relatedTool: string, description: string) => ({
    action: "explore_related",
    description,
    tool: relatedTool,
  }),

  refineSearch: (suggestions: string[]) => ({
    action: "refine_search",
    description: `Try these refinements: ${suggestions.join(", ")}`,
  }),
};

/**
 * Resource ID Resolution Utilities
 *
 * These utilities help resolve human-readable resource names (e.g., "Anvil", "Delta")
 * to full resource IDs (e.g., "anvil.purdue.access-ci.org").
 */

export interface ResourceMatch {
  id: string;
  name: string;
}

export type ResolveResult =
  | { success: true; id: string }
  | { success: false; error: string; suggestion?: string };

/**
 * Resolve a human-readable name to a resource ID.
 *
 * @param input - The input string (name or ID)
 * @param searchFn - A function that searches for resources by name and returns matches
 * @returns ResolveResult with either the resolved ID or an error message
 *
 * @example
 * ```ts
 * const result = await resolveResourceId("Anvil", async (query) => {
 *   const resources = await searchResources({ query });
 *   return resources.map(r => ({ id: r.id, name: r.name }));
 * });
 *
 * if (result.success) {
 *   console.log(result.id); // "anvil.purdue.access-ci.org"
 * } else {
 *   console.log(result.error); // "Multiple resources match..."
 * }
 * ```
 */
export async function resolveResourceId(
  input: string,
  searchFn: (query: string) => Promise<ResourceMatch[]>
): Promise<ResolveResult> {
  // Guard against undefined/null input
  if (!input) {
    return {
      success: false,
      error: "Resource ID is required",
      suggestion: "Use search_resources to find valid resource names.",
    };
  }

  // If it already looks like a full resource ID (contains dots), return as-is
  if (input.includes(".")) {
    return { success: true, id: input };
  }

  // Search for the resource by name
  const items = await searchFn(input);

  if (items.length === 0) {
    return {
      success: false,
      error: `No resource found matching '${input}'`,
      suggestion: "Use the search tool to find valid resource names.",
    };
  }

  // Find exact name match first (case-insensitive)
  const inputLower = input.toLowerCase();
  const exactMatch = items.find((item) => item.name?.toLowerCase() === inputLower);

  if (exactMatch && exactMatch.id) {
    return { success: true, id: exactMatch.id };
  }

  // Multiple partial matches - ask user to be more specific
  if (items.length > 1) {
    const names = items.map((i) => i.name).join(", ");
    return {
      success: false,
      error: `Multiple resources match '${input}': ${names}`,
      suggestion: "Please specify the exact resource name.",
    };
  }

  // Single partial match - use it
  if (items[0].id) {
    return { success: true, id: items[0].id };
  }

  return {
    success: false,
    error: `Could not resolve resource '${input}'`,
  };
}
