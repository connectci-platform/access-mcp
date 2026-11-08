import {
  BaseAccessServer,
  handleApiError,
  silentLogger,
  callerSafeUpstreamError,
  describeAxiosFailure,
  logUpstreamFailure,
  projectFields,
  Resource,
  CallToolResult,
  type ToolWithAccess,
} from "@access-mcp/shared";
import { CallToolRequest } from "@modelcontextprotocol/sdk/types.js";
import axios, { AxiosInstance } from "axios";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const { version } = require("../package.json");

const UKY_HOST = "https://access-ai-grace1-external.ccs.uky.edu";
const DEFAULT_RETRIEVE_URL = `${UKY_HOST}/access/chat-mcp/api/retrieve-docs`;

interface SearchDocsArgs {
  query?: string;
  rp_name?: string;
  fields?: string[];
}

interface DocChunk {
  rank: number;
  text: string;
  url: string;
}

export class DocumentationServer extends BaseAccessServer {
  private _docsHttpClient?: AxiosInstance;

  constructor() {
    super("access-mcp-documentation", version, UKY_HOST);
  }

  /**
   * Override the base httpClient to talk to UKY. The base client targets
   * support.access-ci.org with a Bearer token; UKY uses X-API-KEY (only
   * when ACCESS_AI_API_KEY is set server-side) and X-Origin. The key is a
   * server-side deployment secret — absent it, we simply send no auth
   * header and let UKY respond (currently a 401).
   */
  protected get httpClient(): AxiosInstance {
    if (!this._docsHttpClient) {
      const headers: Record<string, string> = {
        "User-Agent": `${this.serverName}/${this.version}`,
        "Content-Type": "application/json",
        "X-Origin": "access-mcp-documentation",
      };
      const apiKey = process.env.ACCESS_AI_API_KEY;
      if (apiKey) {
        headers["X-API-KEY"] = apiKey;
      }
      this._docsHttpClient = axios.create({
        baseURL: this.baseURL,
        timeout: 30000,
        headers,
        validateStatus: () => true, // inspect non-2xx in the handler
      });
    }
    return this._docsHttpClient;
  }

  private get retrieveUrl(): string {
    return process.env.ACCESS_DOCS_RETRIEVE_URL || DEFAULT_RETRIEVE_URL;
  }

  protected getTools(): ToolWithAccess[] {
    return [
      {
        name: "search_docs",
        mutates: false,
        description:
          "Search the ACCESS-CI documentation corpus for how-tos, policies, " +
          "concepts, hardware/software references, allocation process, Globus, " +
          "MFA, identity, and similar reference material. Returns ranked " +
          "excerpts with source URLs; synthesize an answer from them and cite " +
          "the URLs. Pass rp_name to scope to a specific resource provider. " +
          "Note: responses can be large (tens of KB) — use 'fields' to project " +
          "to ['total','items[].url'] when you only need source links, or " +
          "['total','items[].text'] when you need the prose.",
        inputSchema: {
          type: "object",
          properties: {
            query: {
              type: "string",
              description:
                "Natural-language question or topic. Pass the user's actual " +
                "question, not a keyword distillation.",
            },
            rp_name: {
              type: "string",
              description:
                "Optional resource provider slug (e.g. 'delta', 'anvil', " +
                "'bridges-2', 'expanse') to scope the search to that RP's " +
                "documentation. Leave unset for cross-resource or general " +
                "questions. Invalid slugs return a 400 error.",
            },
            fields: {
              type: "array",
              items: { type: "string" },
              description:
                "Project the response down to only these fields. Dotted path " +
                "syntax: 'total', 'items[].url', 'items[].text', " +
                "'items[].rank', 'metadata.query_id'. Use to reduce payload " +
                "size when you only need specific fields. Omit for the full response.",
            },
          },
          required: ["query"],
        },
        _meta: {
          supportsFieldProjection: true,
        },
      },
    ];
  }

  protected getResources(): Resource[] {
    return [];
  }

