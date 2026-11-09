import { describe, it, expect, vi, beforeEach } from "vitest";

// Control axios.create so we can drive login + verb responses and defer sends.
const post = vi.fn();
const get = vi.fn();
const del = vi.fn();
const patch = vi.fn();
const create = vi.fn((_cfg?: unknown) => ({ post, get, delete: del, patch }));
vi.mock("axios", () => ({
  default: { create: (cfg: unknown) => create(cfg) },
}));

import { DrupalAuthProvider, DrupalApiError } from "../drupal-auth.js";

const LOGIN_OK = {
  status: 200,
  headers: { "set-cookie": ["SESS=abc; path=/; HttpOnly"] },
  data: { csrf_token: "csrf-1", logout_token: "lo-1", current_user: { uuid: "u-1" } },
};

function newProvider() {
  return new DrupalAuthProvider("https://drupal.example", "svc", "pw");
}

describe("DrupalAuthProvider per-call acting user", () => {
  beforeEach(() => {
    post.mockReset(); get.mockReset(); del.mockReset(); patch.mockReset(); create.mockClear();
    post.mockResolvedValue(LOGIN_OK); // default: login succeeds
  });

  it("creates the axios client with maxRedirects:0 so an auth 302 to CILogon is not followed", () => {
    // Root cause of the CILogon-HTML-as-tool-result bug: without maxRedirects:0,
    // axios follows Drupal's 302 auth redirect to CILogon and returns the login
    // page HTML as a fake 200. Stopping redirects keeps the 3xx status so the
    // caller surfaces a structured error instead of leaking the login page.
    newProvider();
    expect(create).toHaveBeenCalled();
    const cfg = create.mock.calls[0]?.[0] as { maxRedirects?: number };
    expect(cfg.maxRedirects).toBe(0);
  });

  it("getAuthHeaders puts the actingUser argument in X-Acting-User", async () => {
    const p = newProvider();
    await p.ensureAuthenticated();
    const headers = p.getAuthHeaders("alice@access-ci.org");
    expect(headers["X-Acting-User"]).toBe("alice@access-ci.org");
    expect(headers["Cookie"]).toContain("SESS=abc");
    expect(headers["X-CSRF-Token"]).toBe("csrf-1");
  });

  it("get forwards its actingUser argument as the header", async () => {
    const p = newProvider();
    get.mockResolvedValue({ status: 200, data: { ok: true } });
    await p.get("bob@access-ci.org", "/api/1.0/thing");
    const cfg = get.mock.calls.at(-1)![1];
    expect(cfg.headers["X-Acting-User"]).toBe("bob@access-ci.org");
  });

  it("delete forwards its actingUser argument as the header", async () => {
    const p = newProvider();
    del.mockResolvedValue({ status: 200, data: { status: "cancelled" } });
    await p.delete("carol@access-ci.org", "/api/1.0/thing/1");
    const cfg = del.mock.calls.at(-1)![1];
    expect(cfg.headers["X-Acting-User"]).toBe("carol@access-ci.org");
  });

  it("post forwards its actingUser argument as the header", async () => {
    const p = newProvider();
    // post is the login mock by default; make the NEXT post (the verb call) succeed.
    post.mockResolvedValueOnce(LOGIN_OK).mockResolvedValueOnce({ status: 200, data: { ok: true } });
    await p.post("erin@access-ci.org", "/api/1.0/thing", { field: 1 });
    const cfg = post.mock.calls.at(-1)![2]; // post(path, data, config) → config is 3rd arg
    expect(cfg.headers["X-Acting-User"]).toBe("erin@access-ci.org");
  });

  it("the 401 re-auth retry preserves the actingUser argument", async () => {
    const p = newProvider();
    // First GET → 403 (triggers invalidate + re-login + retry), retry → 200.
    get.mockResolvedValueOnce({ status: 403, data: {} })
       .mockResolvedValueOnce({ status: 200, data: { ok: true } });
    await p.get("dave@access-ci.org", "/api/1.0/thing");
    // Both the initial and retried GET must carry dave's header.
    for (const call of get.mock.calls) {
      expect(call[1].headers["X-Acting-User"]).toBe("dave@access-ci.org");
    }
  });

  it("requestRaw returns status and body on 409 without throwing", async () => {
    const p = newProvider();
    // Login is the default post mock; make the NEXT post (the verb call) a 409.
    post.mockResolvedValueOnce(LOGIN_OK).mockResolvedValueOnce({
      status: 409,
      data: { error: "already_registered", message: "You are already registered." },
    });
    const res = await p.requestRaw(
      "actor@access-ci.org",
      "POST",
      "/api/1.0/events/5/register",
      { confirmed: true }
    );
    expect(res.status).toBe(409);
    expect(res.data.error).toBe("already_registered");
    expect(res.data.message).toBe("You are already registered.");
    // Acting user must be forwarded exactly as post/delete do.
    const cfg = post.mock.calls.at(-1)![2]; // post(path, data, config) → config is 3rd arg
    expect(cfg.headers["X-Acting-User"]).toBe("actor@access-ci.org");
    expect(cfg.headers["Content-Type"]).toBe("application/json");
  });

  it("requestRaw returns status and body on a 2xx GET without throwing", async () => {
    const p = newProvider();
    get.mockResolvedValue({ status: 200, data: { id: "8504", title: "OnDemand" } });
    const res = await p.requestRaw("actor@access-ci.org", "GET", "/api/1.0/events/8504");
    expect(res.status).toBe(200);
    expect(res.data.id).toBe("8504");
    const cfg = get.mock.calls.at(-1)![1]; // get(path, config) → config is 2nd arg
    expect(cfg.headers["X-Acting-User"]).toBe("actor@access-ci.org");
  });

  it("requestRaw returns status and body on a 2xx POST without throwing", async () => {
    const p = newProvider();
    post.mockResolvedValueOnce(LOGIN_OK).mockResolvedValueOnce({
      status: 200,
      data: { success: true, status: "registered", registrant_id: "u-123" },
    });
    const res = await p.requestRaw(
      "actor@access-ci.org",
      "POST",
      "/api/1.0/events/5/register",
      { confirmed: true }
    );
    expect(res.status).toBe(200);
    expect(res.data.success).toBe(true);
    expect(res.data.registrant_id).toBe("u-123");
  });

  it("requestRaw does NOT auto-retry on a 403 (caller branches on status)", async () => {
    const p = newProvider();
    await p.ensureAuthenticated(); // log in up front so post is only the verb call
    post.mockResolvedValueOnce({
      status: 403,
      data: { message: "X-Acting-User did not resolve to an active user." },
    });
    const res = await p.requestRaw(
      "actor@access-ci.org",
      "POST",
      "/api/1.0/events/5/register",
      { confirmed: true }
    );
    expect(res.status).toBe(403);
    // Exactly one verb POST — no re-auth retry (login post happened in ensureAuthenticated).
    expect(post.mock.calls.length).toBe(2); // 1 login + 1 verb, no retry
  });

  // Bug #30: the throwing methods (get/post/patch/delete) flatten Drupal's
  // status + body into a plain Error string, losing both. They now throw a
  // DrupalApiError that carries .status (the number) and .body (parsed Drupal
  // body), while keeping the SAME message text so message-based catchers still
  // work. Cancel (events) and delete_announcement need to branch on status.
  it("delete throws a DrupalApiError with .status and .body on a JSON:API 404", async () => {
    const p = newProvider();
    del.mockResolvedValue({
      status: 404,
      statusText: "Not Found",
      data: { errors: [{ detail: "The resource was not found." }] },
    });
    let caught: unknown;
    try {
      await p.delete("actor@access-ci.org", "/api/2.3/announcements/gone");
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(DrupalApiError);
    const err = caught as DrupalApiError;
    expect(err.status).toBe(404);
    expect(err.body).toEqual({ errors: [{ detail: "The resource was not found." }] });
    // Back-compat: message unchanged from the old plain-Error text.
    expect(err.message).toBe("Drupal API error (404): The resource was not found.");
    expect(err.message).toContain("404");
    expect(err).toBeInstanceOf(Error); // still an Error for existing catchers
    expect(err.name).toBe("DrupalApiError");
  });

  it("get throws a DrupalApiError with .status and .body on a 403", async () => {
    const p = newProvider();
    // get() re-auths once on 403 then retries; make BOTH the initial and retry
    // GET return 403 so handleResponse throws on the retry response.
    get.mockResolvedValue({
      status: 403,
      statusText: "Forbidden",
      data: { errors: [{ detail: "Access denied." }] },
    });
    let caught: unknown;
    try {
      await p.get("actor@access-ci.org", "/api/2.3/thing");
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(DrupalApiError);
    const err = caught as DrupalApiError;
    expect(err.status).toBe(403);
    expect(err.body).toEqual({ errors: [{ detail: "Access denied." }] });
    expect(err.message).toBe("Drupal API error (403): Access denied.");
  });

  it("hides the JSON:API detail of a 5xx from the error message but keeps it on .body", async () => {
    const p = newProvider();
    get.mockResolvedValue({
      status: 500,
      statusText: "Internal Server Error",
      data: { errors: [{ detail: "SQLSTATE[42S02]: Base table or view not found: 1146 Table 'drupal.x'" }] },
    });
    let caught: unknown;
    try {
      await p.get("actor@access-ci.org", "/api/2.3/thing");
    } catch (e) {
      caught = e;
    }
    const err = caught as DrupalApiError;
    expect(err.status).toBe(500);
    expect(err.message).toBe("Drupal API error (500)");
    expect(JSON.stringify(err.body)).toContain("SQLSTATE");
  });

  it("logs a 5xx as status, method and path only, never the body", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const p = newProvider();
      get.mockResolvedValue({
        status: 500,
        statusText: "Internal Server Error",
        config: { method: "get", url: "/api/2.3/thing?mail=alice@example.org" },
        data: { errors: [{ detail: "SQLSTATE[42S02]: Table 'drupal.x' for alice@example.org" }] },
      });
      await expect(p.get("actor@access-ci.org", "/api/2.3/thing")).rejects.toThrow();
      const lines = spy.mock.calls.map((c) => c.join(" ")).join("\n");
      expect(lines).toContain('"upstream":"drupal"');
      expect(lines).toContain('"status":500');
      expect(lines).toContain('"method":"GET"');
      expect(lines).toContain('"path":"/api/2.3/thing"');
      expect(lines).not.toContain("SQLSTATE");
      expect(lines).not.toContain("alice@example.org");
      expect(lines).not.toContain("actor@access-ci.org");
    } finally {
      spy.mockRestore();
    }
  });

  it("does not re-login or retry a 403 that carries a controller refusal body", async () => {
    const p = newProvider();
    await p.ensureAuthenticated();
    post.mockClear();
    post.mockResolvedValueOnce({
      status: 403,
      statusText: "Forbidden",
      data: { error: "forbidden", message: "You may not archive this event." },
    });
    let caught: unknown;
    try {
      await p.post("actor@access-ci.org", "/api/1.0/events/5/archive", {});
    } catch (e) {
      caught = e;
    }
    // One verb POST, no login POST, no retry.
    expect(post.mock.calls.length).toBe(1);
    const err = caught as DrupalApiError;
    expect(err.status).toBe(403);
    expect(err.body).toEqual({ error: "forbidden", message: "You may not archive this event." });
  });

  it("hides the JSON:API detail of a 3xx from the error message", async () => {
    const p = newProvider();
    get.mockResolvedValue({
      status: 301,
      statusText: "Moved Permanently",
      headers: {},
      data: { errors: [{ detail: "internal path /var/www/x" }] },
    });
    const err = (await p.get("a@access-ci.org", "/api/x").catch((e) => e)) as DrupalApiError;
    expect(err.status).toBe(301);
    expect(err.message).toBe("Drupal API error (301)");
  });

  describe("403 refusal shape", () => {
    const verbs = [
      ["post", (p: DrupalAuthProvider) => p.post("a@access-ci.org", "/x", {}), () => post],
      ["patch", (p: DrupalAuthProvider) => p.patch("a@access-ci.org", "/x", {}), () => patch],
      ["delete", (p: DrupalAuthProvider) => p.delete("a@access-ci.org", "/x"), () => del],
    ] as const;

    it.each(verbs)("%s does not retry a 403 with {error, message}", async (name, run, mock) => {
      const p = newProvider();
      await p.ensureAuthenticated();
      post.mockClear();
      mock().mockResolvedValueOnce({
        status: 403,
        statusText: "Forbidden",
        data: { error: "forbidden", message: "Nope." },
      });
      const err = (await run(p).catch((e: unknown) => e)) as DrupalApiError;
      expect(err.status).toBe(403);
      expect(mock().mock.calls.length).toBe(1);
      // For post the verb call is itself the one post; no login post follows.
      expect(post.mock.calls.length).toBe(name === "post" ? 1 : 0);
    });

    it.each([
      ["message only", { message: "Access denied." }],
      ["error only", { error: "forbidden" }],
      ["an HTML string", "<html>Forbidden</html>"],
      ["null", null],
      ["JSON:API errors", { errors: [{ detail: "Forbidden" }] }],
    ])("retries a 403 whose body is %s", async (_n, data) => {
      const p = newProvider();
      await p.ensureAuthenticated();
      post.mockClear();
      post
        .mockResolvedValueOnce({ status: 403, statusText: "Forbidden", data })
        .mockResolvedValueOnce(LOGIN_OK)
        .mockResolvedValueOnce({ status: 200, data: { ok: true } });
      expect(await p.post("a@access-ci.org", "/x", {})).toEqual({ ok: true });
      expect(post.mock.calls.length).toBe(3);
    });

    it("retries a 401 even with a refusal-shaped body", async () => {
      const p = newProvider();
      await p.ensureAuthenticated();
      post.mockClear();
      post
        .mockResolvedValueOnce({
          status: 401,
          statusText: "Unauthorized",
          data: { error: "x", message: "y" },
        })
        .mockResolvedValueOnce(LOGIN_OK)
        .mockResolvedValueOnce({ status: 200, data: { ok: true } });
      expect(await p.post("a@access-ci.org", "/x", {})).toEqual({ ok: true });
      expect(post.mock.calls.length).toBe(3);
    });
  });

  it("still re-logs in once for a 403 with no refusal body", async () => {
    const p = newProvider();
    await p.ensureAuthenticated();
    post.mockClear();
    post
      .mockResolvedValueOnce({ status: 403, statusText: "Forbidden", data: {} })
      .mockResolvedValueOnce(LOGIN_OK)
      .mockResolvedValueOnce({ status: 200, data: { ok: true } });
    const res = await p.post("actor@access-ci.org", "/api/1.0/events/5/archive", {});
    expect(res).toEqual({ ok: true });
    expect(post.mock.calls.length).toBe(3); // verb, login, retried verb
  });

  it("post throws a DrupalApiError carrying a flat (non-JSON:API-errors) body on 409", async () => {
    const p = newProvider();
    // Login is the default post mock; make the NEXT post (the verb call) a 409
    // with a FLAT body (no .errors array) — hits the statusText message branch.
    post.mockResolvedValueOnce(LOGIN_OK).mockResolvedValueOnce({
      status: 409,
      statusText: "Conflict",
      data: { error: "already_registered", message: "You are already registered." },
    });
    let caught: unknown;
    try {
      await p.post("actor@access-ci.org", "/api/2.3/thing", { field: 1 });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(DrupalApiError);
    const err = caught as DrupalApiError;
    expect(err.status).toBe(409);
    // Full parsed body preserved so callers can read .error / .message.
    expect(err.body).toEqual({
      error: "already_registered",
      message: "You are already registered.",
    });
    // Flat-body branch keeps the old "status statusText" message text.
    expect(err.message).toBe("Drupal API error: 409 Conflict");
  });

  // Production bug (2026-08-12): this CILogon-fronted Drupal signals an EXPIRED
  // session as a 3xx redirect to the login page, not a 401/403. With
  // maxRedirects:0 the raw 3xx came back and never matched the 401/403 recovery
  // condition, so isAuthenticated was never reset and every authenticated call
  // failed with "Drupal API error: 307 Temporary Redirect" until process restart.
  // 3xx must therefore drive the same invalidate → re-login → retry-once path.
  describe("3xx session-expiry recovery", () => {
    it("get re-logs-in and retries ONCE when the session expired (307), then succeeds", async () => {
      const p = newProvider();
      await p.ensureAuthenticated(); // log in up front; post is then login-only
      post.mockResolvedValue(LOGIN_OK); // the re-login inside the recovery path
      get.mockResolvedValueOnce({ status: 307, statusText: "Temporary Redirect", data: "" })
         .mockResolvedValueOnce({ status: 200, data: { registrations: [] } });

      const body = await p.get("dave@access-ci.org", "/api/1.0/registrations");

      expect(body).toEqual({ registrations: [] });
      expect(get.mock.calls.length).toBe(2); // initial + exactly one retry
      expect(post.mock.calls.length).toBe(2); // initial login + exactly one re-login
      // Retry must carry the acting user and the FRESH session cookie.
      expect(get.mock.calls[1][1].headers["X-Acting-User"]).toBe("dave@access-ci.org");
    });

    it("get surfaces a structured DrupalApiError when the retry is ALSO 3xx (no loop)", async () => {
      const p = newProvider();
      get.mockResolvedValue({ status: 307, statusText: "Temporary Redirect", data: "" });
      let caught: unknown;
      try {
        await p.get("dave@access-ci.org", "/api/1.0/registrations");
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(DrupalApiError);
      expect((caught as DrupalApiError).status).toBe(307);
      // Bounded: exactly one retry, never a recursive re-entry.
      expect(get.mock.calls.length).toBe(2);
    });

    it("codes a retry that still redirects to sign-in after a fresh login, and logs the target without its query", async () => {
      const p = newProvider();
      await p.ensureAuthenticated();
      const warn = vi.fn();
      (p as unknown as { logger: { warn: typeof warn } }).logger.warn = warn;
      const bounce = {
        status: 302,
        statusText: "Found",
        headers: { location: "https://support.access-ci.org/user/login?destination=/api/suggest-tags&token=secret" },
        data: "",
      };
      post.mockResolvedValueOnce(bounce).mockResolvedValueOnce(LOGIN_OK).mockResolvedValueOnce(bounce);

      let caught: unknown;
      try {
        await p.post("erin@access-ci.org", "/api/suggest-tags", { text: "t" });
      } catch (e) {
        caught = e;
      }

      expect(caught).toBeInstanceOf(DrupalApiError);
      expect((caught as DrupalApiError).status).toBe(302);
      expect((caught as DrupalApiError).code).toBe("auth_redirect_after_relogin");
      const logged = JSON.stringify(warn.mock.calls);
      expect(logged).toContain("/user/login");
      expect(logged).not.toContain("secret");
      expect(logged).not.toContain("destination");
    });

    it("codes the same case on get, patch and delete", async () => {
      const bounce = { status: 307, statusText: "Temporary Redirect", data: "" };
      for (const [verb, mock, run] of [
        ["get", get, (p: DrupalAuthProvider) => p.get("u", "/x")],
        ["patch", patch, (p: DrupalAuthProvider) => p.patch("u", "/x", {})],
        ["delete", del, (p: DrupalAuthProvider) => p.delete("u", "/x")],
      ] as const) {
        const p = newProvider();
        await p.ensureAuthenticated();
        mock.mockReset();
        mock.mockResolvedValue(bounce);
        const err = await run(p).catch((e: unknown) => e);
        expect((err as DrupalApiError).code, verb).toBe("auth_redirect_after_relogin");
      }
    });

    it("post recovers from a 302 session expiry and retries once", async () => {
      const p = newProvider();
      await p.ensureAuthenticated();
      post.mockResolvedValueOnce({ status: 302, statusText: "Found", data: "" }) // verb call
          .mockResolvedValueOnce(LOGIN_OK)                                       // re-login
          .mockResolvedValueOnce({ status: 201, data: { ok: true } });           // retry
      const body = await p.post("erin@access-ci.org", "/api/2.3/thing", { field: 1 });
      expect(body).toEqual({ ok: true });
    });

    it("delete recovers from a 307 session expiry and retries once", async () => {
      const p = newProvider();
      await p.ensureAuthenticated();
      post.mockResolvedValue(LOGIN_OK);
      del.mockResolvedValueOnce({ status: 307, statusText: "Temporary Redirect", data: "" })
         .mockResolvedValueOnce({ status: 204, data: { status: "cancelled" } });
      const body = await p.delete("carol@access-ci.org", "/api/1.0/registrations/1");
      expect(body).toEqual({ status: "cancelled" });
      expect(del.mock.calls.length).toBe(2);
    });

    it("patch recovers from a 307 session expiry and retries once", async () => {
      const p = newProvider();
      await p.ensureAuthenticated();
      post.mockResolvedValue(LOGIN_OK);
      patch.mockResolvedValueOnce({ status: 307, statusText: "Temporary Redirect", data: "" })
           .mockResolvedValueOnce({ status: 200, data: { ok: true } });
      const body = await p.patch("carol@access-ci.org", "/api/2.3/thing/1", { field: 2 });
      expect(body).toEqual({ ok: true });
      expect(patch.mock.calls.length).toBe(2);
    });

    // requestRaw deliberately has NO 401/403 retry so callers can branch on a
    // 403 (the events acting-user gate). A 3xx is different in kind: it is never
    // a caller-branchable outcome, only session expiry — so it DOES recover.
    it("requestRaw recovers from a 3xx session expiry and returns the retried result", async () => {
      const p = newProvider();
      await p.ensureAuthenticated();
      post.mockResolvedValue(LOGIN_OK);
      get.mockResolvedValueOnce({ status: 307, statusText: "Temporary Redirect", data: "" })
         .mockResolvedValueOnce({ status: 200, data: { id: "8504" } });
      const res = await p.requestRaw("actor@access-ci.org", "GET", "/api/2.3/events/8504");
      expect(res.status).toBe(200);
      expect(res.data.id).toBe("8504");
      expect(get.mock.calls.length).toBe(2);
    });

    it("requestRaw returns the raw 3xx when the retry is ALSO 3xx (bounded, no throw)", async () => {
      const p = newProvider();
      await p.ensureAuthenticated();
      post.mockResolvedValue(LOGIN_OK);
      get.mockResolvedValue({ status: 307, statusText: "Temporary Redirect", data: "" });
      const res = await p.requestRaw("actor@access-ci.org", "GET", "/api/2.3/events/8504");
      expect(res.status).toBe(307);
      expect(get.mock.calls.length).toBe(2); // exactly one retry
    });

    // Not every 3xx is session expiry. Only a redirect whose Location points at
    // CILogon or a /user/login path is the auth gate bouncing us; a config-level
    // 301 to a normalized URL must NOT burn a re-login and must stay visible.
    it("treats a 3xx whose Location points at CILogon as session expiry", async () => {
      const p = newProvider();
      await p.ensureAuthenticated();
      post.mockResolvedValue(LOGIN_OK);
      get.mockResolvedValueOnce({
        status: 302,
        statusText: "Found",
        headers: { location: "https://cilogon.org/authorize?client_id=x" },
        data: "",
      }).mockResolvedValueOnce({ status: 200, data: { ok: true } });
      const body = await p.get("dave@access-ci.org", "/api/1.0/registrations");
      expect(body).toEqual({ ok: true });
      expect(get.mock.calls.length).toBe(2);
    });

    it("treats a 3xx whose Location is a /user/login path as session expiry", async () => {
      const p = newProvider();
      await p.ensureAuthenticated();
      post.mockResolvedValue(LOGIN_OK);
      get.mockResolvedValueOnce({
        status: 307,
        statusText: "Temporary Redirect",
        headers: { location: "/user/login?destination=/api/1.0/registrations" },
        data: "",
      }).mockResolvedValueOnce({ status: 200, data: { ok: true } });
      const body = await p.get("dave@access-ci.org", "/api/1.0/registrations");
      expect(body).toEqual({ ok: true });
    });

    it("treats a 3xx with NO Location header as session expiry (safe fallback)", async () => {
      const p = newProvider();
      await p.ensureAuthenticated();
      post.mockResolvedValue(LOGIN_OK);
      get.mockResolvedValueOnce({ status: 307, statusText: "Temporary Redirect", data: "" })
         .mockResolvedValueOnce({ status: 200, data: { ok: true } });
      const body = await p.get("dave@access-ci.org", "/api/1.0/registrations");
      expect(body).toEqual({ ok: true });
    });

    // 304 Not Modified is numerically 3xx but is NOT a redirect — it carries no
    // Location and means "your cached copy is current". The missing-Location →
    // expiry fallback would otherwise misfire and burn a pointless re-login on
    // every conditional GET.
    it("does NOT treat a 304 Not Modified as session expiry", async () => {
      const p = newProvider();
      await p.ensureAuthenticated();
      const loginsBefore = post.mock.calls.length;
      get.mockResolvedValue({ status: 304, statusText: "Not Modified", data: "" });
      let caught: unknown;
      try {
        await p.get("dave@access-ci.org", "/api/1.0/registrations");
      } catch (e) {
        caught = e;
      }
      // Flows to handleResponse as an ordinary non-2xx, with no recovery attempt.
      expect(caught).toBeInstanceOf(DrupalApiError);
      expect((caught as DrupalApiError).status).toBe(304);
      expect(get.mock.calls.length).toBe(1); // no retry
      expect(post.mock.calls.length).toBe(loginsBefore); // no re-login
    });

    it("requestRaw does not re-login on a 304 and returns it raw", async () => {
      const p = newProvider();
      await p.ensureAuthenticated();
      const loginsBefore = post.mock.calls.length;
      get.mockResolvedValue({ status: 304, statusText: "Not Modified", data: "" });
      const res = await p.requestRaw("actor@access-ci.org", "GET", "/api/2.3/events/1");
      expect(res.status).toBe(304);
      expect(get.mock.calls.length).toBe(1);
      expect(post.mock.calls.length).toBe(loginsBefore);
    });

    it("does NOT re-login on a non-auth 3xx, and surfaces the Location in the error", async () => {
      const p = newProvider();
      await p.ensureAuthenticated();
      const loginsBefore = post.mock.calls.length;
      get.mockResolvedValue({
        status: 301,
        statusText: "Moved Permanently",
        headers: { location: "https://support.access-ci.org/api/1.0/registrations/" },
        data: "",
      });
      let caught: unknown;
      try {
        await p.get("dave@access-ci.org", "/api/1.0/registrations");
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(DrupalApiError);
      const err = caught as DrupalApiError;
      expect(err.status).toBe(301);
      // The real problem (where it wanted to send us) must be visible.
      expect(err.message).toContain("https://support.access-ci.org/api/1.0/registrations/");
      expect(get.mock.calls.length).toBe(1); // no retry
      expect(post.mock.calls.length).toBe(loginsBefore); // no re-login
    });

    it("requestRaw does not re-login on a non-auth 3xx and returns it raw", async () => {
      const p = newProvider();
      await p.ensureAuthenticated();
      const loginsBefore = post.mock.calls.length;
      get.mockResolvedValue({
        status: 301,
        statusText: "Moved Permanently",
        headers: { location: "https://support.access-ci.org/api/2.3/events/1/" },
        data: "",
      });
      const res = await p.requestRaw("actor@access-ci.org", "GET", "/api/2.3/events/1");
      expect(res.status).toBe(301);
      expect(get.mock.calls.length).toBe(1);
      expect(post.mock.calls.length).toBe(loginsBefore);
    });

    // Concurrent recoveries must ride ONE login, not stampede Drupal with N.
    it("single-flights the login when concurrent calls recover at the same time", async () => {
      const p = newProvider();
      await p.ensureAuthenticated();
      const loginsBefore = post.mock.calls.length;
      // Both GETs expire, then both succeed on retry.
      get.mockResolvedValueOnce({ status: 307, statusText: "Temporary Redirect", data: "" })
         .mockResolvedValueOnce({ status: 307, statusText: "Temporary Redirect", data: "" })
         .mockResolvedValue({ status: 200, data: { ok: true } });
      // Make the re-login slow so both recoveries overlap on it.
      let releaseLogin: (v: unknown) => void;
      const pendingLogin = new Promise<unknown>((res) => { releaseLogin = res; });
      post.mockImplementationOnce(() => pendingLogin);

      const a = p.get("alice@access-ci.org", "/a");
      const b = p.get("bob@access-ci.org", "/b");
      await Promise.resolve(); // let both reach their recovery
      await Promise.resolve();
      releaseLogin!(LOGIN_OK);
      await Promise.all([a, b]);

      // Exactly ONE re-login serviced both recoveries.
      expect(post.mock.calls.length).toBe(loginsBefore + 1);
    });

    it("re-login failure surfaces as reauth_failed, distinct from session expiry", async () => {
      const p = newProvider();
      await p.ensureAuthenticated();
      get.mockResolvedValue({ status: 307, statusText: "Temporary Redirect", data: "" });
      // The recovery's re-login itself fails — credentials/Drupal are the problem,
      // and a restart will NOT help. Must be distinguishable from plain expiry.
      post.mockResolvedValue({ status: 503, statusText: "Service Unavailable", data: {} });
      let caught: unknown;
      try {
        await p.get("dave@access-ci.org", "/api/1.0/registrations");
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(DrupalApiError);
      const err = caught as DrupalApiError;
      expect(err.code).toBe("reauth_failed");
      expect(err.message).toMatch(/re-authenticat/i);
      expect(err.message).toMatch(/operator/i);
      expect(err.message).not.toContain("503"); // the login failure text stays out of the caller message
    });

    it("re-login transport failure does not put the host in the reauth_failed message", async () => {
      const p = newProvider();
      await p.ensureAuthenticated();
      get.mockResolvedValue({ status: 307, statusText: "Temporary Redirect", data: "" });
      post.mockRejectedValue(new Error("connect ECONNREFUSED 10.1.2.3:443"));
      const err = (await p.get("dave@access-ci.org", "/api/1.0/registrations").catch((e) => e)) as DrupalApiError;
      expect(err.code).toBe("reauth_failed");
      expect(err.message).not.toContain("10.1.2.3");
      expect(err.message).toMatch(/operator/i);
    });

    it("logs one warning per recovery so session churn is visible in logs", async () => {
      const warn = vi.spyOn(console, "error").mockImplementation(() => {});
      try {
        const p = newProvider();
        await p.ensureAuthenticated();
        post.mockResolvedValue(LOGIN_OK);
        get.mockResolvedValueOnce({ status: 307, statusText: "Temporary Redirect", data: "" })
           .mockResolvedValueOnce({ status: 200, data: { ok: true } });
        await p.get("dave@access-ci.org", "/api/1.0/registrations");
        const messages = warn.mock.calls.map((c) => String(c[0]));
        expect(messages.some((m) => /session expired/i.test(m) && /WARN/.test(m))).toBe(true);
      } finally {
        warn.mockRestore();
      }
    });

    it("requestRaw still surfaces a 403 RAW with no retry (caller branches on it)", async () => {
      const p = newProvider();
      await p.ensureAuthenticated();
      post.mockResolvedValueOnce({
        status: 403,
        data: { message: "X-Acting-User did not resolve to an active user." },
      });
      const res = await p.requestRaw("actor@access-ci.org", "POST", "/api/1.0/events/5/register", {
        confirmed: true,
      });
      expect(res.status).toBe(403);
      expect(post.mock.calls.length).toBe(2); // 1 login + 1 verb, no retry, no re-login
    });
  });

  it("does not bleed acting users across interleaved concurrent calls (issue #13)", async () => {
    const p = newProvider();
    await p.ensureAuthenticated(); // log in up front so the interleave is GET-only, not a login race
    // Make request A's GET hang until we release it, so B can run in between.
    let releaseA: (v: unknown) => void;
    const aPending = new Promise<unknown>((res) => { releaseA = res; });
    get.mockImplementationOnce(() => aPending)                          // A's GET (deferred)
       .mockResolvedValueOnce({ status: 200, data: { who: "B" } });     // B's GET (immediate)

    const aPromise = p.get("alice@access-ci.org", "/a"); // starts, awaits deferred GET
    // Single tick: A's ensureAuthenticated is already resolved (pre-auth above),
    // so one microtask parks A at the deferred GET before B starts. Do not remove
    // this yield or collapse it — without it B could run before A reaches its GET,
    // and the interleave this test exists to prove would not happen.
    await Promise.resolve();
    await p.get("bob@access-ci.org", "/b");               // B runs fully while A is parked
    releaseA!({ status: 200, data: { who: "A" } });       // let A resume
    await aPromise;

    const aCall = get.mock.calls[0];
    const bCall = get.mock.calls[1];
    expect(aCall[1].headers["X-Acting-User"]).toBe("alice@access-ci.org");
    expect(bCall[1].headers["X-Acting-User"]).toBe("bob@access-ci.org");
  });
});
