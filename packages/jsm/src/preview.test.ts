/**
 * The ticket tools preview until the Confirm button sets confirmed: true
 * (D8-3088). A preview files nothing and shows what would be filed.
 */
import { describe, it, expect, beforeEach, vi, type Mock } from "vitest";
import { requestContextStorage, type RequestContext } from "@access-mcp/shared";
import axios from "axios";
import { JsmServer } from "./server.js";

vi.mock("axios", () => ({
  default: { create: vi.fn(() => ({ post: vi.fn() })) },
}));

const TOKEN: RequestContext = {
  actingUser: "jsmith@access-ci.org",
  actingUserAuth: "token",
  actingUserProfile: { email: "jane.smith@example.edu", name: "Jane Smith" },
};
const HEADER: RequestContext = { actingUser: "jsmith@access-ci.org", actingUserAuth: "header" };

const CALLS: Record<string, Record<string, unknown>> = {
  create_support_ticket: {
    summary: "Cannot allocate GPUs",
    description: "Jobs stay pending.",
    user_email: "chat@example.com",
    priority: "high",
    category: "Allocation Question",
    resource: "Delta",
    user_id_at_resource: "jsmith",
  },
  create_login_ticket: {
    summary: "Cannot log in",
    description: "Loop at the IdP.",
    user_email: "chat@example.com",
    login_type: "access_portal",
    identity_provider: "ORCID",
    browser: "Firefox",
  },
  report_security_incident: {
    summary: "Exposed key",
    description: "A key is public.",
    user_email: "chat@example.com",
    priority: "critical",
  },
};
const TOOLS = Object.keys(CALLS);

describe("ticket previews", () => {
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
  const json = (r: Awaited<ReturnType<typeof call>>) =>
    JSON.parse((r.content[0] as { text: string }).text);

  describe.each(TOOLS)("%s", (tool) => {
    it("previews without confirmed and never calls the proxy", async () => {
      const out = json(await call(tool, CALLS[tool]));
      expect(post).not.toHaveBeenCalled();
      expect(out).toMatchObject({ action: "create_ticket", status: "preview", executed: false });
      expect(out.data).toMatchObject({
        summary: CALLS[tool].summary,
        filed_as: "chat@example.com",
      });
      expect(out.data.request_type).toEqual(expect.any(String));
    });

    it.each([["true"], [1], [false], [null]])("treats confirmed %j as a preview", async (v) => {
      const out = json(await call(tool, { ...CALLS[tool], confirmed: v }));
      expect(post).not.toHaveBeenCalled();
      expect(out.status).toBe("preview");
    });

    it("previews in dry-run mode without consuming a dry-run key", async () => {
      process.env.JSM_DRY_RUN = "true";
      const dry = new JsmServer();
      const run = (args: Record<string, unknown>) =>
        dry["handleToolCall"]({ method: "tools/call", params: { name: tool, arguments: args } });
      const preview = JSON.parse(((await run(CALLS[tool])).content[0] as { text: string }).text);
      expect(preview.status).toBe("preview");
      const done = JSON.parse(
        ((await run({ ...CALLS[tool], confirmed: true })).content[0] as { text: string }).text
      );
      expect(done.ticket_key).toBe("DRYRUN-001");
    });

    it("previews for an anonymous caller exactly what the commit then files", async () => {
      const preview = json(await call(tool, CALLS[tool]));
      const committed = json(await call(tool, { ...CALLS[tool], confirmed: true }));
      const sent = post.mock.calls[0][1].requestFieldValues;
      expect(post).toHaveBeenCalledTimes(1);
      expect(preview.data.description).toBe(sent.description);
      expect(preview.data.summary).toBe(sent.summary);
      expect(preview.data.filed_as).toBe(committed.filed_as);
      expect(preview.data.description).toContain("wasn't signed in");
    });

    it("previews for a token caller the verified email and note, same as the commit", async () => {
      const preview = json(await call(tool, CALLS[tool], TOKEN));
      const committed = json(await call(tool, { ...CALLS[tool], confirmed: true }, TOKEN));
      const sent = post.mock.calls[0][1].requestFieldValues;
      expect(preview.data.filed_as).toBe("jane.smith@example.edu");
      expect(preview.data.filed_as).toBe(committed.filed_as);
      expect(preview.data.description).toBe(sent.description);
    });

    it("previews for a header caller the unverified note, same as the commit", async () => {
      const preview = json(await call(tool, CALLS[tool], HEADER));
      const committed = json(await call(tool, { ...CALLS[tool], confirmed: true }, HEADER));
      const sent = post.mock.calls[0][1].requestFieldValues;
      expect(preview.data.description).toContain(
        "Filed through the ACCESS Assistant, which named ACCESS user jsmith."
      );
      expect(preview.data.description).toBe(sent.description);
      expect(preview.data.filed_as).toBe(committed.filed_as);
    });

    it("returns the same error as the commit when the requester can't be determined", async () => {
      const { user_email: _omit, ...noEmail } = CALLS[tool];
      const preview = await call(tool, noEmail);
      expect(preview.isError).toBe(true);
      expect(post).not.toHaveBeenCalled();
    });

    it("tells the model to preview and never pass confirmed", () => {
      const def = server["getTools"]().find((t) => t.name === tool)!;
      expect(def.description).toContain(
        "Previews by default and changes nothing; call again with confirmed: true to make the change."
      );
      expect(def.description).toContain("Confirm button");
      expect(def.description).toContain("you never pass confirmed yourself");
      const props = def.inputSchema.properties as Record<string, { description?: string }>;
      expect(props.confirmed.description).toBe("Set only by the Confirm button; never set it yourself.");
    });
  });

  it("shows the category, priority and resource a support ticket carries", async () => {
    const { data } = json(await call("create_support_ticket", CALLS.create_support_ticket));
    expect(data).toMatchObject({
      request_type: "General support",
      priority: "high",
      category: "Allocation Question",
      resource: "Delta",
      user_id_at_resource: "jsmith",
    });
  });

  it("shows the login fields and the priority of a security report", async () => {
    const login = json(await call("create_login_ticket", CALLS.create_login_ticket)).data;
    expect(login).toMatchObject({ identity_provider: "ORCID", browser: "Firefox" });
    const sec = json(await call("report_security_incident", CALLS.report_security_incident)).data;
    expect(sec).toMatchObject({ request_type: "Security incident", priority: "critical" });
  });
});
