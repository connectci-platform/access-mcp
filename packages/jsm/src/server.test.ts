import { describe, it, expect, beforeEach, vi, type Mock } from "vitest";
import { JsmServer } from "./server.js";
import axios from "axios";

// Mock axios
vi.mock("axios", () => ({
  default: {
    create: vi.fn(() => ({
      post: vi.fn(),
    })),
  },
}));

interface MockProxyClient {
  post: Mock;
}

interface TextContent {
  type: "text";
  text: string;
}

describe("JsmServer", () => {
  let server: JsmServer;
  let mockProxyClient: MockProxyClient;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.JSM_PROXY_URL = "http://fake-proxy";
    delete process.env.JSM_DRY_RUN;
    server = new JsmServer();

    // Create mock proxy client
    mockProxyClient = {
      post: vi.fn(),
    };

    // Mock axios.create to return our mock client
    (axios.create as Mock).mockReturnValue(mockProxyClient);
  });

  describe("create_support_ticket", () => {
    it("should create a support ticket with required fields", async () => {
      mockProxyClient.post.mockResolvedValue({
        status: 200,
        data: {
          success: true,
          data: {
            ticketKey: "ACCESS-12345",
            ticketUrl: "https://access-ci.atlassian.net/browse/ACCESS-12345",
          },
        },
      });

      const result = await server["handleToolCall"]({
        method: "tools/call",
        params: {
          name: "create_support_ticket",
          arguments: {
            confirmed: true,
            summary: "Cannot allocate GPUs on Delta",
            description:
              "User is unable to submit GPU jobs. Getting error about quota exceeded.",
            user_email: "john.smith@university.edu",
            user_name: "John Smith",
          },
        },
      });

      expect(mockProxyClient.post).toHaveBeenCalledWith(
        "/api/v1/tickets",
        expect.objectContaining({
          serviceDeskId: 2,
          requestTypeId: 17,
          requestFieldValues: expect.objectContaining({
            email: "john.smith@university.edu",
            name: "John Smith",
            summary: "Cannot allocate GPUs on Delta",
            // Not signed in, so the ticket says its requester is unverified (D8-3069).
            description: expect.stringMatching(
              /^User is unable to submit GPU jobs\. Getting error about quota exceeded\.\n\nFiled through the ACCESS Assistant by someone who wasn't signed in\./
            ),
            priority: "medium",
            hasResourceProblem: "No",
          }),
        })
      );

      const responseData = JSON.parse((result.content[0] as TextContent).text);
      expect(responseData.success).toBe(true);
      expect(responseData.ticket_key).toBe("ACCESS-12345");
      expect(responseData.ticket_url).toBe(
        "https://access-ci.atlassian.net/browse/ACCESS-12345"
      );
    });

    it("should create a support ticket with all optional fields", async () => {
      mockProxyClient.post.mockResolvedValue({
        status: 200,
        data: {
          success: true,
          data: {
            ticketKey: "ACCESS-12346",
            ticketUrl: "https://access-ci.atlassian.net/browse/ACCESS-12346",
          },
        },
      });

      const result = await server["handleToolCall"]({
        method: "tools/call",
        params: {
          name: "create_support_ticket",
          arguments: {
            confirmed: true,
            summary: "Cannot access Delta",
            description: "Login issues on Delta",
            user_email: "jane.doe@university.edu",
            user_name: "Jane Doe",
            access_id: "jdoe",
            category: "Allocation Question",
            priority: "high",
            resource: "Delta",
            user_id_at_resource: "jdoe123",
          },
        },
      });

      expect(mockProxyClient.post).toHaveBeenCalledWith(
        "/api/v1/tickets",
        expect.objectContaining({
          serviceDeskId: 2,
          requestTypeId: 17,
          requestFieldValues: expect.objectContaining({
            email: "jane.doe@university.edu",
            name: "Jane Doe",
            accessId: "jdoe",
            issueType: "Allocation Question",
            priority: "high",
            hasResourceProblem: "Yes",
            resourceName: "Delta",
            userIdAtResource: "jdoe123",
          }),
        })
      );

      const responseData = JSON.parse((result.content[0] as TextContent).text);
      expect(responseData.success).toBe(true);
    });

    it("should handle API errors", async () => {
      mockProxyClient.post.mockResolvedValue({
        status: 500,
        data: {
          error: "Internal server error",
        },
      });

      const result = await server["handleToolCall"]({
        method: "tools/call",
        params: {
          name: "create_support_ticket",
          arguments: {
            confirmed: true,
            summary: "Test",
            description: "Test description",
            user_email: "test@test.com",
            user_name: "Test User",
          },
        },
      });

      const responseData = JSON.parse((result.content[0] as TextContent).text);
      expect(responseData.error.message).toContain("Failed to create ticket");
    });

    it("does not show a 5xx proxy error text", async () => {
      mockProxyClient.post.mockResolvedValue({
        status: 502,
        data: { error: "connect ECONNREFUSED jira.internal:443" },
      });

      const result = await server["handleToolCall"]({
        method: "tools/call",
        params: {
          name: "create_support_ticket",
          arguments: {
            confirmed: true,
            summary: "Test",
            description: "Test description",
            user_email: "test@test.com",
            user_name: "Test User",
          },
        },
      });

      const text = (result.content[0] as TextContent).text;
      expect(text).not.toContain("jira.internal");
      expect(JSON.parse(text).error.message).toBe("Failed to create ticket: HTTP 502");
    });

    it("logs a 5xx proxy failure as status and path without its text", async () => {
      const spy = vi.spyOn(console, "error").mockImplementation(() => {});
      mockProxyClient.post.mockResolvedValue({
        status: 502,
        data: { error: "connect ECONNREFUSED jira.internal:443" },
      });
      await server["handleToolCall"]({
        method: "tools/call",
        params: {
          name: "create_support_ticket",
          arguments: {
            confirmed: true,
            summary: "Test",
            description: "Test description",
            user_email: "test@test.com",
            user_name: "Test User",
          },
        },
      });
      const lines = spy.mock.calls.map((c) => c.join(" ")).join("\n");
      spy.mockRestore();
      expect(lines).toContain('"upstream":"jsm-proxy"');
      expect(lines).toContain('"status":502');
      expect(lines).toContain('"path":"/api/v1/tickets"');
      expect(lines).not.toContain("jira.internal");
      expect(lines).not.toContain("test@test.com");
    });

    it("shows a 4xx proxy error text", async () => {
      mockProxyClient.post.mockResolvedValue({
        status: 400,
        data: { error: "Invalid field values" },
      });

      const result = await server["handleToolCall"]({
        method: "tools/call",
        params: {
          name: "create_support_ticket",
          arguments: {
            confirmed: true,
            summary: "Test",
            description: "Test description",
            user_email: "test@test.com",
            user_name: "Test User",
          },
        },
      });

      const responseData = JSON.parse((result.content[0] as TextContent).text);
      expect(responseData.error.message).toBe("Failed to create ticket: Invalid field values");
    });

    it("should handle proxy returning success:false", async () => {
      mockProxyClient.post.mockResolvedValue({
        status: 200,
        data: {
          success: false,
          error: "Invalid field values",
        },
      });

      const result = await server["handleToolCall"]({
        method: "tools/call",
        params: {
          name: "create_support_ticket",
          arguments: {
            confirmed: true,
            summary: "Test",
            description: "Test description",
            user_email: "test@test.com",
            user_name: "Test User",
          },
        },
      });

      const responseData = JSON.parse((result.content[0] as TextContent).text);
      expect(responseData.error.message).toBe("Failed to create ticket: The ticket could not be created");
      expect(responseData.error.message).not.toContain("Invalid field values");
    });

    it("should not pass a proxy success:false error string through", async () => {
      mockProxyClient.post.mockResolvedValue({
        status: 200,
        data: { success: false, error: "JIRA_TOKEN=abc at jira.internal:8080" },
      });

      const result = await server["handleToolCall"]({
        method: "tools/call",
        params: {
          name: "create_support_ticket",
          arguments: {
            confirmed: true,
            summary: "Test",
            description: "Test description",
            user_email: "test@test.com",
            user_name: "Test User",
          },
        },
      });

      const text = (result.content[0] as TextContent).text;
      expect(text).not.toContain("JIRA_TOKEN");
      expect(text).not.toContain("jira.internal");
    });
  });

  describe("create_login_ticket", () => {
    it("should create an ACCESS portal login ticket", async () => {
      mockProxyClient.post.mockResolvedValue({
        status: 200,
        data: {
          success: true,
          data: {
            ticketKey: "ACCESS-12347",
            ticketUrl: "https://access-ci.atlassian.net/browse/ACCESS-12347",
          },
        },
      });

      const result = await server["handleToolCall"]({
        method: "tools/call",
        params: {
          name: "create_login_ticket",
          arguments: {
            confirmed: true,
            summary: "Cannot login to ACCESS portal",
            description: "Getting 403 error when trying to log in with GitHub",
            user_email: "researcher@university.edu",
            user_name: "Researcher One",
            login_type: "access_portal",
            identity_provider: "Github",
            browser: "Chrome 120",
          },
        },
      });

      expect(mockProxyClient.post).toHaveBeenCalledWith(
        "/api/v1/tickets",
        expect.objectContaining({
          serviceDeskId: 2,
          requestTypeId: 30, // ACCESS_LOGIN
          requestFieldValues: expect.objectContaining({
            email: "researcher@university.edu",
            name: "Researcher One",
            summary: "Cannot login to ACCESS portal",
            identityProvider: "Github",
            browser: "Chrome 120",
          }),
        })
      );

      const responseData = JSON.parse((result.content[0] as TextContent).text);
      expect(responseData.success).toBe(true);
      expect(responseData.ticket_key).toBe("ACCESS-12347");
    });

    it("should create a resource provider login ticket", async () => {
      mockProxyClient.post.mockResolvedValue({
        status: 200,
        data: {
          success: true,
          data: {
            ticketKey: "ACCESS-12348",
            ticketUrl: "https://access-ci.atlassian.net/browse/ACCESS-12348",
          },
        },
      });

      const result = await server["handleToolCall"]({
        method: "tools/call",
        params: {
          name: "create_login_ticket",
          arguments: {
            confirmed: true,
            summary: "Cannot SSH to Expanse",
            description: "SSH connection times out when connecting to Expanse",
            user_email: "researcher@university.edu",
            user_name: "Researcher Two",
            access_id: "rtwo",
            login_type: "resource_provider",
            resource: "Expanse",
            user_id_at_resource: "rtwo_sdsc",
          },
        },
      });

      expect(mockProxyClient.post).toHaveBeenCalledWith(
        "/api/v1/tickets",
        expect.objectContaining({
          serviceDeskId: 2,
          requestTypeId: 31, // RESOURCE_PROVIDER_LOGIN
          requestFieldValues: expect.objectContaining({
            email: "researcher@university.edu",
            name: "Researcher Two",
            accessId: "rtwo",
            accessResource: "Expanse",
            userIdAtResource: "rtwo_sdsc",
          }),
        })
      );

      const responseData = JSON.parse((result.content[0] as TextContent).text);
      expect(responseData.success).toBe(true);
    });

    it("should not include resource provider fields for ACCESS portal login", async () => {
      mockProxyClient.post.mockResolvedValue({
        status: 200,
        data: {
          success: true,
          data: {
            ticketKey: "ACCESS-12349",
            ticketUrl: "https://access-ci.atlassian.net/browse/ACCESS-12349",
          },
        },
      });

      await server["handleToolCall"]({
        method: "tools/call",
        params: {
          name: "create_login_ticket",
          arguments: {
            confirmed: true,
            summary: "Portal login issue",
            description: "Cannot log in",
            user_email: "test@test.com",
            user_name: "Test",
            login_type: "access_portal",
            identity_provider: "Google",
          },
        },
      });

      const callArgs = mockProxyClient.post.mock.calls[0][1] as {
        requestFieldValues: Record<string, unknown>;
      };
      expect(callArgs.requestFieldValues.accessResource).toBeUndefined();
      expect(callArgs.requestFieldValues.userIdAtResource).toBeUndefined();
    });
  });

  describe("report_security_incident", () => {
    it("should report a security incident", async () => {
      mockProxyClient.post.mockResolvedValue({
        status: 200,
        data: {
          success: true,
          data: {
            ticketKey: "SEC-001",
            ticketUrl: "https://access-ci.atlassian.net/browse/SEC-001",
          },
        },
      });

      const result = await server["handleToolCall"]({
        method: "tools/call",
        params: {
          name: "report_security_incident",
          arguments: {
            confirmed: true,
            summary: "Suspicious login activity detected",
            description:
              "Multiple failed login attempts from unknown IP addresses",
            user_email: "security@university.edu",
            user_name: "Security Admin",
            priority: "high",
          },
        },
      });

      expect(mockProxyClient.post).toHaveBeenCalledWith(
        "/api/v1/security-incidents",
        expect.objectContaining({
          serviceDeskId: 3, // SECURITY
          requestTypeId: 26, // SECURITY_INCIDENT
          requestFieldValues: expect.objectContaining({
            email: "security@university.edu",
            name: "Security Admin",
            summary: "Suspicious login activity detected",
            priority: "high",
          }),
        })
      );

      const responseData = JSON.parse((result.content[0] as TextContent).text);
      expect(responseData.success).toBe(true);
      expect(responseData.ticket_key).toBe("SEC-001");
    });

    it("should default priority to medium", async () => {
      mockProxyClient.post.mockResolvedValue({
        status: 200,
        data: {
          success: true,
          data: {
            ticketKey: "SEC-002",
            ticketUrl: "https://access-ci.atlassian.net/browse/SEC-002",
          },
        },
      });

      await server["handleToolCall"]({
        method: "tools/call",
        params: {
          name: "report_security_incident",
          arguments: {
            confirmed: true,
            summary: "Minor security concern",
            description: "Found an outdated package",
            user_email: "dev@university.edu",
            user_name: "Developer",
          },
        },
      });

      const callArgs = mockProxyClient.post.mock.calls[0][1] as {
        requestFieldValues: Record<string, unknown>;
      };
      expect(callArgs.requestFieldValues.priority).toBe("medium");
    });
  });

  describe("get_ticket_types", () => {
    it("should return ticket type information", async () => {
      const result = await server["handleToolCall"]({
        method: "tools/call",
        params: {
          name: "get_ticket_types",
          arguments: {},
        },
      });

      const responseData = JSON.parse((result.content[0] as TextContent).text);
      expect(responseData.items).toHaveLength(3);

      // Check support ticket type
      const supportType = responseData.items.find(
        (t: { tool: string }) => t.tool === "create_support_ticket"
      );
      expect(supportType).toBeDefined();
      expect(supportType.name).toBe("General Support");
      expect(supportType.categories).toContain("User Account Question");
      expect(supportType.categories).toContain("Allocation Question");
      expect(supportType.resources).toContain("Delta");
      expect(supportType.resources).toContain("Expanse");

      // Check login ticket type
      const loginType = responseData.items.find(
        (t: { tool: string }) => t.tool === "create_login_ticket"
      );
      expect(loginType).toBeDefined();
      expect(loginType.subtypes).toHaveLength(2);
      expect(loginType.subtypes[0].login_type).toBe("access_portal");
      expect(loginType.subtypes[0].identity_providers).toContain("Github");

      // Check security incident type
      const securityType = responseData.items.find(
        (t: { tool: string }) => t.tool === "report_security_incident"
      );
      expect(securityType).toBeDefined();
      expect(securityType.priorities).toContain("critical");
    });
  });

  describe("Unknown Tool", () => {
    it("should return error for unknown tool", async () => {
      const result = await server["handleToolCall"]({
        method: "tools/call",
        params: {
          name: "unknown_tool",
          arguments: {},
        },
      });

      const responseData = JSON.parse((result.content[0] as TextContent).text);
      expect(responseData.error.message).toContain("Unknown tool");
    });
  });

  describe("Resources", () => {
    it("should list the ticket-types resource", () => {
      const resources = server["getResources"]();
      expect(resources).toHaveLength(1);
      expect(resources[0].uri).toBe("accessci://jsm/ticket-types");
      expect(resources[0].name).toBe("ACCESS JSM Ticket Types");
    });
  });

  describe("Dry-run mode", () => {
    it("should return dry-run response for create_support_ticket when JSM_DRY_RUN=true", async () => {
      process.env.JSM_DRY_RUN = "true";
      const dryRunServer = new JsmServer();

      const result = await dryRunServer["handleToolCall"]({
        method: "tools/call",
        params: {
          name: "create_support_ticket",
          arguments: {
            confirmed: true,
            summary: "Test dry run ticket",
            description: "This should not create a real ticket",
            user_email: "test@test.com",
            user_name: "Test User",
          },
        },
      });

      const responseData = JSON.parse((result.content[0] as TextContent).text);
      expect(responseData.success).toBe(true);
      expect(responseData.ticket_key).toMatch(/^DRYRUN-/);
      expect(responseData.message).toContain("[DRY RUN]");
      expect(responseData.message).toContain("Test dry run ticket");

      // axios should NOT have been called
      expect(axios.create).not.toHaveBeenCalled();

      delete process.env.JSM_DRY_RUN;
    });

    it.each(["true", "TRUE", "True", "1", "yes", "YES"])("should enable dry-run for JSM_DRY_RUN=%s", async (value) => {
      process.env.JSM_DRY_RUN = value;
      const dryRunServer = new JsmServer();

      const result = await dryRunServer["handleToolCall"]({
        method: "tools/call",
        params: {
          name: "create_support_ticket",
          arguments: {
            confirmed: true,
            summary: "Dry run test",
            description: "Testing",
            user_email: "test@test.com",
            user_name: "Test",
          },
        },
      });

      const responseData = JSON.parse((result.content[0] as TextContent).text);
      expect(responseData.ticket_key).toMatch(/^DRYRUN-/);

      delete process.env.JSM_DRY_RUN;
    });

    it.each(["false", "FALSE", "False", "0", "no", ""])("should NOT enable dry-run for JSM_DRY_RUN=%s", async (value) => {
      process.env.JSM_DRY_RUN = value;
      process.env.JSM_PROXY_URL = "http://fake-proxy";
      const server = new JsmServer();

      mockProxyClient = { post: vi.fn() };
      (axios.create as Mock).mockReturnValue(mockProxyClient);

      mockProxyClient.post.mockResolvedValue({
        status: 200,
        data: {
          success: true,
          data: { ticketKey: "ACCESS-99999", ticketUrl: "http://example.com" },
        },
      });

      const result = await server["handleToolCall"]({
        method: "tools/call",
        params: {
          name: "create_support_ticket",
          arguments: {
            confirmed: true,
            summary: "Real ticket",
            description: "Testing",
            user_email: "test@test.com",
            user_name: "Test",
          },
        },
      });

      expect(mockProxyClient.post).toHaveBeenCalled();
      const responseData = JSON.parse((result.content[0] as TextContent).text);
      expect(responseData.ticket_key).toBe("ACCESS-99999");

      delete process.env.JSM_DRY_RUN;
      delete process.env.JSM_PROXY_URL;
    });

    it("should increment dry-run ticket keys", async () => {
      process.env.JSM_DRY_RUN = "true";
      const dryRunServer = new JsmServer();

      const call = (summary: string) =>
        dryRunServer["handleToolCall"]({
          method: "tools/call",
          params: {
            name: "create_support_ticket",
            arguments: {
              confirmed: true,
              summary,
              description: "Testing",
              user_email: "test@test.com",
              user_name: "Test",
            },
          },
        });

      const r1 = await call("First");
      const r2 = await call("Second");
      const r3 = await call("Third");

      expect(JSON.parse((r1.content[0] as TextContent).text).ticket_key).toBe("DRYRUN-001");
      expect(JSON.parse((r2.content[0] as TextContent).text).ticket_key).toBe("DRYRUN-002");
      expect(JSON.parse((r3.content[0] as TextContent).text).ticket_key).toBe("DRYRUN-003");

      delete process.env.JSM_DRY_RUN;
    });
  });

  describe("Missing proxy URL", () => {
    it("should fail ticket creation when JSM_PROXY_URL is unset and dry-run is off", async () => {
      delete process.env.JSM_PROXY_URL;
      delete process.env.JSM_DRY_RUN;
      const server = new JsmServer();

      const result = await server["handleToolCall"]({
        method: "tools/call",
        params: {
          name: "create_support_ticket",
          arguments: {
            confirmed: true,
            summary: "Should fail",
            description: "No proxy URL",
            user_email: "test@test.com",
            user_name: "Test",
          },
        },
      });

      const responseData = JSON.parse((result.content[0] as TextContent).text);
      expect(responseData.error.message).toContain("JSM_PROXY_URL not configured");
    });

    it("should still return ticket types when proxy URL is missing", async () => {
      delete process.env.JSM_PROXY_URL;
      delete process.env.JSM_DRY_RUN;
      const server = new JsmServer();

      const result = await server["handleToolCall"]({
        method: "tools/call",
        params: {
          name: "get_ticket_types",
          arguments: {},
        },
      });

      const responseData = JSON.parse((result.content[0] as TextContent).text);
      expect(responseData.items).toHaveLength(3);
    });
  });

  describe("Tools", () => {
    it("should list all four tools", () => {
      const tools = server["getTools"]();
      expect(tools).toHaveLength(4);

      const toolNames = tools.map((t) => t.name);
      expect(toolNames).toContain("create_support_ticket");
      expect(toolNames).toContain("create_login_ticket");
      expect(toolNames).toContain("report_security_incident");
      expect(toolNames).toContain("get_ticket_types");
    });

    it("should have proper input schemas for create_support_ticket", () => {
      const tools = server["getTools"]();
      const supportTool = tools.find((t) => t.name === "create_support_ticket");

      expect(supportTool?.inputSchema.required).toContain("summary");
      expect(supportTool?.inputSchema.required).toContain("description");
      // A signed-in user's ticket takes these from their account (D8-3069).
      expect(supportTool?.inputSchema.required).not.toContain("user_email");
      expect(supportTool?.inputSchema.required).not.toContain("user_name");

      // Check enum values
      const props = supportTool?.inputSchema.properties as Record<
        string,
        { enum?: string[] }
      >;
      expect(props.category.enum).toContain("User Account Question");
      expect(props.priority.enum).toContain("medium");
      expect(props.resource.enum).toContain("Delta");
    });

    it("should have proper input schemas for create_login_ticket", () => {
      const tools = server["getTools"]();
      const loginTool = tools.find((t) => t.name === "create_login_ticket");

      expect(loginTool?.inputSchema.required).toContain("login_type");

      const props = loginTool?.inputSchema.properties as Record<
        string,
        { enum?: string[] }
      >;
      expect(props.login_type.enum).toContain("access_portal");
      expect(props.login_type.enum).toContain("resource_provider");
      expect(props.identity_provider.enum).toContain("Github");
      expect(props.identity_provider.enum).toContain("Google");
    });
  });
});
