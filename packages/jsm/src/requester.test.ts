/**
 * Who a ticket is filed under (D8-3069): a signed-in user's verified account,
 * never the email or name the model passes in.
 */
import { describe, it, expect, beforeEach, vi, type Mock } from "vitest";
import { requestContextStorage, type RequestContext } from "@access-mcp/shared";
import axios from "axios";
import { JsmServer } from "./server.js";

vi.mock("axios", () => ({
  default: { create: vi.fn(() => ({ post: vi.fn() })) },
}));

const SIGNED_IN: RequestContext = {
  actingUser: "jsmith@access-ci.org",
  actingUserAuth: "token",
  actingUserProfile: { email: "jane.smith@example.edu", name: "Jane Smith" },
};

const TICKET = {
  summary: "Cannot allocate GPUs on Delta",
  description: "Jobs stay pending.",
};

const UNVERIFIED_NOTE =
  "Filed through the ACCESS Assistant by someone who wasn't signed in. " +
  "The name, email and ACCESS ID were given in chat and aren't verified.";

describe("ticket requester", () => {
  let server: JsmServer;
  let post: Mock;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.JSM_PROXY_URL = "http://fake-proxy";
    delete process.env.JSM_DRY_RUN;
    post = vi.fn().mockResolvedValue({
      status: 200,
      data: { success: true, data: { ticketKey: "ACCESS-1", ticketUrl: "https://t/ACCESS-1" } },
    });
    (axios.create as Mock).mockReturnValue({ post });
    server = new JsmServer();
  });

  const call = (name: string, args: Record<string, unknown>, context?: RequestContext) => {
    const run = () =>
      server["handleToolCall"]({ method: "tools/call", params: { name, arguments: args } });
    return context ? requestContextStorage.run(context, run) : run();
  };
  const sent = () => post.mock.calls[0][1].requestFieldValues;
  const text = (result: Awaited<ReturnType<typeof call>>) =>
    JSON.parse((result.content[0] as { text: string }).text);

  it.each(["create_support_ticket", "create_login_ticket", "report_security_incident"])(
    "%s files a signed-in user's ticket under their verified account",
    async (tool) => {
      const result = await call(
        tool,
        {
          ...TICKET,
          login_type: "access_portal",
          user_email: "someone.else@example.com",
          user_name: "Someone Else",
          access_id: "someoneelse",
        },
        SIGNED_IN
      );

      expect(result.isError).toBeFalsy();
      expect(sent()).toMatchObject({
        email: "jane.smith@example.edu",
        name: "Jane Smith",
        accessId: "jsmith",
        description: "Jobs stay pending.",
      });
      expect(text(result).filed_as).toBe("jane.smith@example.edu");
    }
  );

  it("needs no email or name from a signed-in user", async () => {
    const result = await call("create_support_ticket", TICKET, SIGNED_IN);

    expect(result.isError).toBeFalsy();
    expect(sent().email).toBe("jane.smith@example.edu");
  });

  it("uses the given email, and says so, when the account has none on file", async () => {
    const result = await call(
      "create_support_ticket",
      { ...TICKET, user_email: "jane@example.org", user_name: "Jane" },
      { ...SIGNED_IN, actingUserProfile: {} }
    );

    expect(result.isError).toBeFalsy();
    expect(sent()).toMatchObject({ email: "jane@example.org", name: "Jane", accessId: "jsmith" });
    expect(sent().description).toBe(
      "Jobs stay pending.\n\nFiled through the ACCESS Assistant by signed-in ACCESS user jsmith. " +
        "Their account has no usable email on file, so the email was given in chat."
    );
  });

  it("asks for an email when a signed-in account has none and none was given", async () => {
    const result = await call("create_support_ticket", TICKET, {
      ...SIGNED_IN,
      actingUserProfile: {},
    });

    expect(result.isError).toBe(true);
    expect(post).not.toHaveBeenCalled();
  });

  it("marks an anonymous ticket as unverified", async () => {
    const result = await call("create_login_ticket", {
      ...TICKET,
      login_type: "access_portal",
      user_email: "locked.out@example.edu",
      user_name: "Locked Out",
      access_id: "lockedout",
    });

    expect(result.isError).toBeFalsy();
    expect(sent()).toMatchObject({
      email: "locked.out@example.edu",
      name: "Locked Out",
      accessId: "lockedout",
      description: `Jobs stay pending.\n\n${UNVERIFIED_NOTE}`,
    });
  });

  it("treats a header-only acting user as unverified", async () => {
    await call(
      "create_support_ticket",
      { ...TICKET, user_email: "a@example.edu", user_name: "A" },
      { actingUser: "jsmith@access-ci.org", actingUserAuth: "header" }
    );

    expect(sent().email).toBe("a@example.edu");
    expect(sent().description).toContain(UNVERIFIED_NOTE);
  });

  it("asks an anonymous user for their name and email", async () => {
    const result = await call("create_support_ticket", { ...TICKET, user_name: "No Email" });

    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toMatch(/name and email/);
    expect(post).not.toHaveBeenCalled();
  });

  it("doesn't require an email or name in the schema", () => {
    const tools = server["getTools"]();
    for (const name of [
      "create_support_ticket",
      "create_login_ticket",
      "report_security_incident",
    ]) {
      const tool = tools.find((t) => t.name === name)!;
      expect(tool.inputSchema.required).not.toContain("user_email");
      expect(tool.inputSchema.required).not.toContain("user_name");
    }
  });
});
