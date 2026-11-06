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
    data?: { message?: string };
    status?: number;
    statusText?: string;
  };
  message?: string;
  // DrupalApiError carries these directly instead of on `response`.
  status?: number;
  body?: { message?: unknown };
}

export function handleApiError(error: unknown): string {
  const axiosError = error as AxiosErrorLike;
  if (axiosError.response?.data?.message) {
    return axiosError.response.data.message;
  }
  // Drupal's message on a 4xx is written for the user, like "You are already
  // registered." A 5xx body can carry internal exception text, so it stays out.
  const { status, body } = axiosError;
  if (
    status &&
    status >= 400 &&
    status < 500 &&
    body?.message &&
    typeof body.message === "string"
  ) {
    return body.message;
  }
  if (axiosError.response?.status) {
    return `API error: ${axiosError.response.status} ${axiosError.response.statusText}`;
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
