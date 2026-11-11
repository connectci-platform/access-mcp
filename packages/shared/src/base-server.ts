import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import {
  CallToolRequestSchema,
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
  Tool,
  Resource,
  Prompt,
  CallToolResult,
  ReadResourceResult,
  GetPromptResult,
  CallToolRequest,
  ReadResourceRequest,
  GetPromptRequest,
  isInitializeRequest,
} from "@modelcontextprotocol/sdk/types.js";
import axios, { AxiosInstance } from "axios";
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { IncomingMessage, Server as HttpServer, ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { createLogger, Logger } from "./logger.js";
import { callerSafeUpstreamError, describeAxiosFailure, logUpstreamFailure } from "./utils.js";
// Safe direction: drupal-auth depends only on logger, never on base-server.
import { DrupalApiError } from "./drupal-auth.js";
import { traceMcpToolCall } from "./telemetry.js";
import { UsageLogger } from "./usage-logger.js";
import {
  ActingUserTokenUnavailableError,
  ActingUserTokenVerifier,
  actingUserTokenConfigFromEnv,
  type ActingUserTokenConfig,
} from "./acting-user-token.js";
import { StandardWriteResponse, StandardErrorResponse } from "./types.js";
import {
  isCallAuthorized,
  classifyTool,
  toClientTools,
  assertToolMarkers,
  type ToolWithAccess,
} from "./tool-access.js";

// Re-export SDK types for convenience
export type { Tool, Resource, Prompt, CallToolResult, ReadResourceResult, GetPromptResult };

/**
 * Request context passed via AsyncLocalStorage for per-request data.
 * This allows tool handlers to access request-scoped data like the acting user
 * without needing to thread it through every function call.
 */
export interface RequestContext {
  /**
   * The ACCESS ID of the user performing the action.
   * Format: "username@access-ci.org"
   *
   * On a server that acts for users (actsForUsers), the /tools route takes it
   * from a verified acting-user token's sub, or (until MCP_ACTING_USER_AUTH is
   * "token") from the X-Acting-User header. Elsewhere it is the header, used
   * only for usage attribution.
   */
  actingUser?: string;
  /** How actingUser was established on /tools: a verified token, or the header. */
  actingUserAuth?: "token" | "header";
  /** The verified acting-user token, forwarded on server-to-server calls. */
  actingUserToken?: string;
  /**
   * The signed-in account's email and name from the verified token, when the
   * portal included them. Only set when actingUserAuth is "token".
   */
  actingUserProfile?: { email?: string; name?: string };
  /** Unique request ID for tracing (from X-Request-ID header) */
  requestId?: string;
  /**
   * The caller keeps a tool's structuredContent out of the model's context
   * (X-Include-Structured-Content: 1). Only the /tools route sets it, so MCP
   * hosts that may hand structuredContent to their model never receive it.
   */
  includeStructuredContent?: boolean;
}

/** AsyncLocalStorage instance for request context */
export const requestContextStorage = new AsyncLocalStorage<RequestContext>();

/**
 * Get the current request context. Returns undefined if called outside a request.
 */
export function getRequestContext(): RequestContext | undefined {
  return requestContextStorage.getStore();
}

/**
 * Get the acting user's ACCESS ID from the current request context.
 * Throws an error if no acting user is set - use this for operations that require attribution.
 */
export function getActingUser(): string {
  const context = getRequestContext();
  if (!context?.actingUser) {
    throw new Error(
      "No acting user specified. The X-Acting-User header must be set to the ACCESS ID " +
        "(username@access-ci.org) of the person performing this action."
    );
  }
  return context.actingUser;
}

/**
 * Options for BaseAccessServer constructor
 */
export interface BaseAccessServerOptions {
  /**
   * Require API key authentication for tool execution endpoints.
   * When enabled, requests to /tools/:toolName must include a valid
   * X-Api-Key header matching the MCP_API_KEY environment variable.
   * Enable this for servers that perform write operations on behalf of users.
   */
  requireApiKey?: boolean;
  /**
   * The server's tools act as the signed-in researcher (writes and user-scoped
   * reads), so /tools verifies the acting-user token the agent sends instead of
   * trusting X-Acting-User. See acting-user-token.ts and MCP_ACTING_USER_AUTH.
   * Leave it off for servers that act only on their own service account.
   */
  actsForUsers?: boolean;
  /**
   * With actsForUsers in token mode, a call carrying X-Acting-User but no
   * token is let through on the header path (actingUserAuth "header")
   * instead of refused, so the tool can treat the ACCESS ID as an unconfirmed
   * hint. For jsm (D8-3069): a ticket still gets filed, marked unverified,
   * when the portal's token exchange is down.
   */
  headerOnlyIsUnverified?: boolean;
}

/** ACCESS_MCP_SERVICES names of the servers constructed with actsForUsers. */
export const ACTING_USER_SERVICES: ReadonlySet<string> = new Set([
  "events",
  "announcements",
  "allocations",
  "jsm",
]);

type ActingUserResolution =
  | {
      ok: true;
      actingUser?: string;
      auth?: "token" | "header";
      token?: string;
      profile?: { email?: string; name?: string };
    }
  | { ok: false; status: 401 | 503; error: string };

export abstract class BaseAccessServer {
  protected server: Server;
  protected transport: StdioServerTransport;
  protected logger: Logger;
  private _httpClient?: AxiosInstance;
  private _httpApp?: Hono;
  private _httpPort?: number;
  private _streamableTransports: Map<string, WebStandardStreamableHTTPServerTransport> = new Map();
  private _sseTransports: Map<string, SSEServerTransport> = new Map();
  private _requireApiKey: boolean;
  private _actsForUsers: boolean;
  private _headerOnlyIsUnverified: boolean;
  private _actingUserConfig?: ActingUserTokenConfig;
  private _actingUserVerifier?: ActingUserTokenVerifier;
  private _nodeServer?: HttpServer;
  private _usageLogger = new UsageLogger(process.env.MCP_USAGE_DB_URL);

  constructor(
    protected serverName: string,
    protected version: string,
    protected baseURL: string = "https://support.access-ci.org/api",
    options: BaseAccessServerOptions = {}
  ) {
    this._requireApiKey = options.requireApiKey ?? false;
    this._actsForUsers = options.actsForUsers ?? false;
    this._headerOnlyIsUnverified = options.headerOnlyIsUnverified ?? false;
    // Note: Telemetry is initialized via --import flag in the Dockerfile
    // This ensures OpenTelemetry is set up BEFORE http modules are imported
    // See packages/shared/src/telemetry-bootstrap.ts

    this.logger = createLogger(serverName);
    this.server = new Server(
      {
        name: serverName,
        version: version,
      },
      {
        capabilities: {
          resources: {},
          tools: {},
          prompts: {},
        },
      }
    );

    this.transport = new StdioServerTransport();
    this.setupHandlers();
  }

  protected get httpClient(): AxiosInstance {
    if (!this._httpClient) {
      const headers: Record<string, string> = {
        "User-Agent": `${this.serverName}/${this.version}`,
      };

      // Add authentication if API key is provided
      const apiKey = process.env.ACCESS_CI_API_KEY;
      if (apiKey) {
        headers["Authorization"] = `Bearer ${apiKey}`;
      }

      this._httpClient = axios.create({
        baseURL: this.baseURL,
        timeout: 5000,
        headers,
        validateStatus: () => true, // Don't throw on HTTP errors
      });
    }
    return this._httpClient;
  }

  private setupHandlers() {
    this.setupServerHandlers(this.server);
  }

  protected abstract getTools(): ToolWithAccess[];
  protected abstract getResources(): Resource[];
  protected abstract handleToolCall(request: CallToolRequest): Promise<CallToolResult>;

  /**
   * The single logging seam for tool calls. EVERY doorway (REST /tools, the
   * MCP-protocol /mcp + /sse handlers) must call this instead of handleToolCall
   * directly, so usage logging and tracing cover all paths with no duplication.
   * Timing + fire-and-forget record; never awaited, never throws into the caller.
   * (If you add a new tool-invocation path, route it through here.)
   */
  private async recordAndHandle(request: CallToolRequest): Promise<CallToolResult> {
    const { name, arguments: args } = request.params;
    const tool = this.getTools().find((t) => t.name === name);
    const startedAt = Date.now();
    let succeeded = false;
    try {
      return await traceMcpToolCall(
        name,
        args ?? {},
        async (span) => {
          span.setAttribute("mcp.server.name", this.serverName);
          span.setAttribute("mcp.server.version", this.version);

          const requestId = requestContextStorage.getStore()?.requestId;
          if (requestId) {
            span.setAttribute("mcp.request.id", requestId);
          }
          const actingUserAuth = requestContextStorage.getStore()?.actingUserAuth;
          if (actingUserAuth) {
            span.setAttribute("mcp.acting_user.auth", actingUserAuth);
          }

          const result = await this.handleToolCall(request);
          succeeded = !result.isError;
          if (result.isError) {
            span.setAttribute("mcp.result.is_error", true);
          }
          return result;
        },
        // Telemetry leaves our infrastructure, so only public reads record values.
        { recordArguments: !!tool && classifyTool(tool) === "public" && !tool.mutates }
      );
    } finally {
      void this._usageLogger.record({
        server: this.serverName,
        tool: name,
        args: args as Record<string, unknown> | undefined,
        success: succeeded,
        durationMs: Date.now() - startedAt,
        actingUser: requestContextStorage.getStore()?.actingUser,
        unverified:
          this._headerOnlyIsUnverified &&
          requestContextStorage.getStore()?.actingUserAuth === "header",
      });
    }
  }

  /**
   * Get available prompts - override in subclasses to provide prompts
   */
  protected getPrompts(): Prompt[] {
    return [];
  }

  /**
   * Handle resource read requests - override in subclasses
   */
  protected async handleResourceRead(request: ReadResourceRequest): Promise<ReadResourceResult> {
    throw new Error(`Resource reading not supported by this server: ${request.params.uri}`);
  }

  /**
   * Handle get prompt requests - override in subclasses
   */
  protected async handleGetPrompt(request: GetPromptRequest): Promise<GetPromptResult> {
    throw new Error(`Prompt not found: ${request.params.name}`);
  }

  /**
   * Structural links to attach to tool responses, by call context.
   *
   * Default returns undefined. Subclasses override to surface human-facing
   * landing-page URLs alongside structured data so consumers (the agent,
   * other MCP clients) can point users at a place to browse — especially
   * useful when results are empty.
   *
   * Use 'list' for unfiltered listings, 'search' for filtered queries
   * (returning a "see all" pointer is helpful here even on zero hits),
   * and 'details' for single-item lookups.
   */
  protected listingLinks(
    _context: "list" | "search" | "details" = "list"
  ): Record<string, string> | undefined {
    return undefined;
  }

  /**
   * Helper method to create a standard error response (MCP 2025 compliant).
   * Emits the same nested envelope shape as writeResponse's success case —
   * {action?, status:"error", executed:false, error:{code,message,hint?}} —
   * so every tool speaks one response shape regardless of outcome.
   * @param message The error message
   * @param opts Optional code, hint, and action to attach
   */
  protected errorResponse(
    message: string,
    opts: { code?: string; hint?: string; action?: string } = {}
  ): CallToolResult {
    const body: StandardErrorResponse = {
      ...(opts.action && { action: opts.action }),
      status: "error",
      executed: false,
      error: { code: opts.code ?? "error", message, ...(opts.hint && { hint: opts.hint }) },
    };
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(body),
        },
      ],
      isError: true,
    };
  }

  /**
   * Map a PERSISTENT Drupal authentication failure onto the standard error
   * envelope. Returns null for anything else, so callers keep their own
   * handling for ordinary errors:
   *
   *   } catch (error) {
   *     const authError = this.drupalAuthError(error);
   *     if (authError) return authError;
   *     ...existing handling...
   *   }
   *
   * Two distinct outcomes, and the difference matters to whoever reads the
   * message:
   *
   *  - A 3xx — Drupal bounced an authenticated request to the CILogon login
   *    page because the session was rejected. DrupalAuthProvider keeps this a
   *    raw 3xx (maxRedirects:0) rather than following it and returning login
   *    HTML as a fake 200. The provider already re-logs-in and retries once, so
   *    a 3xx arriving here means recovery did not stick → "unauthenticated",
   *    and re-authenticating is the right advice.
   *  - code "reauth_failed" — the re-login itself failed, so the service
   *    credentials or Drupal are broken. No retry or restart helps; this needs
   *    an operator, and saying "try again" would be misleading.
   *
   * Lives here rather than in one server because every Drupal-backed server
   * (announcements, allocations, events) hits the identical failure and used to
   * leak the raw "Drupal API error: 307 Temporary Redirect" text instead.
   */
  protected drupalAuthError(error: unknown): CallToolResult | null {
    if (!(error instanceof DrupalApiError)) return null;

    if (error.code === "reauth_failed") {
      return this.errorResponse(error.message, {
        code: "reauth_failed",
        hint: "The service could not re-authenticate with Drupal. This needs an operator, not a retry.",
      });
    }

    if (error.code === "auth_redirect_after_relogin") {
      return this.errorResponse(
        "The ACCESS site could not complete this request. It sent the request to its sign-in page even though the service had just signed in.",
        {
          code: "upstream_error",
          hint: "Signing in again will not help. This needs an operator; try again later.",
        }
      );
    }

    return this.authRedirectError(error.status);
  }

  /**
   * The status-based half of drupalAuthError, for callers holding a raw status
   * rather than a thrown error — the non-throwing requestRaw accessor returns
   * { status, data }, so those paths branch on the number directly.
   *
   * A 3xx means Drupal rejected the session and bounced to the CILogon login
   * page. Returns null for every non-redirect status so callers fall through to
   * their own handling. Single source of the message shared with drupalAuthError.
   */
  protected authRedirectError(status: number): CallToolResult | null {
    if (status >= 300 && status < 400) {
      return this.errorResponse(
        "Authentication required: your ACCESS session may have expired.",
        { code: "unauthenticated", hint: "Re-authenticate the ACCESS connector and try again." }
      );
    }
    return null;
  }

  /**
   * Helper method to create a standard write response envelope.
   * A write result is never an error; failures go through errorResponse.
   * @param r The write response envelope
   */
  protected writeResponse(r: StandardWriteResponse): CallToolResult {
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(r),
        },
      ],
    };
  }

  /**
   * Helper method to create a JSON resource response
   * @param uri The resource URI
   * @param data The data to return as JSON
   */
  protected createJsonResource(uri: string, data: unknown) {
    return {
      contents: [
        {
          uri,
          mimeType: "application/json",
          text: JSON.stringify(data, null, 2),
        },
      ],
    };
  }

  /**
   * Helper method to create a Markdown resource response
   * @param uri The resource URI
   * @param markdown The markdown content
   */
  protected createMarkdownResource(uri: string, markdown: string) {
    return {
      contents: [
        {
          uri,
          mimeType: "text/markdown",
          text: markdown,
        },
      ],
    };
  }

  /**
   * Helper method to create a text resource response
   * @param uri The resource URI
   * @param text The plain text content
   */
  protected createTextResource(uri: string, text: string) {
    return {
      contents: [
        {
          uri,
          mimeType: "text/plain",
          text: text,
        },
      ],
    };
  }

  /**
   * Start the MCP server with optional HTTP service layer for inter-server communication
   */
  async start(options?: { httpPort?: number }) {
    // Before any transport opens: a tool without its markers must stop the
    // server, not be listed. listToolsForClient is wrapped in try/catch, so a
    // check there would only empty the catalog.
    assertToolMarkers(this.getTools());
    // A setting that can't work stops the server rather than refusing writes.
    if (this._actsForUsers) {
      this.configureActingUserTokens();
      await this.checkActingUserKeys(options?.httpPort !== undefined);
    }
    // Start HTTP service layer if port is specified. Port 0 asks the OS for a
    // free port; read it back from `httpPort` once start() resolves.
    if (options?.httpPort !== undefined) {
      this._httpPort = options.httpPort;
      await this.startHttpService();
      this.logger.info("HTTP server running", { port: this._httpPort });
    } else {
      // Only connect stdio transport when NOT in HTTP mode
      await this.server.connect(this.transport);
      // MCP servers should not output anything to stderr/stdout when running
      // as it interferes with JSON-RPC communication
    }
  }

  /** The bound HTTP port, which differs from the requested one when that was 0. */
  get httpPort(): number | undefined {
    return this._httpPort;
  }

  /**
   * Stop the HTTP server (useful in tests to free ports between test runs)
   */
  async stop(): Promise<void> {
    if (this._nodeServer) {
      this._nodeServer.closeAllConnections();
      return new Promise((resolve, reject) => {
        this._nodeServer!.close((err) => {
          if (err) reject(err);
          else resolve();
        });
      });
    }
  }

  /**
   * Start HTTP service layer with Streamable HTTP support for remote MCP connections
   */
  private async startHttpService(): Promise<void> {
    if (this._httpPort === undefined) return;

    const app = new Hono();
    this._httpApp = app;

    // Optional Bearer token extraction for OAuth-authenticated MCP clients.
    // If a Bearer token is present, verify it via CILogon userinfo and
    // populate RequestContext.actingUser. Never rejects — lets tools decide.
    //
    // Not on /tools: that route builds its own context, and a Bearer there is
    // the portal's acting-user token, which must never be sent to CILogon.
    const oauthVerifyUrl = process.env.OAUTH_VERIFY_URL;
    if (oauthVerifyUrl) {
      app.use("*", async (c, next) => {
        if (c.req.path === "/tools" || c.req.path.startsWith("/tools/")) {
          return next();
        }
        const authHeader = c.req.header("Authorization");
        if (authHeader?.startsWith("Bearer ")) {
          const token = authHeader.slice(7);
          try {
            const verifyResponse = await axios.post(
              oauthVerifyUrl,
              {},
              { headers: { Authorization: `Bearer ${token}` }, timeout: 5000, validateStatus: () => true }
            );
            const extra = verifyResponse.data?.extra;
            if (verifyResponse.status === 200 && extra && (extra.sub || extra.eppn || extra.email)) {
              const context: RequestContext = {
                // With ACCESS OIDC config, sub is the ACCESS ID (user@access-ci.org)
                actingUser: extra.sub || extra.eppn || extra.email,
                requestId: c.req.header("X-Request-ID") || randomUUID(),
              };
              return requestContextStorage.run(context, () => next());
            }
          } catch {
            // Token verification failed — continue without identity
            this.logger.debug("Bearer token verification failed, continuing unauthenticated");
          }
        }
        await next();
      });
    }

    // Health check endpoint
    app.get("/health", (c) => {
      return c.json({
        server: this.serverName,
        version: this.version,
        status: "healthy",
        timestamp: new Date().toISOString(),
      });
    });

    // Streamable HTTP endpoint for MCP connections
    // Handles POST (messages), GET (SSE stream), DELETE (session cleanup)
    // Uses WebStandardStreamableHTTPServerTransport — handles Web Standard
    // Request/Response directly, avoiding the Node↔WebStandard double conversion
    // that caused content-length to be added to SSE responses.
    app.all("/mcp", async (c) => {
      // Parse body for POST requests (needed for isInitializeRequest check,
      // the tool-aware auth decision below, and passed through as parsedBody
      // so the transport doesn't re-read the already-consumed stream).
      const body = c.req.method === "POST"
        ? await c.req.json().catch(() => null)
        : undefined;

      // Validate API key / per-tool access for POST requests when requireApiKey is enabled
      if (c.req.method === "POST" && this._requireApiKey) {
        const expectedApiKey = process.env.MCP_API_KEY;

        if (!expectedApiKey) {
          this.logger.error("MCP_API_KEY environment variable not set but requireApiKey is enabled");
          return c.json({ error: "Server misconfiguration: API key not configured" }, 500);
        }

        const providedApiKey = c.req.header("X-Api-Key");
        const authorized = isCallAuthorized({
          body,
          publicToolNames: this.publicToolNames(),
          hasValidKey: !!providedApiKey && providedApiKey === expectedApiKey,
          hasVerifiedActingUser: this.hasVerifiedActingUser(),
        });

        if (!authorized) {
          this.logger.warn("Unauthorized MCP request attempt", {
            hasKey: !!providedApiKey,
          });
          return c.json({ error: "Invalid or missing API key. This server requires authentication for the requested tool." }, 401);
        }
      }

      // Check for existing session
      const sessionId = c.req.header("mcp-session-id");
      let transport: WebStandardStreamableHTTPServerTransport;

      if (sessionId && this._streamableTransports.has(sessionId)) {
        transport = this._streamableTransports.get(sessionId)!;
      } else if (!sessionId && c.req.method === "POST") {
        // New session — check if this is an initialize request
        if (body && isInitializeRequest(body)) {
          this.logger.debug("New Streamable HTTP session");
          transport = new WebStandardStreamableHTTPServerTransport({
            sessionIdGenerator: () => randomUUID(),
            onsessioninitialized: (id: string) => {
              // Store transport once the session ID is assigned (during handleRequest)
              this._streamableTransports.set(id, transport);
              this.logger.debug("Streamable HTTP session initialized", { sessionId: id });
            },
          });

          // Create a new server instance for this session
          const mcpServer = new Server(
            {
              name: this.serverName,
              version: this.version,
            },
            {
              capabilities: {
                resources: {},
                tools: {},
                prompts: {},
              },
            }
          );

          this.setupServerHandlers(mcpServer);
          await mcpServer.connect(transport);

          // Clean up on close
          transport.onclose = () => {
            if (transport.sessionId) {
              this.logger.debug("Streamable HTTP session closed", { sessionId: transport.sessionId });
              this._streamableTransports.delete(transport.sessionId);
            }
          };
        } else {
          return c.json({ error: "Bad Request: First request must be an initialize request" }, 400);
        }
      } else if (sessionId) {
        // Session ID provided but not found
        return c.json({ error: "Session not found" }, 404);
      } else {
        // No session ID and not a POST initialize — tell client to initialize first
        return c.json({ error: "Bad Request: No session ID provided. Send an initialize request first." }, 400);
      }

      // The SDK's WebStandardStreamableHTTPServerTransport requires Accept
      // to include both application/json and text/event-stream. Clients
      // that send Accept: */* (which technically matches both) get a 406.
      // Fix by rewriting the request with the explicit Accept header.
      const accept = c.req.header("Accept") || "";
      let request = c.req.raw;
      if (!accept.includes("application/json") || !accept.includes("text/event-stream")) {
        const headers = new Headers(c.req.raw.headers);
        headers.set("Accept", "application/json, text/event-stream");
        request = new Request(c.req.url, {
          method: c.req.method,
          headers,
          body: c.req.method !== "GET" && c.req.method !== "HEAD" ? JSON.stringify(body) : undefined,
        });
      }

      return transport.handleRequest(request, { parsedBody: body });
    });

    // Legacy SSE endpoint for clients that don't support Streamable HTTP
    // (Claude Desktop via mcp-remote, older MCP clients)
    // Needs raw Node.js IncomingMessage/ServerResponse for SSEServerTransport.
    app.get("/sse", async (c) => {
      this.logger.debug("New SSE connection");

      // Use MCP_PATH_PREFIX env var to construct the correct messages path
      // when behind a reverse proxy that strips path prefixes (e.g., Caddy).
      const pathPrefix = process.env.MCP_PATH_PREFIX || "";
      // outgoing is provided by @hono/node-server's serve() adapter
      const { outgoing } = c.env as { outgoing: ServerResponse };
      const transport = new SSEServerTransport(`${pathPrefix}/messages`, outgoing);
      const sessionId = transport.sessionId;
      this._sseTransports.set(sessionId, transport);

      outgoing.on("close", () => {
        this.logger.debug("SSE connection closed", { sessionId });
        this._sseTransports.delete(sessionId);
      });

      const sseServer = new Server(
        { name: this.serverName, version: this.version },
        { capabilities: { resources: {}, tools: {}, prompts: {} } }
      );

      this.setupServerHandlers(sseServer);
      await sseServer.connect(transport);

      // Signal to @hono/node-server that the response is already handled
      // by SSEServerTransport — don't attempt to write headers again.
      return new Response(null, { headers: { "x-hono-already-sent": "1" } });
    });

    // Legacy messages endpoint for SSE transport
    // Note: the same tool-aware auth gate used on /mcp runs here too — this
    // is the second (SSE) transport door, and it closes on the gate below,
    // not on fail-closed acting-user checks deeper in the write path.
    app.post("/messages", async (c) => {
      const body = await c.req.json().catch(() => null);

      if (this._requireApiKey) {
        const expectedApiKey = process.env.MCP_API_KEY;
        if (!expectedApiKey) {
          this.logger.error("MCP_API_KEY environment variable not set but requireApiKey is enabled");
          return c.json({ error: "Server misconfiguration: API key not configured" }, 500);
        }
        const providedApiKey = c.req.header("X-Api-Key");
        const authorized = isCallAuthorized({
          body,
          publicToolNames: this.publicToolNames(),
          hasValidKey: !!providedApiKey && providedApiKey === expectedApiKey,
          hasVerifiedActingUser: this.hasVerifiedActingUser(),
        });
        if (!authorized) {
          this.logger.warn("Unauthorized /messages request attempt", { hasKey: !!providedApiKey });
          return c.json({ error: "Invalid or missing API key. This server requires authentication for the requested tool." }, 401);
        }
      }

      const sessionId = c.req.query("sessionId");
      if (!sessionId) {
        return c.json({ error: "Session ID required" }, 400);
      }
      const transport = this._sseTransports.get(sessionId);

      if (!transport) {
        return c.json({ error: "Session not found" }, 404);
      }

      // incoming/outgoing are provided by @hono/node-server's serve() adapter
      const { incoming, outgoing } = c.env as { incoming: IncomingMessage; outgoing: ServerResponse };
      await transport.handlePostMessage(incoming, outgoing, body);

      // Signal to @hono/node-server that the response is already handled
      // by SSEServerTransport — don't attempt to write headers again.
      return new Response(null, { headers: { "x-hono-already-sent": "1" } });
    });

    // List available tools endpoint (for inter-server communication)
    app.get("/tools", (c) => {
      try {
        const tools = this.listToolsForClient();
        return c.json({ tools });
      } catch (error) {
        return c.json({ error: "Failed to list tools" }, 500);
      }
    });

    // Tool execution endpoint (for inter-server communication)
    app.post("/tools/:toolName", async (c) => {
      // Validate API key if required
      if (this._requireApiKey) {
        const expectedApiKey = process.env.MCP_API_KEY;
        const providedApiKey = c.req.header("X-Api-Key");

        if (!expectedApiKey) {
          this.logger.error("MCP_API_KEY environment variable not set but requireApiKey is enabled");
          return c.json({ error: "Server misconfiguration: API key not configured" }, 500);
        }

        if (!providedApiKey || providedApiKey !== expectedApiKey) {
          this.logger.warn("Unauthorized tool call attempt", {
            tool: c.req.param("toolName"),
            hasKey: !!providedApiKey,
          });
          return c.json({ error: "Invalid or missing API key" }, 401);
        }
      }

      const toolName = c.req.param("toolName");
      const body = await c.req.json().catch(() => ({}));
      const { arguments: args = {} } = body;

      // Validate that the tool exists (before tracing to avoid noisy spans)
      const tools = this.getTools();
      const tool = tools.find((t) => t.name === toolName);
      if (!tool) {
        return c.json({ error: `Tool '${toolName}' not found` }, 404);
      }

      const acting: ActingUserResolution = this._actsForUsers
        ? await this.resolveActingUser(c.req.header("Authorization"), c.req.header("X-Acting-User"))
        : { ok: true, actingUser: c.req.header("X-Acting-User") };
      if (!acting.ok) {
        this.logger.warn("Acting user refused", {
          tool: toolName,
          status: acting.status,
          reason: acting.error,
        });
        const headers: Record<string, string> =
          acting.status === 401 ? { "WWW-Authenticate": 'Bearer error="invalid_token"' } : {};
        return c.json({ error: acting.error }, acting.status, headers);
      }
      if (this._actsForUsers && acting.actingUser) {
        // Which path each acting call took, so step 3 (token only) can be
        // flipped once no "header" lines remain. Writes and header-path calls
        // log at warn, which production keeps; token-path reads log at info.
        const level = tool.mutates || acting.auth === "header" ? "warn" : "info";
        this.logger[level]("Acting user auth", {
          tool: toolName,
          path: acting.auth,
          mutates: tool.mutates,
        });
      }

      const context: RequestContext = {
        actingUser: acting.actingUser,
        actingUserAuth: acting.auth,
        actingUserToken: acting.token,
        actingUserProfile: acting.ok ? acting.profile : undefined,
        requestId: c.req.header("X-Request-ID"),
        includeStructuredContent: c.req.header("X-Include-Structured-Content") === "1",
      };

      // Run the handler within the request context
      return requestContextStorage.run(context, async () => {
        try {
          const result = await this.recordAndHandle({
            method: "tools/call",
            params: {
              name: toolName,
              arguments: args,
            },
          });

          return c.json(result);
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : String(error);
          return c.json({ error: errorMessage }, 500);
        }
      });
    });

    // Start HTTP server using @hono/node-server
    return new Promise<void>((resolve, reject) => {
      const server = serve({
        fetch: app.fetch,
        hostname: "0.0.0.0",
        port: this._httpPort!,
      }, (info) => {
        this._httpPort = info.port;
        resolve();
      });
      this._nodeServer = server as unknown as HttpServer;
      server.on("error", reject);
    });
  }

  /**
   * Set up MCP handlers on a server instance
   */
  private setupServerHandlers(server: Server) {
    server.setRequestHandler(ListToolsRequestSchema, async () => {
      try {
        return { tools: this.listToolsForClient() };
      } catch (error: unknown) {
        return { tools: [] };
      }
    });

    server.setRequestHandler(ListResourcesRequestSchema, async () => {
      try {
        return { resources: this.getResources() };
      } catch (error: unknown) {
        return { resources: [] };
      }
    });

    server.setRequestHandler(CallToolRequestSchema, async (request) => {
      try {
        return await this.recordAndHandle(request);
      } catch (error: unknown) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        this.logger.error("Error handling tool call", { error: errorMessage });
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                error: errorMessage,
              }),
            },
          ],
          isError: true,
        };
      }
    });

    server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
      try {
        return await this.handleResourceRead(request);
      } catch (error: unknown) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        this.logger.error("Error reading resource", { error: errorMessage });
        return {
          contents: [
            {
              uri: request.params.uri,
              mimeType: "text/plain",
              text: `Error: ${errorMessage}`,
            },
          ],
        };
      }
    });

    server.setRequestHandler(ListPromptsRequestSchema, async () => {
      try {
        return { prompts: this.getPrompts() };
      } catch (error: unknown) {
        return { prompts: [] };
      }
    });

    server.setRequestHandler(GetPromptRequestSchema, async (request) => {
      try {
        return await this.handleGetPrompt(request);
      } catch (error: unknown) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        this.logger.error("Error getting prompt", { error: errorMessage });
        throw error;
      }
    });
  }

  /**
   * Call a tool on another ACCESS-CI MCP server via HTTP.
   * Automatically forwards acting user context from the current request.
   */
  protected async callRemoteServer(
    serviceName: string,
    toolName: string,
    args: Record<string, unknown> = {},
    options?: { timeoutMs?: number }
  ): Promise<unknown> {
    const serviceUrl = this.getServiceEndpoint(serviceName);
    if (!serviceUrl) {
      throw new Error(
        `Service '${serviceName}' not found. Check ACCESS_MCP_SERVICES environment variable.`
      );
    }

    // Forward acting user context to the remote server
    const context = getRequestContext();
    const headers: Record<string, string> = {};
    if (context?.actingUser) {
      headers["X-Acting-User"] = context.actingUser;
    }
    // Only a peer that acts for users needs the verified token, so it goes
    // nowhere else (allocations -> nsf-awards never sees it).
    if (context?.actingUserToken && ACTING_USER_SERVICES.has(serviceName)) {
      headers["Authorization"] = `Bearer ${context.actingUserToken}`;
    }
    if (context?.requestId) {
      headers["X-Request-ID"] = context.requestId;
    }
    // Inter-server API key. Required by peers configured with `requireApiKey: true`
    // (announcements, events, jsm); no-op for peers that don't check.
    const apiKey = process.env.MCP_API_KEY;
    if (apiKey) {
      headers["X-Api-Key"] = apiKey;
    }

    let response;
    try {
      response = await axios.post(
        `${serviceUrl}/tools/${toolName}`,
        {
          arguments: args,
        },
        {
          timeout: options?.timeoutMs ?? 30000,
          validateStatus: () => true,
          headers,
        }
      );
    } catch (error) {
      // The axios error carries config.headers (API key, acting user); log a
      // summary and throw a fresh Error so none of it travels with the throw.
      logUpstreamFailure(this.logger, {
        ...describeAxiosFailure(error, serviceName),
        method: "POST",
        path: `/tools/${toolName}`,
      });
      throw new Error("Remote server call failed: upstream unreachable");
    }

    if (response.status !== 200) {
      const safe = callerSafeUpstreamError(response.status, response.data);
      if (!safe) {
        logUpstreamFailure(this.logger, {
          ...describeAxiosFailure(response, serviceName),
          method: "POST",
          path: `/tools/${toolName}`,
        });
      }
      throw new Error(
        `Remote server call failed: ${response.status} ${safe?.message ?? response.statusText}`
      );
    }

    return response.data;
  }

  /** Tools as clients should see them: internal markers removed, write-ness as readOnlyHint. */
  protected listToolsForClient(): Tool[] {
    return toClientTools(this.getTools());
  }

  /** Public tool names for this server (default-deny classification). */
  private publicToolNames(): Set<string> {
    const names = new Set<string>();
    for (const tool of this.getTools()) {
      if (classifyTool(tool) === "public") names.add(tool.name);
    }
    return names;
  }

  /**
   * Reads the acting-user token settings and builds the verifier, once.
   * Throws for a setting that can't work.
   */
  /**
   * Startup checks that the token settings will actually work, so a broken
   * JWKS or a rotated kid shows in the log at boot, not as refused writes.
   */
  private async checkActingUserKeys(http: boolean): Promise<void> {
    const config = this.configureActingUserTokens();
    if (!this._actingUserVerifier) {
      this.logger.warn("Acting-user tokens are not verified: MCP_TOKEN_ISSUER is not set", {
        mode: config.mode,
      });
    } else {
      const problem = await this._actingUserVerifier.checkKeys();
      if (problem?.startsWith("missing kid")) {
        this.logger.error("Acting-user token kid is not in the portal's JWKS", { problem });
      } else if (problem) {
        this.logger.error("Acting-user token keys could not be fetched at startup", { problem });
      }
    }
    if (http && process.env.ACTING_USER) {
      this.logger.error("ACTING_USER is ignored while serving HTTP", {});
    }
  }

  /**
   * The ACTING_USER fallback, for a local stdio session only: never once the
   * HTTP service runs, and never in production, so an anonymous HTTP call
   * can't act as whoever ACTING_USER names.
   */
  protected envActingUser(): string | undefined {
    if (this._httpPort !== undefined || process.env.NODE_ENV === "production") {
      return undefined;
    }
    return process.env.ACTING_USER || undefined;
  }

  private configureActingUserTokens(): ActingUserTokenConfig {
    if (!this._actingUserConfig) {
      const config = actingUserTokenConfigFromEnv();
      if (config.issuer) {
        this._actingUserVerifier = new ActingUserTokenVerifier({
          ...config,
          issuer: config.issuer,
        });
      }
      this._actingUserConfig = config;
      this.logger.info("Acting-user token verification", {
        mode: config.mode,
        verifying: !!config.issuer,
        audience: config.audience,
      });
    }
    return this._actingUserConfig;
  }

  /**
   * Decides who a /tools call acts for, on a server that acts for users.
   *
   * A Bearer token is verified and its sub is the acting user; a bad token is
   * refused, never replaced by the header, and X-Acting-User may only repeat
   * the sub. Without a token, X-Acting-User is accepted only in "either" mode.
   */
  private async resolveActingUser(
    authorization: string | undefined,
    headerUser: string | undefined
  ): Promise<ActingUserResolution> {
    const config = this.configureActingUserTokens();
    if (authorization !== undefined) {
      const match = /^Bearer +(\S+)$/i.exec(authorization);
      if (!match) {
        return {
          ok: false,
          status: 401,
          error: "Authorization must be a Bearer acting-user token.",
        };
      }
      if (!this._actingUserVerifier) {
        return {
          ok: false,
          status: 401,
          error: "This server is not configured to verify acting-user tokens.",
        };
      }
      try {
        const { sub, email, name } = await this._actingUserVerifier.verify(match[1]);
        if (headerUser !== undefined && headerUser !== sub) {
          return {
            ok: false,
            status: 401,
            error: "X-Acting-User does not match the signed-in user.",
          };
        }
        return {
          ok: true,
          actingUser: sub,
          auth: "token",
          token: match[1],
          profile: { ...(email && { email }), ...(name && { name }) },
        };
      } catch (error) {
        if (error instanceof ActingUserTokenUnavailableError) {
          this.logger.error("Acting-user token keys unavailable", { reason: error.message });
          return {
            ok: false,
            status: 503,
            error: "Sign-in verification is unavailable. Try again later.",
          };
        }
        this.logger.warn("Acting-user token refused", {
          reason: error instanceof Error ? error.message : "invalid",
        });
        return {
          ok: false,
          status: 401,
          error: "The acting-user token is not valid.",
        };
      }
    }
    if (headerUser === undefined || headerUser === "") {
      return { ok: true };
    }
    if (config.mode === "token") {
      if (this._headerOnlyIsUnverified) {
        return { ok: true, actingUser: headerUser, auth: "header" };
      }
      return {
        ok: false,
        status: 401,
        error: "This server requires a signed-in user's token, not X-Acting-User alone.",
      };
    }
    return { ok: true, actingUser: headerUser, auth: "header" };
  }

  /** True when the OAuth middleware verified a CILogon token for this request. */
  private hasVerifiedActingUser(): boolean {
    return !!getRequestContext()?.actingUser;
  }

  /**
   * Get service endpoint from environment configuration
   * Expected format: ACCESS_MCP_SERVICES=nsf-awards=http://localhost:3001,xdmod-metrics=http://localhost:3002
   */
  private getServiceEndpoint(serviceName: string): string | null {
    const services = process.env.ACCESS_MCP_SERVICES;
    if (!services) return null;

    const serviceMap: Record<string, string> = {};
    services.split(",").forEach((service) => {
      const [name, url] = service.split("=");
      if (name && url) {
        serviceMap[name.trim()] = url.trim();
      }
    });

    return serviceMap[serviceName] || null;
  }
}
