import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll, vi } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createHmac } from "node:crypto";
import {
  SignJWT,
  createLocalJWKSet,
  exportJWK,
  generateKeyPair,
  type JWK,
  type JWTPayload,
  type CryptoKey,
} from "jose";
import {
  BaseAccessServer,
  getRequestContext,
  type Resource,
  type CallToolResult,
} from "../base-server.js";
import type { ToolWithAccess } from "../tool-access.js";
import type { CallToolRequest } from "@modelcontextprotocol/sdk/types.js";
import {
  ActingUserTokenVerifier,
  ActingUserTokenUnavailableError,
  InvalidActingUserTokenError,
  actingUserTokenConfigFromEnv,
} from "../acting-user-token.js";

const ISSUER = "https://support.access-ci.org";
const MCP_AUD = "https://mcp.access-ci.org";
const AGENT_AUD = "https://qa.access-ci.org";
const XDMOD_AUD = "https://xdmod.access-ci.org";
const SUB = "jsmith@access-ci.org";
const KEY = "test-key-123";

interface Keys {
  exchange: { privateKey: CryptoKey; jwk: JWK };
  agent: { privateKey: CryptoKey; jwk: JWK };
  stranger: { privateKey: CryptoKey; jwk: JWK };
}
let keys: Keys;

async function keypair(kid: string) {
  const { privateKey, publicKey } = await generateKeyPair("ES256", { extractable: true });
  const jwk = { ...(await exportJWK(publicKey)), kid, alg: "ES256", use: "sig" };
  return { privateKey, jwk };
}

/** The portal's exchange-jwks.json: the agent key and the exchange key. */
/** Set during a rotation test: the portal has started publishing a new key. */
let rotatedIn = false;
const jwks = () => ({
  keys: [keys.agent.jwk, keys.exchange.jwk, ...(rotatedIn ? [keys.stranger.jwk] : [])],
});

const now = () => Math.floor(Date.now() / 1000);

/** An MCP token as /api/token-exchange mints it, with overrides. */
async function mcpToken(
  claims: Partial<JWTPayload> & Record<string, unknown> = {},
  opts: { key?: keyof Keys; header?: Record<string, unknown>; drop?: string[] } = {}
): Promise<string> {
  const t = now();
  const payload: Record<string, unknown> = {
    iss: ISSUER,
    sub: SUB,
    aud: MCP_AUD,
    azp: "access-assistant",
    scope: "mcp:write",
    iat: t,
    exp: t + 900,
    jti: `jti-${Math.random().toString(36).slice(2)}`,
    ...claims,
  };
  for (const k of opts.drop ?? []) delete payload[k];
  const key = keys[opts.key ?? "exchange"];
  return new SignJWT(payload)
    .setProtectedHeader({ alg: "ES256", typ: "at+jwt", kid: key.jwk.kid, ...opts.header })
    .sign(key.privateKey);
}

/** The agent's own token: same issuer and JWKS, the agent's audience. */
const agentToken = () =>
  mcpToken(
    { aud: AGENT_AUD, azp: "access-qa-bot", scope: "agent:read agent:write" },
    { key: "agent" }
  );

const b64 = (v: unknown) =>
  Buffer.from(typeof v === "string" ? v : JSON.stringify(v)).toString("base64url");

function unsigned(payload: Record<string, unknown>): string {
  return `${b64({ alg: "none", typ: "at+jwt", kid: keys.exchange.jwk.kid })}.${b64(payload)}.`;
}

/** HS256 keyed with the public JWK, the classic algorithm-confusion forgery. */
function hs256WithPublicKey(payload: Record<string, unknown>): string {
  const head = `${b64({ alg: "HS256", typ: "at+jwt", kid: keys.exchange.jwk.kid })}.${b64(payload)}`;
  const sig = createHmac("sha256", JSON.stringify(keys.exchange.jwk))
    .update(head)
    .digest("base64url");
  return `${head}.${sig}`;
}