  protected async handleToolCall(request: CallToolRequest): Promise<CallToolResult> {
    const { name, arguments: args = {} } = request.params;
    try {
      switch (name) {
        case "search_docs":
          return await this.searchDocs(args as SearchDocsArgs);
        default:
          return this.errorResponse(`Unknown tool: ${name}`);
      }
    } catch (error) {
      return this.errorResponse(handleApiError(error));
    }
  }

  private async searchDocs(args: SearchDocsArgs): Promise<CallToolResult> {
    const { query, rp_name, fields } = args;

    if (!query || !query.trim()) {
      return this.errorResponse("query is required", { hint: "Pass the user's natural-language question." });
    }

    const body: Record<string, string> = { query };
    if (rp_name) body.rp_name = rp_name;

    // X-Origin doubles as an analytics/scoping signal: scoped queries send
    // the RP slug, matching access-agent's uky_client.retrieve().
    const config = rp_name ? { headers: { "X-Origin": rp_name } } : undefined;

    // With validateStatus: () => true, HTTP error *statuses* don't throw —
    // they're inspected below. A throw here means a network/timeout failure;
    // surface the spec's retry-able message rather than a raw axios string.
    let response;
    try {
      response = await this.httpClient.post(this.retrieveUrl, body, config);
    } catch (error) {
      // Only the error code and target host are logged, never its message.
      logUpstreamFailure(this.logger, {
        ...describeAxiosFailure(error, "uky"),
        method: "POST",
        path: this.retrieveUrl,
        host: hostOf(this.retrieveUrl),
      });
      return this.errorResponse(
        "Documentation search failed; try another approach.",
        { hint: "The documentation backend did not respond (network or timeout error)." }
      );
    }

    if (response.status < 200 || response.status >= 300) {
      logUpstreamFailure(this.logger, {
        upstream: "uky",
        method: "POST",
        path: this.retrieveUrl,
        status: response.status,
      });
    }

    if (response.status === 401) {
      return this.errorResponse(
        "Documentation search is currently unavailable (auth).",
        { hint: "The server-side ACCESS_AI_API_KEY is missing or was rejected by UKY." }
      );
    }
    if (response.status === 400) {
      return this.errorResponse(
        "Invalid documentation search request.",
        { hint: "Check the rp_name slug — an unknown resource provider returns 400." }
      );
    }
    if (response.status < 200 || response.status >= 300) {
      // The response is passed without its body so handleApiError cannot read
      // a 5xx body's text either.
      const safe = callerSafeUpstreamError(response.status, response.data);
      return this.errorResponse(
        safe?.message ??
          handleApiError(
            {
              response: { status: response.status, statusText: response.statusText },
            },
            // Already logged above, with the path.
            { logger: silentLogger }
          )
      );
    }

    const data = (response.data ?? {}) as {
      documents?: Array<{ text?: string; url?: string }>;
      top_documents?: Array<{ text?: string; url?: string }>;
      query_id?: string;
    };

    // /api/retrieve-docs returns `documents`; the legacy synthesis endpoint
    // returned `top_documents`. Accept both so a URL revert via env doesn't
    // zero out retrieval. Key-presence, not truthiness, so an explicit
    // empty `documents: []` doesn't fall through to a stale `top_documents`.
    const rawDocs =
      "documents" in data
        ? data.documents ?? []
        : data.top_documents ?? [];

    const items: DocChunk[] = rawDocs.map((doc, i) => ({
      rank: i + 1, // UKY omits rank; derive from list position.
      text: doc.text ?? "",
      url: doc.url ?? "",
    }));

    const envelope = {
      total: items.length,
      items,
      metadata: {
        filters_applied: { rp_name: rp_name ?? null },
        query,
        ...(data.query_id ? { query_id: data.query_id } : {}),
      },
      ...(items.length === 0
        ? {
            documentation: {
              usage_notes:
                "No documentation excerpts matched. Try rephrasing the query or removing rp_name.",
            },
          }
        : {}),
    };

    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(projectFields(envelope, fields), null, 2),
        },
      ],
    };
  }
}

function hostOf(url: string): string | undefined {
  try {
    return new URL(url).host;
  } catch {
    return undefined;
  }
}
