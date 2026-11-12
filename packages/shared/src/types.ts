// Universal search parameters (all servers)
export interface UniversalSearchParams {
  query?: string;
  id?: string;
  type?: string;
  tags?: string[];
  date?: "today" | "upcoming" | "past" | "this_week" | "this_month";
  limit?: number;
  offset?: number;
  sort?: string;
  order?: "asc" | "desc";
}

// Universal response format (all servers)
export interface UniversalResponse<T> {
  total: number;
  items: T[];
}

// Extended response with hints
export interface UniversalResponseWithHints<T> extends UniversalResponse<T> {
  hints?: {
    next?: string;
    tags?: string[];
  };
}

// Tool-catalog envelope (Pillar 1 — see docs/2026-05-12-tool-catalog-architecture.md).
// Listing-shaped responses adopt this shape; metadata.* and documentation.* fields are
// present when meaningful and absent when not (e.g. metadata.pagination is omitted for
// lookup-by-id handlers where the caller's input bounds the universe).
export interface StandardToolResponse<T> extends UniversalResponse<T> {
  metadata?: {
    query?: string;
    filters_applied?: Record<string, unknown>;
    aggregations?: {
      popular_tags?: string[];
      top_resources?: Array<{ name: string; count: number }>;
      counts?: Record<string, number>;
      [key: string]: unknown;
    };
    pagination?: {
      limit: number;
      offset: number;
      has_more: boolean;
      total?: number;
      total_lower_bound?: number;
      capped?: true;
      truncated?: true;
    };
    query_relevance?: "exact" | "loose_match";
    [key: string]: unknown;
  };
  documentation?: {
    usage_notes?: string;
    next_steps?: Array<{ tool?: string; description?: string; [key: string]: unknown }>;
    related_tools?: string[];
    links?: Record<string, string>;
  };
}

// Standard error response — nested error{code,message,hint} so the shape
// mirrors the success envelope's {action,status,executed,data}.
export interface StandardErrorResponse {
  action?: string;
  status: "error";
  executed: false;
  error: {
    code: string;
    message: string;
    hint?: string;
  };
}

// Standard write response envelope (register/cancel/create/update/delete tools)
export interface StandardWriteResponse {
  action: "register" | "cancel" | "create" | "update" | "delete" | "create_ticket";
  status: string;
  executed: boolean;
  data?: Record<string, unknown>;
  warning?: string;
}
