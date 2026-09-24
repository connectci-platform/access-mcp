import {
  BaseAccessServer,
  Tool,
  Resource,
  CallToolResult,
  assertNoPublicWrites,
  type ToolWithAccess,
} from "@access-mcp/shared";
import { CallToolRequest } from "@modelcontextprotocol/sdk/types.js";
import axios, { AxiosInstance } from "axios";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const { version } = require("../package.json");

// ============================================================================
// Constants
// ============================================================================

/** Service Desk IDs */
const SERVICE_DESK = {
  SUPPORT: 2,
  SECURITY: 3,
} as const;

/** Request Type IDs */
const REQUEST_TYPE = {
  GENERAL_SUPPORT: 17,
  ACCESS_LOGIN: 30,
  RESOURCE_PROVIDER_LOGIN: 31,
  SECURITY_INCIDENT: 26,
} as const;

/** Issue categories for general support tickets */
const ISSUE_CATEGORIES = [
  "User Account Question",
  "Allocation Question",
  "User Support Question",
  "CSSN/CCEP Question",
  "Training Question",
  "Metrics Question",
  "OnDemand Question",
  "Pegasus Question",
  "XDMoD Question",
  "Some Other Question",
] as const;

/** ACCESS resources */
const ACCESS_RESOURCES = [
  "ACES",
  "Anvil",
  "Bridges-2",
  "DARWIN",
  "Delta",
  "DeltaAI",
  "Derecho",
  "Expanse",
  "FASTER",
  "Granite",
  "Jetstream2",
  "KyRIC",
  "Launch",
  "Neocortex",
  "Ookami",
  "Open Science Grid",
  "Open Storage Network",
  "Ranch",
  "Stampede3",
] as const;

/** Identity providers for ACCESS login */
const IDENTITY_PROVIDERS = [
  "ACCESS",
  "Github",
  "Google",
  "Institution",
  "Microsoft",
  "ORCID",
  "Other",
] as const;

/** Parse JSM_DRY_RUN env var. Enabled for "true", "1", "yes" (case-insensitive). */
function isDryRunEnabled(): boolean {
  const val = (process.env.JSM_DRY_RUN ?? "").toLowerCase();
  return val === "true" || val === "1" || val === "yes";
}

// ============================================================================
// Types
// ============================================================================

interface CreateSupportTicketArgs {
  summary: string;
  description: string;
  user_email: string;
  user_name: string;
  access_id?: string;
  category?: string;
  priority?: string;
  resource?: string;
  user_id_at_resource?: string;
}

interface CreateLoginTicketArgs {
  summary: string;
  description: string;
  user_email: string;
  user_name: string;
  access_id?: string;
  login_type: "access_portal" | "resource_provider";
  identity_provider?: string;
  browser?: string;
  resource?: string;
  user_id_at_resource?: string;
}

interface ReportSecurityIncidentArgs {
  summary: string;
  description: string;
  user_email: string;
  user_name: string;
  access_id?: string;
  priority?: string;
}

interface ProxyResponse {
  success: boolean;
  data?: {
    ticketKey: string;
    ticketUrl: string;
  };
  error?: string;
}

interface TicketRequestBody {
  serviceDeskId: number;
  requestTypeId: number;
  requestFieldValues: Record<string, string>;
}

// ============================================================================
// Server
// ============================================================================

export class JsmServer extends BaseAccessServer {
  private _proxyClient?: AxiosInstance;
  private readonly dryRun: boolean;
  private dryRunCounter = 0;

  constructor() {
    const proxyUrl = process.env.JSM_PROXY_URL ?? "";
    const dryRun = isDryRunEnabled();

    if (!proxyUrl && !dryRun) {
      console.warn(
        "[access-mcp-jsm] WARNING: JSM_PROXY_URL is not set and JSM_DRY_RUN is not enabled. " +
        "Ticket creation will fail. Set JSM_PROXY_URL or enable JSM_DRY_RUN."
      );
    }

    super(
      "access-mcp-jsm",
      version,
      proxyUrl || "http://unconfigured",
      { requireApiKey: true }
    );
    this.dryRun = dryRun;

    if (dryRun) {
      this.logger.info("JSM dry-run mode ENABLED — no tickets will be created");
    }

    assertNoPublicWrites(this.getTools() as ToolWithAccess[]);
  }