const goodClaims = () => {
  const t = now();
  return {
    iss: ISSUER,
    sub: SUB,
    aud: MCP_AUD,
    azp: "access-assistant",
    scope: "mcp:write",
    iat: t,
    exp: t + 900,
    jti: "j",
  };
};

beforeAll(async () => {
  keys = {
    exchange: await keypair("exchange-kid"),
    agent: await keypair("agent-kid"),
    stranger: await keypair("stranger-kid"),
  };
});

describe("ActingUserTokenVerifier", () => {
  const config = {
    mode: "either" as const,
    issuer: ISSUER,
    audience: MCP_AUD,
    allowedAzp: ["access-assistant"],
    kids: ["exchange-kid"],
  };
  const verifier = () => new ActingUserTokenVerifier(config, { getKey: createLocalJWKSet(jwks()) });

  it("accepts an exchanged MCP token and returns its sub", async () => {
    const result = await verifier().verify(await mcpToken());
    expect(result.sub).toBe(SUB);
  });

  it("returns the account's email and name when the token names them (D8-3069)", async () => {
    const result = await verifier().verify(
      await mcpToken({ email: " jane@example.edu ", name: "Jane Smith" })
    );
    expect(result).toMatchObject({ sub: SUB, email: "jane@example.edu", name: "Jane Smith" });
  });

  it("leaves out an email or name that isn't a non-empty string", async () => {
    const result = await verifier().verify(await mcpToken({ email: 42, name: "  " }));
    expect(result).not.toHaveProperty("email");
    expect(result).not.toHaveProperty("name");
  });

  const refused: Array<[string, () => Promise<string> | string]> = [
    ["the agent's own token (agent audience)", agentToken],
    ["an XDMoD token", () => mcpToken({ aud: XDMOD_AUD, scope: "xdmod:read" })],
    ["an audience list containing ours", () => mcpToken({ aud: [MCP_AUD, XDMOD_AUD] })],
    ["an audience with a trailing slash", () => mcpToken({ aud: `${MCP_AUD}/` })],
    ["an expired token", () => mcpToken({ iat: now() - 1000, exp: now() - 100 })],
    ["a wrong issuer", () => mcpToken({ iss: "https://evil.example.org" })],
    ["an issuer with a trailing slash", () => mcpToken({ iss: `${ISSUER}/` })],
    ["a token without mcp:write", () => mcpToken({ scope: "xdmod:read" })],
    ["a token with no scope", () => mcpToken({}, { drop: ["scope"] })],
    ["another client's azp", () => mcpToken({ azp: "access-qa-bot" })],
    ["a lifetime over 900 seconds", () => mcpToken({ iat: now(), exp: now() + 3600 })],
    ["an iat in the future", () => mcpToken({ iat: now() + 300, exp: now() + 900 })],
    ["typ JWT", () => mcpToken({}, { header: { typ: "JWT" } })],
    ["no jti", () => mcpToken({}, { drop: ["jti"] })],
    ["no sub", () => mcpToken({}, { drop: ["sub"] })],
    ["an empty sub", () => mcpToken({ sub: "" })],
    ["a key not in the JWKS", () => mcpToken({}, { key: "stranger" })],
    [
      "the agent key under the exchange kid",
      () => mcpToken({}, { key: "agent", header: { kid: "exchange-kid" } }),
    ],
    ["alg none", () => unsigned(goodClaims())],
    ["HS256 keyed with the public JWK", () => hs256WithPublicKey(goodClaims())],
    ["garbage", () => "not-a-jwt"],
    // The agent key is in the same JWKS; only the exchange key may sign these.
    ["valid MCP claims signed by the agent key", () => mcpToken({}, { key: "agent" })],
    ["no kid", () => mcpToken({}, { header: { kid: undefined } })],
  ];

  it.each(refused)("refuses %s", async (_name, make) => {
    await expect(verifier().verify(await make())).rejects.toBeInstanceOf(
      InvalidActingUserTokenError
    );
  });

  it("reports an unreachable JWKS as unavailable, not as a bad token", async () => {
    const v = new ActingUserTokenVerifier(config, {
      getKey: async () => {
        throw new TypeError("fetch failed");
      },
    });
    await expect(v.verify(await mcpToken())).rejects.toBeInstanceOf(
      ActingUserTokenUnavailableError
    );
  });
});

