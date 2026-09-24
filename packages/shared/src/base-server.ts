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
// Safe direction: drupal-auth depends only on logger, never on base-server.
import { DrupalApiError } from "./drupal-auth.js";
import { traceMcpToolCall } from "./telemetry.js";
import { UsageLogger } from "./usage-logger.js";
import { StandardWriteResponse, StandardErrorResponse } from "./types.js";
import { isCallAuthorized, classifyTool, type ToolWithAccess } from "./tool-access.js";

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
   * Passed via X-Acting-User header from the agent.
   * Format: "username@access-ci.org"
   */
  actingUser?: string;
  /**
   * The Drupal user ID of the acting user.
   * Passed via X-Acting-User-Uid header from the agent.
   * Used for content attribution in Drupal.
   */
  actingUserUid?: number;
  /** Unique request ID for tracing (from X-Request-ID header) */
  requestId?: string;
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
 * Get the acting user's Drupal UID from the current request context.
 * Throws an error if no acting user UID is set - use this for Drupal content attribution.
 */
export function getActingUserUid(): number {
  const context = getRequestContext();
  if (!context?.actingUserUid) {
    throw new Error(
      "No acting user UID specified. The X-Acting-User-Uid header must be set to the Drupal user ID " +
        "of the person performing this action."
    );
  }
  return context.actingUserUid;
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
}

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
  private _nodeServer?: HttpServer;
  private _usageLogger = new UsageLogger(process.env.MCP_USAGE_DB_URL);

  constructor(
    protected serverName: string,
    protected version: string,
    protected baseURL: string = "https://support.access-ci.org/api",
    options: BaseAccessServerOptions = {}
  ) {
    this._requireApiKey = options.requireApiKey ?? false;
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

  protected abstract getTools(): Tool[];
  protected abstract getResources(): Resource[];
  protected abstract handleToolCall(request: CallToolRequest): Promise<CallToolResult>;

  /**
   * The single logging seam for tool calls. EVERY doorway (REST /tools, the
   * MCP-protocol /mcp + /sse handlers) must call this instead of handleToolCall
   * directly, so usage logging covers all paths with no duplication. Timing +
   * fire-and-forget record; never awaited, never throws into the caller.
   * (If you add a new tool-invocation path, route it through here.)
   */
  private async recordAndHandle(request: CallToolRequest): Promise<CallToolResult> {
    const startedAt = Date.now();
    let succeeded = false;
    try {
      const result = await this.handleToolCall(request);
      succeeded = !result.isError;
      return result;
    } finally {
      void this._usageLogger.record({
        server: this.serverName,
        tool: request.params.name,
        args: request.params.arguments as Record<string, unknown> | undefined,
        success: succeeded,
        durationMs: Date.now() - startedAt,
        actingUser: requestContextStorage.getStore()?.actingUser,
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
    // Start HTTP service layer if port is specified
    if (options?.httpPort) {
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
    if (!this._httpPort) return;

    const app = new Hono();
    this._httpApp = app;

    // Optional Bearer token extraction for OAuth-authenticated MCP clients.
    // If a Bearer token is present, verify it via CILogon userinfo and
    // populate RequestContext.actingUser. Never rejects — lets tools decide.
    const oauthVerifyUrl = process.env.OAUTH_VERIFY_URL;
    if (oauthVerifyUrl) {
      app.use("*", async (c, next) => {
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
    // Note: No API key check here — SSE is for public MCP client connections.
    // Write operations are protected by requiring ACTING_USER and Drupal auth server-side.
    // The API key check on /tools/:toolName protects inter-server REST calls.
    app.post("/messages", async (c) => {
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
      const body = await c.req.json().catch(() => undefined);
      await transport.handlePostMessage(incoming, outgoing, body);

      // Signal to @hono/node-server that the response is already handled
      // by SSEServerTransport — don't attempt to write headers again.
      return new Response(null, { headers: { "x-hono-already-sent": "1" } });
    });

    // List available tools endpoint (for inter-server communication)
    app.get("/tools", (c) => {
      try {
        const tools = this.getTools();
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

      // Extract request context from headers
      const uidHeader = c.req.header("X-Acting-User-Uid");
      const context: RequestContext = {
        actingUser: c.req.header("X-Acting-User"),
        actingUserUid: uidHeader ? parseInt(uidHeader, 10) : undefined,
        requestId: c.req.header("X-Request-ID"),
      };

      const toolName = c.req.param("toolName");
      const body = await c.req.json().catch(() => ({}));
      const { arguments: args = {} } = body;

      // Validate that the tool exists (before tracing to avoid noisy spans)
      const tools = this.getTools();
      const tool = tools.find((t) => t.name === toolName);
      if (!tool) {
        return c.json({ error: `Tool '${toolName}' not found` }, 404);
      }

      // Run the handler within the request context
      return requestContextStorage.run(context, async () => {
        // Wrap tool execution with OpenTelemetry tracing
        try {
          const result = await traceMcpToolCall(toolName, args, async (span) => {
            // Add server info to span
            span.setAttribute("mcp.server.name", this.serverName);
            span.setAttribute("mcp.server.version", this.version);

            // Add request context if available
            if (context.requestId) {
              span.setAttribute("mcp.request.id", context.requestId);
            }

            // Execute the tool
            const request: CallToolRequest = {
              method: "tools/call",
              params: {
                name: toolName,
                arguments: args,
              },
            };

            const toolResult = await this.recordAndHandle(request);

            // Record result info on span
            if (toolResult.isError) {
              span.setAttribute("mcp.result.is_error", true);
            }

            return toolResult;
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
      }, () => {
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
        return { tools: this.getTools() };
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
    args: Record<string, unknown> = {}
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
    if (context?.actingUserUid) {
      headers["X-Acting-User-Uid"] = String(context.actingUserUid);
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

    const response = await axios.post(
      `${serviceUrl}/tools/${toolName}`,
      {
        arguments: args,
      },
      {
        timeout: 30000,
        validateStatus: () => true,
        headers,
      }
    );

    if (response.status !== 200) {
      throw new Error(
        `Remote server call failed: ${response.status} ${response.data?.error || response.statusText}`
      );
    }

    return response.data;
  }

  /** Public tool names for this server (default-deny classification). */
  private publicToolNames(): Set<string> {
    const names = new Set<string>();
    for (const tool of this.getTools() as ToolWithAccess[]) {
      if (classifyTool(tool) === "public") names.add(tool.name);
    }
    return names;
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