  private get proxyClient(): AxiosInstance {
    if (!this._proxyClient) {
      this._proxyClient = axios.create({
        baseURL: this.baseURL,
        timeout: 30000,
        headers: {
          "Content-Type": "application/json",
          "User-Agent": `access-mcp-jsm/${version}`,
        },
        validateStatus: () => true,
      });
    }
    return this._proxyClient;
  }

  protected getTools(): Tool[] {
    const tools: ToolWithAccess[] = [
      {
        name: "create_support_ticket",
        description:
          "Create a general support ticket in ACCESS JSM. Use this when a user needs help with allocations, accounts, software, or other ACCESS-related issues that you cannot resolve directly.",
        inputSchema: {
          type: "object",
          properties: {
            summary: {
              type: "string",
              description: "Brief title for the ticket (1-2 sentences)",
            },
            description: {
              type: "string",
              description:
                "Detailed description of the issue, including what the user has already tried. Write this as a clean summary - do not include raw conversation transcript.",
            },
            user_email: {
              type: "string",
              description: "User's email address",
            },
            user_name: {
              type: "string",
              description: "User's full name",
            },
            access_id: {
              type: "string",
              description: "User's ACCESS ID (optional)",
            },
            category: {
              type: "string",
              enum: ISSUE_CATEGORIES,
              description: "Issue category",
            },
            priority: {
              type: "string",
              enum: ["lowest", "low", "medium", "high", "highest"],
              default: "medium",
              description: "Ticket priority",
            },
            resource: {
              type: "string",
              enum: ACCESS_RESOURCES,
              description: "ACCESS resource involved (if applicable)",
            },
            user_id_at_resource: {
              type: "string",
              description: "User's username at the resource (if applicable)",
            },
          },
          required: ["summary", "description", "user_email", "user_name"],
        },
        access: "authenticated",
        mutates: true,
      },
      {
        name: "create_login_ticket",
        description:
          "Create a ticket for login issues - either for the ACCESS portal or a specific resource provider.",
        inputSchema: {
          type: "object",
          properties: {
            summary: {
              type: "string",
              description: "Brief description of the login issue",
            },
            description: {
              type: "string",
              description: "Detailed description including error messages and what was tried",
            },
            user_email: {
              type: "string",
              description: "User's email address",
            },
            user_name: {
              type: "string",
              description: "User's full name",
            },
            access_id: {
              type: "string",
              description: "User's ACCESS ID (optional)",
            },
            login_type: {
              type: "string",
              enum: ["access_portal", "resource_provider"],
              description: "Whether the issue is with ACCESS portal login or a resource provider",
            },
            identity_provider: {
              type: "string",
              enum: IDENTITY_PROVIDERS,
              description: "Identity provider used (for ACCESS portal login issues)",
            },
            browser: {
              type: "string",
              description: "Browser being used (for ACCESS portal login issues)",
            },
            resource: {
              type: "string",
              enum: ACCESS_RESOURCES,
              description: "Resource provider (for resource provider login issues)",
            },
            user_id_at_resource: {
              type: "string",
              description: "Username at the resource provider",
            },
          },
          required: ["summary", "description", "user_email", "user_name", "login_type"],
        },
        access: "authenticated",
        mutates: true,
      },
      {
        name: "report_security_incident",
        description:
          "Report a security vulnerability or incident. Use this for security-related concerns that need to go to the ACCESS cybersecurity team.",
        inputSchema: {
          type: "object",
          properties: {
            summary: {
              type: "string",
              description: "Brief description of the security concern",
            },
            description: {
              type: "string",
              description: "Detailed description of the security issue",
            },
            user_email: {
              type: "string",
              description: "User's email address",
            },
            user_name: {
              type: "string",
              description: "User's full name",
            },
            access_id: {
              type: "string",
              description: "User's ACCESS ID (optional)",
            },
            priority: {
              type: "string",
              enum: ["low", "medium", "high", "critical"],
              default: "medium",
              description: "Severity of the security concern",
            },
          },
          required: ["summary", "description", "user_email", "user_name"],
        },
        access: "authenticated",
        mutates: true,
      },
      {
        name: "get_ticket_types",
        description:
          "Get information about available ticket types. Use this to understand what kinds of tickets can be created and their categories.",
        inputSchema: {
          type: "object",
          properties: {},
        },
        access: "public",
      },
    ];
    return tools;
  }