describe("actingUserTokenConfigFromEnv", () => {
  it("defaults to either, the MCP audience and access-assistant, verifying nothing", () => {
    expect(actingUserTokenConfigFromEnv({})).toEqual({
      mode: "either",
      issuer: undefined,
      jwksUrl: undefined,
      audience: MCP_AUD,
      allowedAzp: ["access-assistant"],
      kids: [],
    });
  });
  it("requires the exchange key's kid once an issuer is set", () => {
    expect(() => actingUserTokenConfigFromEnv({ MCP_TOKEN_ISSUER: ISSUER })).toThrow(
      /MCP_TOKEN_KIDS/
    );
    expect(
      actingUserTokenConfigFromEnv({ MCP_TOKEN_ISSUER: ISSUER, MCP_TOKEN_KIDS: "a, b" }).kids
    ).toEqual(["a", "b"]);
  });
  it("derives the JWKS URL from the issuer", () => {
    expect(
      actingUserTokenConfigFromEnv({ MCP_TOKEN_ISSUER: ISSUER, MCP_TOKEN_KIDS: "k" }).jwksUrl
    ).toBe(`${ISSUER}/.well-known/exchange-jwks.json`);
  });
  it("refuses token mode without an issuer", () => {
    expect(() => actingUserTokenConfigFromEnv({ MCP_ACTING_USER_AUTH: "token" })).toThrow(
      /MCP_TOKEN_ISSUER/
    );
  });
  it("refuses an unknown mode", () => {
    expect(() => actingUserTokenConfigFromEnv({ MCP_ACTING_USER_AUTH: "off" })).toThrow(/either/);
  });
});

// --- The /tools route on a server that acts for users -----------------------

class ActingServer extends BaseAccessServer {
  constructor(actsForUsers = true, headerOnlyIsUnverified = false) {
    super("acting-test", "1.0.0", "https://api.example.com", {
      requireApiKey: true,
      actsForUsers,
      headerOnlyIsUnverified,
    });
  }
  protected getTools(): ToolWithAccess[] {
    const tools: ToolWithAccess[] = [
      {
        name: "search_things",
        description: "public read",
        inputSchema: { type: "object" },
        access: "public",
        mutates: false,
      },
      {
        name: "register_for_thing",
        description: "write",
        inputSchema: { type: "object" },
        access: "authenticated",
        mutates: true,
      },
    ];
    return tools;
  }
  protected getResources(): Resource[] {
    return [];
  }
  protected async handleToolCall(_req: CallToolRequest): Promise<CallToolResult> {
    const ctx = getRequestContext();
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            actingUser: ctx?.actingUser ?? null,
            auth: ctx?.actingUserAuth ?? null,
            ...(ctx?.actingUserProfile &&
              Object.keys(ctx.actingUserProfile).length > 0 && { profile: ctx.actingUserProfile }),
          }),
        },
      ],
    };
  }
  public get log() {
    return this.logger;
  }
  public envUser() {
    return this.envActingUser();
  }
}

/** A stand-in for the portal's JWKS and for mcp-auth's /verify, counting hits. */
let side: Server;
let sideUrl: string;
let hits: { jwks: number; oauthVerify: number; jwksDown: boolean };

