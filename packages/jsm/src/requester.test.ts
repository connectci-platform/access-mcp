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
      server["handleToolCall"]({ method: "tools/call", params: { name, arguments: { confirmed: true, ...args } } });
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

  it("never pairs a verified email with a name from chat", async () => {
    await call(
      "create_support_ticket",
      { ...TICKET, user_name: "ACCESS Security Team" },
      { ...SIGNED_IN, actingUserProfile: { email: "jane.smith@example.edu" } }
    );

    expect(sent()).toMatchObject({ email: "jane.smith@example.edu", name: "jsmith" });
  });

  it("in token mode, lets a header-only call through on the header path", async () => {
    const saved = { ...process.env };
    try {
      Object.assign(process.env, {
        MCP_ACTING_USER_AUTH: "token",
        MCP_TOKEN_ISSUER: "https://support.access-ci.org",
        MCP_TOKEN_KIDS: "exchange-kid",
      });
      const jsm = new JsmServer();
      // The same resolution /tools runs before the tool (shared tests cover
      // the route itself, and that a bad token is still refused).
      const acting = await jsm["resolveActingUser"](undefined, "jsmith@access-ci.org");
      expect(acting).toMatchObject({
        ok: true,
        actingUser: "jsmith@access-ci.org",
        auth: "header",
      });
    } finally {
      process.env = saved;
    }
  });

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
    expect(sent()).toMatchObject({ email: "jane@example.org", name: "jsmith", accessId: "jsmith" });
    expect(sent().description).toBe(
      "Jobs stay pending.\n\nFiled through the ACCESS Assistant by signed-in ACCESS user jsmith. " +
        "Their sign-in didn't include an email, so the email was given in chat and isn't verified."
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
      access_id: "lockedout@access-ci.org",
    });

    expect(result.isError).toBeFalsy();
    expect(sent()).toMatchObject({
      email: "locked.out@example.edu",
      name: "Locked Out",
      accessId: "lockedout",
      description: `Jobs stay pending.\n\n${UNVERIFIED_NOTE}`,
    });
  });

  it("names a header-only ACCESS ID in the description only, as unverified", async () => {
    await call(
      "create_support_ticket",
      { ...TICKET, user_email: "a@example.edu", access_id: "someoneelse" },
      { actingUser: "jsmith@access-ci.org", actingUserAuth: "header" }
    );

    expect(sent()).toMatchObject({ email: "a@example.edu", name: "" });
    expect(sent()).not.toHaveProperty("accessId");
    expect(sent().description).toBe(
      "Jobs stay pending.\n\nFiled through the ACCESS Assistant, which named ACCESS user jsmith. " +
        "This wasn't verified: their sign-in couldn't be confirmed. The email was given in chat."
    );
  });

  it("says the name came from chat only when it did", async () => {
    await call(
      "create_support_ticket",
      { ...TICKET, user_email: "a@example.edu", user_name: "Jane Smith" },
      { actingUser: "jsmith@access-ci.org", actingUserAuth: "header" }
    );

    expect(sent().name).toBe("Jane Smith");
    expect(sent().description).toContain("The name and email were given in chat.");
  });

  it("asks a header-only user for an email only", async () => {
    const result = await call("create_support_ticket", TICKET, {
      actingUser: "jsmith@access-ci.org",
      actingUserAuth: "header",
    });

    expect(result.isError).toBe(true);
    const message = (result.content[0] as { text: string }).text;
    expect(message).toMatch(/email to reply to/);
    expect(message).not.toMatch(/name/);
    expect(post).not.toHaveBeenCalled();
  });

  it("files an anonymous ticket with only an email", async () => {
    const result = await call("create_login_ticket", {
      ...TICKET,
      login_type: "access_portal",
      user_email: "locked.out@example.edu",
    });

    expect(result.isError).toBeFalsy();
    expect(sent()).toMatchObject({ email: "locked.out@example.edu", name: "" });
    expect(sent().description).toContain(UNVERIFIED_NOTE);
  });

  it("asks an anonymous user for an email before filing", async () => {
    const result = await call("create_support_ticket", { ...TICKET, user_name: "No Email" });

    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toMatch(/ask for their email/);
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
