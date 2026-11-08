import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import axios from "axios";
import type { OAuthClientInformationFull, OAuthTokenRevocationRequest } from "@modelcontextprotocol/sdk/shared/auth.js";
import { CILogonOAuthProvider, InMemoryClientStore } from "../cilogon-provider.js";
import { SqliteClientStore } from "../sqlite-client-store.js";

describe("InMemoryClientStore", () => {
  let store: InMemoryClientStore;

  beforeEach(() => {
    store = new InMemoryClientStore();
  });

  it("should register and retrieve a client", async () => {
    const client = {
      client_id: "test-client-id",
      client_secret: "test-secret",
      redirect_uris: ["http://localhost:3000/callback"],
    } as OAuthClientInformationFull;

    await store.registerClient(client);
    const retrieved = await store.getClient("test-client-id");
    expect(retrieved).toBeDefined();
    expect(retrieved?.client_id).toBe("test-client-id");
  });

  it("should return undefined for unknown client", async () => {
    const result = await store.getClient("nonexistent");
    expect(result).toBeUndefined();
  });
});

describe("CILogonOAuthProvider", () => {
  let provider: CILogonOAuthProvider;
  let providerClientStore: SqliteClientStore;

  beforeEach(() => {
    providerClientStore = new SqliteClientStore(":memory:");
    provider = new CILogonOAuthProvider({
      clientId: "test-cilogon-client-id",
      clientSecret: "test-cilogon-secret",
      externalBaseUrl: "https://mcp.access-ci.org/auth",
      clientStore: providerClientStore,
    });
  });

  afterEach(() => {
    providerClientStore.close();
  });

  it("should have skipLocalPkceValidation enabled", () => {
    expect(provider.skipLocalPkceValidation).toBe(true);
  });

  it("should have a clients store", () => {
    expect(provider.clientsStore).toBeDefined();
  });

  describe("authorize", () => {
    it("should redirect to CILogon with correct parameters", async () => {
      const client = {
        client_id: "mcp-client",
        redirect_uris: ["http://localhost:3000/callback"],
      } as OAuthClientInformationFull;

      const params = {
        state: "test-state",
        scopes: ["openid"],
        codeChallenge: "test-challenge",
        redirectUri: "http://localhost:3000/callback",
      };

      const res = {
        redirect: vi.fn(),
      } as unknown as import("express").Response;

      await provider.authorize(client, params, res);

      expect(res.redirect).toHaveBeenCalledTimes(1);
      const redirectUrl = new URL(res.redirect.mock.calls[0][0]);
      expect(redirectUrl.hostname).toBe("cilogon.org");
      expect(redirectUrl.pathname).toBe("/authorize");
      expect(redirectUrl.searchParams.get("client_id")).toBe("test-cilogon-client-id");
      expect(redirectUrl.searchParams.get("response_type")).toBe("code");
      expect(redirectUrl.searchParams.get("redirect_uri")).toBe(
        "https://mcp.access-ci.org/auth/callback"
      );
      expect(redirectUrl.searchParams.get("scope")).toContain("openid");
    });
  });

  describe("handleCallback", () => {
    it("should reject invalid state", async () => {
      await expect(
        provider.handleCallback("some-code", "invalid-state")
      ).rejects.toThrow("Invalid or expired authorization state");
    });
  });

  describe("exchangeAuthorizationCode", () => {
    it("should reject invalid code", async () => {
      const client = { client_id: "test" } as OAuthClientInformationFull;
      await expect(
        provider.exchangeAuthorizationCode(client, "invalid-code")
      ).rejects.toThrow("Invalid or expired authorization code");
    });
  });

  describe("verifyAccessToken", () => {
    it("should reject invalid tokens", async () => {
      await expect(
        provider.verifyAccessToken("invalid-token")
      ).rejects.toThrow("Invalid or expired access token");
    });

    describe("with CILogon stubbed", () => {
      const userinfo = {
        status: 200,
        data: { sub: "http://cilogon.org/u1", eppn: "u1@access-ci.org" },
      };
      let get: ReturnType<typeof vi.spyOn>;

      beforeEach(() => {
        vi.useFakeTimers({ now: new Date("2026-11-08T12:00:00Z"), toFake: ["Date"] });
        get = vi.spyOn(axios, "get");
      });

      afterEach(() => {
        get.mockRestore();
        vi.useRealTimers();
      });

      it.each([401, 403])("asks CILogon once about a token it rejected with %i", async (status) => {
        get.mockResolvedValue({ status, data: {} });

        await expect(provider.verifyAccessToken("expired")).rejects.toThrow();
        await expect(provider.verifyAccessToken("expired")).rejects.toThrow();

        expect(get).toHaveBeenCalledTimes(1);
      });

      it("remembers a rejection for one minute, like an acceptance", async () => {
        get.mockResolvedValue({ status: 401, data: {} });

        await expect(provider.verifyAccessToken("expired")).rejects.toThrow();
        vi.setSystemTime(new Date("2026-11-08T12:00:59Z"));
        await expect(provider.verifyAccessToken("expired")).rejects.toThrow();
        expect(get).toHaveBeenCalledTimes(1);

        vi.setSystemTime(new Date("2026-11-08T12:01:01Z"));
        await expect(provider.verifyAccessToken("expired")).rejects.toThrow();
        expect(get).toHaveBeenCalledTimes(2);
      });

      it("keeps asking after a network error", async () => {
        get.mockRejectedValueOnce(new Error("ECONNRESET")).mockResolvedValueOnce(userinfo);

        await expect(provider.verifyAccessToken("valid")).rejects.toThrow();
        await expect(provider.verifyAccessToken("valid")).resolves.toBeDefined();
      });

      it("keeps asking while CILogon itself is failing", async () => {
        get.mockResolvedValueOnce({ status: 503, data: {} }).mockResolvedValueOnce(userinfo);

        await expect(provider.verifyAccessToken("valid")).rejects.toThrow();
        await expect(provider.verifyAccessToken("valid")).resolves.toMatchObject({
          extra: { eppn: "u1@access-ci.org" },
        });
      });

      it("forgets the oldest rejection once it holds 5,000", async () => {
        get.mockResolvedValue({ status: 401, data: {} });

        for (let i = 0; i <= 5000; i++) {
          await expect(provider.verifyAccessToken(`fake-${i}`)).rejects.toThrow();
        }
        get.mockClear();

        await expect(provider.verifyAccessToken("fake-5000")).rejects.toThrow();
        await expect(provider.verifyAccessToken("fake-1")).rejects.toThrow();
        expect(get).not.toHaveBeenCalled();
        await expect(provider.verifyAccessToken("fake-0")).rejects.toThrow();
        expect(get).toHaveBeenCalledTimes(1);
      });

      it("keeps rejections for one token separate from another", async () => {
        get.mockImplementation(async (_url, options) =>
          (options?.headers as Record<string, string>).Authorization === "Bearer valid"
            ? userinfo
            : { status: 401, data: {} }
        );

        await expect(provider.verifyAccessToken("expired")).rejects.toThrow();
        await expect(provider.verifyAccessToken("valid")).resolves.toBeDefined();
      });
    });
  });

  describe("revokeToken", () => {
    it("should not throw", async () => {
      const client = { client_id: "test" } as OAuthClientInformationFull;
      await expect(
        provider.revokeToken!(client, { token: "some-token" } as OAuthTokenRevocationRequest)
      ).resolves.not.toThrow();
    });
  });

  it("exposes the client store passed in config via clientsStore", async () => {
    const store = new SqliteClientStore(":memory:");
    const wiredProvider = new CILogonOAuthProvider({
      clientId: "cid",
      clientSecret: "secret",
      externalBaseUrl: "https://mcp.access-ci.org/auth",
      clientStore: store,
    });
    await wiredProvider.clientsStore.registerClient({
      client_id: "wired-client",
      redirect_uris: ["https://claude.ai/api/mcp/auth_callback"],
    } as never);
    const got = await wiredProvider.clientsStore.getClient("wired-client");
    expect(got).toBeDefined();
    store.close();
  });
});