beforeAll(async () => {
  side = createServer((req, res) => {
    if (req.url === "/.well-known/exchange-jwks.json") {
      hits.jwks++;
      if (hits.jwksDown) {
        res.writeHead(500).end();
        return;
      }
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(jwks()));
      return;
    }
    if (req.url === "/verify") {
      hits.oauthVerify++;
      res.writeHead(401, { "content-type": "application/json" }).end("{}");
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => side.listen(0, "127.0.0.1", resolve));
  sideUrl = `http://127.0.0.1:${(side.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await new Promise<void>((resolve) => side.close(() => resolve()));
});

describe("/tools on a server that acts for users", () => {
  let server: ActingServer | undefined;
  let baseUrl: string;
  const saved = { ...process.env };

  async function boot(
    env: Record<string, string | undefined> = {},
    actsForUsers = true,
    onCreate?: (s: ActingServer) => void,
    headerOnlyIsUnverified = false
  ) {
    Object.assign(process.env, {
      MCP_API_KEY: KEY,
      MCP_TOKEN_ISSUER: ISSUER,
      MCP_TOKEN_JWKS_URL: `${sideUrl}/.well-known/exchange-jwks.json`,
      MCP_TOKEN_KIDS: "exchange-kid",
      OAUTH_VERIFY_URL: `${sideUrl}/verify`,
    });
    for (const [k, v] of Object.entries(env)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    const s = new ActingServer(actsForUsers, headerOnlyIsUnverified);
    onCreate?.(s);
    await s.start({ httpPort: 0 });
    server = s;
    baseUrl = `http://localhost:${s.httpPort}`;
    return s;
  }

  async function call(tool: string, headers: Record<string, string>) {
    const res = await fetch(`${baseUrl}/tools/${tool}`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": KEY, ...headers },
      body: JSON.stringify({ arguments: {} }),
    });
    const body = await res.json();
    const ran = res.status === 200 ? JSON.parse(body.content[0].text) : null;
    return { status: res.status, body, ran, www: res.headers.get("www-authenticate") };
  }

  beforeEach(() => {
    hits = { jwks: 0, oauthVerify: 0, jwksDown: false };
    rotatedIn = false;
  });
  afterEach(async () => {
    await server?.stop();
    server = undefined;
    process.env = { ...saved };
    vi.restoreAllMocks();
  });

  it("a write with a valid token succeeds and is attributed to the token's sub", async () => {
    const s = await boot();
    const info = vi.spyOn(s.log, "warn");
    const r = await call("register_for_thing", { authorization: `Bearer ${await mcpToken()}` });
    expect(r.status).toBe(200);
    expect(r.ran).toEqual({ actingUser: SUB, auth: "token" });
    expect(info).toHaveBeenCalledWith("Acting user auth", {
      tool: "register_for_thing",
      path: "token",
      mutates: true,
    });
  });

  it("puts a verified token's email and name on the request context", async () => {
    await boot();
    const token = await mcpToken({ email: "jane@example.edu", name: "Jane Smith" });
    const r = await call("register_for_thing", { authorization: `Bearer ${token}` });
    expect(r.ran).toEqual({
      actingUser: SUB,
      auth: "token",
      profile: { email: "jane@example.edu", name: "Jane Smith" },
    });
  });

  it("in token mode, a header-only call runs unidentified when the server allows it", async () => {
    await boot({ MCP_ACTING_USER_AUTH: "token" }, true, undefined, true);
    const r = await call("register_for_thing", { "x-acting-user": SUB });
    expect(r.status).toBe(200);
    expect(r.ran).toEqual({ actingUser: null, auth: null });
  });

  it("in token mode, a bad token is still refused when header-only calls are allowed", async () => {
    await boot({ MCP_ACTING_USER_AUTH: "token" }, true, undefined, true);
    const r = await call("register_for_thing", { authorization: "Bearer not-a-token" });
    expect(r.status).toBe(401);
  });

  it("never takes an email or name from the header path", async () => {
    await boot();
    const r = await call("register_for_thing", { "x-acting-user": SUB });
    expect(r.ran).toEqual({ actingUser: SUB, auth: "header" });
  });

  it("a token with a matching X-Acting-User succeeds", async () => {
    await boot();
    const r = await call("register_for_thing", {
      authorization: `Bearer ${await mcpToken()}`,
      "x-acting-user": SUB,
    });
    expect(r.ran).toEqual({ actingUser: SUB, auth: "token" });
  });

  it("a token whose sub differs from X-Acting-User is refused", async () => {
    await boot();
    const r = await call("register_for_thing", {
      authorization: `Bearer ${await mcpToken()}`,
      "x-acting-user": "someone-else@access-ci.org",
    });
    expect(r.status).toBe(401);
    expect(r.body.error).toMatch(/does not match/);
  });

  it("in either mode (step 1), header-only still works and is logged as the header path", async () => {
    const s = await boot();
    const info = vi.spyOn(s.log, "warn");
    const r = await call("register_for_thing", { "x-acting-user": SUB });
    expect(r.status).toBe(200);
    expect(r.ran).toEqual({ actingUser: SUB, auth: "header" });
    expect(info).toHaveBeenCalledWith("Acting user auth", {
      tool: "register_for_thing",
      path: "header",
      mutates: true,
    });
  });

  it("in token mode (step 3), header-only plus the API key is refused", async () => {
    await boot({ MCP_ACTING_USER_AUTH: "token" });
    const r = await call("register_for_thing", { "x-acting-user": SUB });
    expect(r.status).toBe(401);
    expect(r.www).toMatch(/Bearer/);
  });

  it("in token mode, a valid token still succeeds", async () => {
    await boot({ MCP_ACTING_USER_AUTH: "token" });
    const r = await call("register_for_thing", { authorization: `Bearer ${await mcpToken()}` });
    expect(r.ran).toEqual({ actingUser: SUB, auth: "token" });
  });

  it("in token mode, an anonymous public read still works", async () => {
    await boot({ MCP_ACTING_USER_AUTH: "token" });
    const r = await call("search_things", {});
    expect(r.ran).toEqual({ actingUser: null, auth: null });
  });

  const badTokens: Array<[string, () => Promise<string> | string]> = [
    ["the agent's own token", agentToken],
    ["an expired token", () => mcpToken({ iat: now() - 1000, exp: now() - 100 })],
    ["a wrong issuer", () => mcpToken({ iss: "https://evil.example.org" })],
    ["a token missing mcp:write", () => mcpToken({ scope: "xdmod:read" })],
    ["alg none", () => unsigned(goodClaims())],
    ["HS256 keyed with the public JWK", () => hs256WithPublicKey(goodClaims())],
  ];

  it.each(badTokens)("refuses %s, and never falls back to X-Acting-User", async (_name, make) => {
    await boot();
    const r = await call("register_for_thing", {
      authorization: `Bearer ${await make()}`,
      "x-acting-user": SUB,
    });
    expect(r.status).toBe(401);
    expect(r.www).toMatch(/invalid_token/);
  });

  it("still requires the API key alongside a valid token", async () => {
    await boot();
    const res = await fetch(`${baseUrl}/tools/register_for_thing`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${await mcpToken()}` },
      body: JSON.stringify({ arguments: {} }),
    });
    expect(res.status).toBe(401);
  });

  it("refuses a Bearer when no issuer is configured, rather than ignoring it", async () => {
    await boot({ MCP_TOKEN_ISSUER: undefined, MCP_TOKEN_JWKS_URL: undefined });
    const r = await call("register_for_thing", {
      authorization: `Bearer ${await mcpToken()}`,
      "x-acting-user": SUB,
    });
    expect(r.status).toBe(401);
  });

  it("fetches the portal's JWKS at startup, before any call", async () => {
    await boot();
    expect(hits.jwks).toBe(1);
  });

  it("logs an error at startup when the JWKS can't be fetched", async () => {
    hits.jwksDown = true;
    let errorSpy: ReturnType<typeof vi.spyOn> | undefined;
    await boot({}, true, (s) => {
      errorSpy = vi.spyOn(s.log, "error");
    });
    expect(errorSpy).toHaveBeenCalledWith(
      "Acting-user token keys could not be fetched at startup",
      expect.anything()
    );
  });

  it("logs an error at startup when the pinned kid isn't in the JWKS", async () => {
    let errorSpy: ReturnType<typeof vi.spyOn> | undefined;
    await boot({ MCP_TOKEN_KIDS: "rotated-away" }, true, (s) => {
      errorSpy = vi.spyOn(s.log, "error");
    });
    expect(errorSpy).toHaveBeenCalledWith(
      "Acting-user token kid is not in the portal's JWKS",
      expect.anything()
    );
  });

  it("warns at startup when a server that acts for users can't verify tokens", async () => {
    let warnSpy: ReturnType<typeof vi.spyOn> | undefined;
    await boot(
      { MCP_TOKEN_ISSUER: undefined, MCP_TOKEN_KIDS: undefined, MCP_TOKEN_JWKS_URL: undefined },
      true,
      (s) => {
        warnSpy = vi.spyOn(s.log, "warn");
      }
    );
    expect(warnSpy).toHaveBeenCalledWith(
      "Acting-user tokens are not verified: MCP_TOKEN_ISSUER is not set",
      expect.anything()
    );
  });

  it("ignores ACTING_USER once the HTTP service is running", async () => {
    process.env.ACTING_USER = "env-user@access-ci.org";
    const s = new ActingServer();
    expect(s.envUser()).toBe("env-user@access-ci.org");
    await boot();
    expect(server!.envUser()).toBeUndefined();
    process.env.NODE_ENV = "production";
    expect(new ActingServer().envUser()).toBeUndefined();
  });

  it("picks up a pinned kid the portal publishes later (rotation), by refetching", async () => {
    const verifier = new ActingUserTokenVerifier(
      {
        mode: "either",
        issuer: ISSUER,
        jwksUrl: `${sideUrl}/.well-known/exchange-jwks.json`,
        audience: MCP_AUD,
        allowedAzp: ["access-assistant"],
        kids: ["exchange-kid", "stranger-kid"],
      },
      { cooldownMs: 0 }
    );
    expect(await verifier.checkKeys()).toBe("missing kid stranger-kid");
    const rotated = await mcpToken({}, { key: "stranger" });
    await expect(verifier.verify(rotated)).rejects.toBeInstanceOf(InvalidActingUserTokenError);
    rotatedIn = true;
    expect((await verifier.verify(rotated)).sub).toBe(SUB);
    expect((await verifier.verify(await mcpToken())).sub).toBe(SUB);
  });

  it("refuses to start in token mode without an issuer", async () => {
    process.env.MCP_ACTING_USER_AUTH = "token";
    delete process.env.MCP_TOKEN_ISSUER;
    const s = new ActingServer();
    await expect(s.start({ httpPort: 0 })).rejects.toThrow(/MCP_TOKEN_ISSUER/);
  });

  it("answers 503 when the portal's JWKS has never been fetched", async () => {
    hits.jwksDown = true;
    await boot();
    const r = await call("register_for_thing", { authorization: `Bearer ${await mcpToken()}` });
    expect(r.status).toBe(503);
  });

  it("never sends a /tools Bearer to the outside-client OAuth verifier", async () => {
    await boot();
    await call("register_for_thing", { authorization: `Bearer ${await mcpToken()}` });
    await call("register_for_thing", { authorization: "Bearer some-cilogon-access-token" });
    expect(hits.oauthVerify).toBe(0);
  });

  it("refuses an outside client's OAuth token on /tools", async () => {
    await boot();
    const r = await call("register_for_thing", {
      authorization: "Bearer some-cilogon-access-token",
      "x-acting-user": SUB,
    });
    expect(r.status).toBe(401);
  });

  it("keeps the OAuth path on /mcp for outside clients", async () => {
    await boot();
    await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: "Bearer some-cilogon-access-token",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "register_for_thing", arguments: {} },
      }),
    });
    expect(hits.oauthVerify).toBe(1);
  });

  it("leaves servers that don't act for users on the header (jsm)", async () => {
    await boot({ MCP_ACTING_USER_AUTH: "token" }, false);
    const r = await call("register_for_thing", {
      "x-acting-user": SUB,
      authorization: "Bearer anything",
    });
    expect(r.status).toBe(200);
    expect(r.ran).toEqual({ actingUser: SUB, auth: null });
  });
});