  protected getResources(): Resource[] {
    return [
      {
        uri: "accessci://jsm/ticket-types",
        name: "ACCESS JSM Ticket Types",
        description: "Available ticket types and categories for ACCESS support",
        mimeType: "application/json",
      },
    ];
  }

  protected async handleToolCall(request: CallToolRequest): Promise<CallToolResult> {
    const { name, arguments: args = {} } = request.params;

    try {
      switch (name) {
        case "create_support_ticket":
          return await this.createSupportTicket(args as unknown as CreateSupportTicketArgs);
        case "create_login_ticket":
          return await this.createLoginTicket(args as unknown as CreateLoginTicketArgs);
        case "report_security_incident":
          return await this.reportSecurityIncident(args as unknown as ReportSecurityIncidentArgs);
        case "get_ticket_types":
          return this.getTicketTypes();
        default:
          return this.errorResponse(`Unknown tool: ${name}`);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error("Tool call failed", { tool: name, error: message });
      return this.errorResponse(message);
    }
  }

  private async createSupportTicket(args: CreateSupportTicketArgs): Promise<CallToolResult> {
    const {
      summary,
      description,
      user_email,
      user_name,
      access_id,
      category,
      priority = "medium",
      resource,
      user_id_at_resource,
    } = args;

    const requestBody: TicketRequestBody = {
      serviceDeskId: SERVICE_DESK.SUPPORT,
      requestTypeId: REQUEST_TYPE.GENERAL_SUPPORT,
      requestFieldValues: {
        email: user_email,
        name: user_name,
        summary,
        description,
        priority,
        ...(access_id && { accessId: access_id }),
        ...(category && { issueType: category }),
        ...(resource && {
          hasResourceProblem: "Yes",
          resourceName: resource,
        }),
        ...(!resource && { hasResourceProblem: "No" }),
        ...(user_id_at_resource && { userIdAtResource: user_id_at_resource }),
      },
    };

    return await this.submitTicket(requestBody, "/api/v1/tickets");
  }

  private async createLoginTicket(args: CreateLoginTicketArgs): Promise<CallToolResult> {
    const {
      summary,
      description,
      user_email,
      user_name,
      access_id,
      login_type,
      identity_provider,
      browser,
      resource,
      user_id_at_resource,
    } = args;

    const isAccessPortal = login_type === "access_portal";
    const requestTypeId = isAccessPortal
      ? REQUEST_TYPE.ACCESS_LOGIN
      : REQUEST_TYPE.RESOURCE_PROVIDER_LOGIN;

    const requestBody: TicketRequestBody = {
      serviceDeskId: SERVICE_DESK.SUPPORT,
      requestTypeId,
      requestFieldValues: {
        email: user_email,
        name: user_name,
        summary,
        description,
        ...(access_id && { accessId: access_id }),
        // ACCESS portal login fields
        ...(isAccessPortal && identity_provider && { identityProvider: identity_provider }),
        ...(isAccessPortal && browser && { browser }),
        // Resource provider login fields
        ...(!isAccessPortal && resource && { accessResource: resource }),
        ...(!isAccessPortal && user_id_at_resource && { userIdAtResource: user_id_at_resource }),
      },
    };

    return await this.submitTicket(requestBody, "/api/v1/tickets");
  }

  private async reportSecurityIncident(args: ReportSecurityIncidentArgs): Promise<CallToolResult> {
    const {
      summary,
      description,
      user_email,
      user_name,
      access_id,
      priority = "medium",
    } = args;

    const requestBody: TicketRequestBody = {
      serviceDeskId: SERVICE_DESK.SECURITY,
      requestTypeId: REQUEST_TYPE.SECURITY_INCIDENT,
      requestFieldValues: {
        email: user_email,
        name: user_name,
        summary,
        description,
        priority,
        ...(access_id && { accessId: access_id }),
      },
    };

    return await this.submitTicket(requestBody, "/api/v1/security-incidents");
  }

  private async submitTicket(body: TicketRequestBody, endpoint: string): Promise<CallToolResult> {
    if (this.dryRun) {
      this.dryRunCounter++;
      const key = `DRYRUN-${String(this.dryRunCounter).padStart(3, "0")}`;
      const summary = body.requestFieldValues.summary ?? "unknown";

      this.logger.info("Dry-run ticket submission", {
        key,
        endpoint,
        serviceDeskId: body.serviceDeskId,
        requestTypeId: body.requestTypeId,
        summary: summary.slice(0, 80),
      });
      this.logger.debug("Dry-run full request body", { body });

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              success: true,
              ticket_key: key,
              ticket_url: null,
              message: `[DRY RUN] Ticket not created. Would have submitted: ${summary}`,
            }),
          },
        ],
      };
    }

    if (!process.env.JSM_PROXY_URL) {
      this.logger.error("Ticket creation blocked — JSM_PROXY_URL not configured");
      return this.errorResponse("JSM_PROXY_URL not configured — cannot create tickets");
    }

    this.logger.info("Submitting ticket", {
      endpoint,
      serviceDeskId: body.serviceDeskId,
      requestTypeId: body.requestTypeId,
    });

    const response = await this.proxyClient.post<ProxyResponse>(endpoint, body);

    if (response.status !== 200) {
      const errorMsg = response.data?.error || `HTTP ${response.status}`;
      this.logger.error("Ticket creation failed", { status: response.status, error: errorMsg });
      return this.errorResponse(`Failed to create ticket: ${errorMsg}`);
    }

    const data = response.data;
    if (!data.success || !data.data) {
      const errorMsg = data.error || "Unknown error";
      this.logger.error("Ticket creation failed", { error: errorMsg });
      return this.errorResponse(`Failed to create ticket: ${errorMsg}`);
    }

    this.logger.info("Ticket created successfully", {
      ticketKey: data.data.ticketKey,
    });

    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({
            success: true,
            ticket_key: data.data.ticketKey,
            ticket_url: data.data.ticketUrl,
            message: `Ticket ${data.data.ticketKey} created successfully`,
          }),
        },
      ],
    };
  }

  private getTicketTypes(): CallToolResult {
    const items = [
      {
        tool: "create_support_ticket",
        name: "General Support",
        description:
          "General support questions about allocations, accounts, software, training, metrics, and other ACCESS-related topics.",
        categories: ISSUE_CATEGORIES,
        resources: ACCESS_RESOURCES,
      },
      {
        tool: "create_login_ticket",
        name: "Login Issues",
        description: "Issues logging into the ACCESS portal or a specific resource provider.",
        subtypes: [
          {
            login_type: "access_portal",
            description: "Problems logging into access-ci.org",
            identity_providers: IDENTITY_PROVIDERS,
          },
          {
            login_type: "resource_provider",
            description: "Problems logging into a specific resource (Delta, Expanse, etc.)",
            resources: ACCESS_RESOURCES,
          },
        ],
      },
      {
        tool: "report_security_incident",
        name: "Security Incident",
        description:
          "Report security vulnerabilities, suspicious activity, or other security concerns to the ACCESS cybersecurity team.",
        priorities: ["low", "medium", "high", "critical"],
      },
    ];

    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({
            total: items.length,
            items,
          }),
        },
      ],
    };
  }
}
