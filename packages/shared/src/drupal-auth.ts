/* eslint-disable @typescript-eslint/no-explicit-any -- Generic HTTP client for untyped JSON:API responses */
import axios, { AxiosInstance } from "axios";
import { randomUUID } from "crypto";
import https from "https";
import { createLogger, Logger } from "./logger.js";
import { describeAxiosFailure, isCallerSafeStatus, logUpstreamFailure } from "./utils.js";

/**
 * Error thrown by the throwing request methods (get/post/patch/delete) on a
 * non-2xx Drupal response. Extends Error and keeps the SAME message text the
 * plain Error used to carry (so existing message-based catchers are unaffected),
 * while additionally exposing the HTTP `status` and the parsed Drupal `body` so
 * callers can branch structurally (404 → not_found, 403 → forbidden) instead of
 * string-matching the message. Fixes bug #30 (status + body were previously
 * flattened into the message string and lost).
 */
export class DrupalApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public body: unknown,
    /**
     * Optional machine-readable discriminator for failures that are NOT a plain
     * upstream status. Currently "reauth_failed": the session had expired and
     * the automatic re-login itself failed, meaning credentials or Drupal are
     * broken and a process restart will NOT help — materially different from an
     * ordinary expired session, which self-heals. "auth_redirect_after_relogin":
     * the re-login succeeded but the retry was still sent to sign-in, so the
     * caller must not blame the user's session.
     */
    public code?: string
  ) {
    super(message);
    this.name = "DrupalApiError";
  }
}

/**
 * Authentication provider for Drupal JSON:API using cookie-based session auth.
 *
 * Session-cookie auth IS the production design (team decision) — a service
 * account logs in once and reuses the session cookie + CSRF token, with the
 * end user carried per-request in X-Acting-User.
 *
 * Sessions expire, so the self-healing re-login below is load-bearing, not a
 * nicety: on an expired session the request methods invalidate, log in again,
 * and retry ONCE. Expiry arrives in two shapes and both must be handled — a
 * 401/403 (except a route's own {error, message} refusal), and (on this
 * CILogon-fronted Drupal) a 3xx redirect to the login page, which
 * maxRedirects:0 preserves as a raw 3xx rather than following it.
 *
 * @see ../../../access-qa-planning/06-mcp-authentication.md
 */
export class DrupalAuthProvider {
  private sessionCookie?: string;
  private csrfToken?: string;
  private logoutToken?: string;
  private userUuid?: string;
  private httpClient: AxiosInstance;
  private isAuthenticated = false;
  /**
   * The in-flight login, shared by every caller that arrives while it runs, so
   * concurrent expiry recoveries collapse onto ONE login instead of racing
   * several against Drupal. Cleared when it settles, success or failure.
   */
  private loginPromise?: Promise<void>;
  private logger: Logger = createLogger("drupal-auth");

  constructor(
    private baseUrl: string,
    private username: string,
    private password: string
  ) {
    // Skip TLS verification for local dev domains (DDEV self-signed certs).
    const isLocalDev = /\.(ddev\.site|localhost|local)$/.test(
      new URL(this.baseUrl).hostname
    );

    this.httpClient = axios.create({
      baseURL: this.baseUrl,
      timeout: 30000,
      validateStatus: () => true,
      // Do NOT follow redirects. A stale/invalid session makes Drupal 302 to
      // CILogon; if axios follows it, the CILogon login page HTML comes back as
      // a fake 200 and leaks into the tool result as content[0].text. Keeping
      // maxRedirects:0 preserves the 3xx status so callers surface a structured
      // auth error instead. Login (/user/login?_format=json) and the JSON API
      // endpoints respond directly (no redirect), so this affects only the
      // auth-failure bounce.
      maxRedirects: 0,
      ...(isLocalDev && {
        httpsAgent: new https.Agent({ rejectUnauthorized: false }),
      }),
    });
  }

  /**
   * Ensure we have a valid session, logging in if necessary.
   *
   * Single-flighted: if a login is already running, ride it instead of starting
   * a second one. Without this, every request that expired at the same moment
   * would fire its own login at Drupal.
   */
  async ensureAuthenticated(): Promise<void> {
    if (this.isAuthenticated) return;
    if (!this.loginPromise) {
      this.loginPromise = this.login().finally(() => {
        // Clear on BOTH outcomes: leaving a rejected promise cached would make
        // every later caller replay the same stale failure.
        this.loginPromise = undefined;
      });
    }
    await this.loginPromise;
  }

  /**
   * Login to Drupal and store session cookie + CSRF token.
   *
   * Clears any prior session state up front so a FAILED login can never leave
   * half of a stale session behind (a dead cookie paired with isAuthenticated
   * still true would let getAuthHeaders hand out credentials Drupal rejects).
   */
  async login(): Promise<void> {
    this.invalidate();

    const response = await this.httpClient.post(
      "/user/login?_format=json",
      {
        name: this.username,
        pass: this.password,
      },
      {
        headers: {
          "Content-Type": "application/json",
        },
      }
    );

    if (response.status !== 200) {
      throw new Error(`Drupal login failed: ${response.status} ${response.statusText}`);
    }

    // Extract session cookie from Set-Cookie header
    const setCookie = response.headers["set-cookie"];
    if (setCookie && setCookie.length > 0) {
      // Parse the session cookie (format: SESS...=value; path=/; ...)
      const cookieParts = setCookie[0].split(";")[0];
      this.sessionCookie = cookieParts;
    }

    // Store CSRF token and logout token from response
    this.csrfToken = response.data.csrf_token;
    this.logoutToken = response.data.logout_token;
    this.userUuid = response.data.current_user?.uuid;

    if (!this.sessionCookie || !this.csrfToken) {
      throw new Error("Login succeeded but missing session cookie or CSRF token");
    }

    this.isAuthenticated = true;
  }

  /**
   * Get headers required for authenticated requests.
   *
   * Defaults to JSON:API content type. Pass overrides for non-JSON:API
   * endpoints (e.g., { "Content-Type": "application/json" }).
   */
  getAuthHeaders(
    actingUser: string,
    overrides?: Record<string, string>
  ): Record<string, string> {
    if (!this.isAuthenticated || !this.sessionCookie || !this.csrfToken) {
      throw new Error("Not authenticated. Call ensureAuthenticated() first.");
    }

    return {
      Cookie: this.sessionCookie,
      "X-CSRF-Token": this.csrfToken,
      "Content-Type": "application/vnd.api+json",
      Accept: "application/vnd.api+json",
      "X-Request-ID": randomUUID(),
      "X-Acting-User": actingUser,
      ...overrides,
    };
  }

  /**
   * Get the authenticated user's UUID
   */
  getUserUuid(): string | undefined {
    return this.userUuid;
  }

  /**
   * Invalidate the current session
   */
  invalidate(): void {
    this.sessionCookie = undefined;
    this.csrfToken = undefined;
    this.logoutToken = undefined;
    this.userUuid = undefined;
    this.isAuthenticated = false;
  }

  /**
   * Does this response mean the Drupal session was rejected and we should try a
   * fresh login? Two shapes, both session expiry:
   *
   *  - 401 / 403 — Drupal refusing the session outright. A 403 whose body is a
   *    route's own {error, message} refusal is not this; see isControllerRefusal.
   *  - An AUTH 3xx — this Drupal sits behind CILogon and bounces an expired
   *    session to the login page. maxRedirects:0 (see the constructor) keeps
   *    that as a raw 3xx instead of following it and returning login HTML as a
   *    fake 200. See isAuthRedirect for which 3xx qualify.
   *
   * Missing the 3xx case was a production outage: the session expired, every
   * authenticated call returned "Drupal API error: 307 Temporary Redirect",
   * isAuthenticated was never reset, and only a process restart recovered it.
   */
  private isSessionExpiry(response: any): boolean {
    const status = response.status;
    if (status === 403 && this.isControllerRefusal(response)) return false;
    return status === 401 || status === 403 || this.isAuthRedirect(response);
  }

  /**
   * A 403 that Drupal's own routes return as {error, message}, such as "You may
   * not archive this event." The auth gate's 403 never has that shape: the
   * custom routes check `_user_is_logged_in` and `_custom_access` before the
   * controller runs, and core's 403 body is {message} only. So this is a
   * refusal the caller must see, not an expired session; re-sending it would
   * repeat a request the route already ran.
   */
  private isControllerRefusal(response: any): boolean {
    const data = response.data;
    return typeof data?.error === "string" && typeof data?.message === "string";
  }

  /**
   * Is this 3xx the auth gate bouncing us to login, as opposed to an ordinary
   * redirect? Only a Location pointing at CILogon or a /user/login path means
   * session expiry. A config-level redirect (say a 301 to a normalized URL) must
   * NOT burn a re-login and must stay visible as an upstream error, otherwise a
   * routing misconfiguration would masquerade as an auth problem forever.
   *
   * With no Location at all we cannot tell, so we fall back to treating it as
   * expiry — the recovery is bounded (one retry) and self-correcting, whereas
   * failing to recover is the outage this fix exists to prevent. 304 Not
   * Modified is the one 3xx exempted from that fallback: it is not a redirect at
   * all and legitimately carries no Location, so treating it as expiry would burn
   * a pointless re-login on every conditional GET.
   */
  private isAuthRedirect(response: any): boolean {
    const status = response.status;
    if (status < 300 || status >= 400) return false;
    if (status === 304) return false; // Not Modified — a cache hit, not a redirect
    const location = this.redirectLocation(response);
    if (!location) return true; // indeterminate → assume expiry (safe fallback)
    const target = location.toLowerCase();
    return target.includes("cilogon") || target.includes("/user/login");
  }

  /** Read the Location header regardless of header-name casing. */
  private redirectLocation(response: any): string | undefined {
    const headers = response.headers ?? {};
    const raw = headers.location ?? headers.Location;
    return typeof raw === "string" && raw.length > 0 ? raw : undefined;
  }

  /**
   * Invalidate the rejected session and log back in, for the retry paths.
   *
   * Concurrency: many in-flight requests typically expire at the same moment, so
   * the login is single-flighted (see ensureAuthenticated) and they all ride one
   * login rather than stampeding Drupal with N.
   *
   * A failure here is NOT ordinary expiry — the credentials or Drupal itself are
   * broken and no restart will help — so it surfaces as a DrupalApiError with
   * code "reauth_failed" with a fixed message, rather than the bare
   * login Error that would otherwise escape and read like an unrelated fault.
   */
  private async recoverSession(): Promise<void> {
    this.logger.warn("Drupal session expired; re-authenticating", {
      baseUrl: this.baseUrl,
    });
    this.invalidate(); // drops isAuthenticated so ensureAuthenticated logs in again
    try {
      await this.ensureAuthenticated();
    } catch (e) {
      // The login error can be raw transport text naming an internal host, so
      // only its code and status are logged.
      logUpstreamFailure(this.logger, describeAxiosFailure(e, "drupal"));
      throw new DrupalApiError(
        "Drupal session expired and re-authentication failed; the service needs an operator",
        401,
        undefined,
        "reauth_failed"
      );
    }
  }

  /**
   * Make an authenticated GET request to JSON:API
   */
  async get(actingUser: string, path: string): Promise<any> {
    await this.ensureAuthenticated();

    const response = await this.httpClient.get(path, {
      headers: this.getAuthHeaders(actingUser),
    });

    if (this.isSessionExpiry(response)) {
      // Session expired — re-authenticate and retry. The retry response goes
      // straight to handleResponse and is never re-tested for expiry, so a
      // still-expired session surfaces as a structured DrupalApiError after
      // exactly one retry rather than looping.
      await this.recoverSession();

      const retryResponse = await this.httpClient.get(path, {
        headers: this.getAuthHeaders(actingUser),
      });

      return this.handleRetryResponse(retryResponse);
    }

    return this.handleResponse(response);
  }

  /**
   * Make an authenticated POST request.
   *
   * Defaults to JSON:API content type. Pass headerOverrides for non-JSON:API
   * endpoints (e.g., { "Content-Type": "application/json", Accept: "application/json" }).
   */
  async post(
    actingUser: string,
    path: string,
    data: any,
    headerOverrides?: Record<string, string>
  ): Promise<any> {
    await this.ensureAuthenticated();

    const response = await this.httpClient.post(path, data, {
      headers: this.getAuthHeaders(actingUser, headerOverrides),
    });

    // Retrying a WRITE is safe here, and must stay that way: a session-expiry
    // 401/auth-3xx, or a 403 without a {error, message} body, is produced at
    // Drupal's authentication gate BEFORE the route runs, so the original
    // request was never processed and the retry cannot double-write. A route's
    // own 403 refusal does carry that body and is excluded by isSessionExpiry.
    // Do not "fix" this retry away as a duplicate-POST hazard — it isn't one.
    if (this.isSessionExpiry(response)) {
      await this.recoverSession();

      const retryResponse = await this.httpClient.post(path, data, {
        headers: this.getAuthHeaders(actingUser, headerOverrides),
      });

      return this.handleRetryResponse(retryResponse);
    }

    return this.handleResponse(response);
  }

  /**
   * Make an authenticated request and return the raw status + body WITHOUT
   * throwing on non-2xx.
   *
   * Unlike get/post/delete (which call handleResponse and throw on non-2xx,
   * discarding the body), this returns { status, data } straight from the
   * resolved axios response. Callers branch on status themselves — e.g.
   * treating a Drupal 409 as a first-class refusal and reading its flat
   * { error, message } body. Uses application/json (not JSON:API) content type.
   *
   * Deliberately omits the 401/403 re-auth retry that get/post/delete have, so
   * a 403 surfaces to the caller for its own branching — the events server, for
   * instance, reads a 403 as its acting-user gate failing, a real outcome the
   * caller must see rather than have retried away.
   *
   * An AUTH 3xx is NOT in that category and DOES get the session-recovery retry.
   * A login bounce is never a legitimate caller-branchable outcome here: with
   * maxRedirects:0 the JSON:API routes answer directly, so a redirect to CILogon
   * or /user/login only ever means the session expired. Recovery is invalidate →
   * re-login → retry ONCE; if the retry still redirects it is returned raw for
   * the caller to surface (bounded, no loop). A non-auth 3xx (e.g. a config-level
   * 301) is returned raw untouched — see isAuthRedirect.
   *
   * Retrying a write is safe: the auth gate rejects BEFORE the route executes,
   * so the first attempt never reached the handler and cannot double-write.
   */
  async requestRaw(
    actingUser: string,
    method: "GET" | "POST" | "PATCH" | "DELETE",
    path: string,
    data?: unknown
  ): Promise<{ status: number; data: any }> {
    await this.ensureAuthenticated();

    let response = await this.sendRaw(actingUser, method, path, data);

    if (this.isAuthRedirect(response)) {
      await this.recoverSession();
      response = await this.sendRaw(actingUser, method, path, data);
    }

    return { status: response.status, data: response.data };
  }

  /**
   * Issue one raw verb request with the JSON (non-JSON:API) content type.
   * validateStatus: () => true (set in the constructor) means every status
   * resolves, so the response is always available without throwing.
   */
  private async sendRaw(
    actingUser: string,
    method: "GET" | "POST" | "PATCH" | "DELETE",
    path: string,
    data?: unknown
  ): Promise<any> {
    const headers = this.getAuthHeaders(actingUser, {
      "Content-Type": "application/json",
    });

    switch (method) {
      case "GET":
        return await this.httpClient.get(path, { headers });
      case "POST":
        return await this.httpClient.post(path, data, { headers });
      case "PATCH":
        return await this.httpClient.patch(path, data, { headers });
      case "DELETE":
        return await this.httpClient.delete(path, { headers });
    }
  }

  /**
   * Make an authenticated PATCH request to JSON:API
   */
  async patch(actingUser: string, path: string, data: any): Promise<any> {
    await this.ensureAuthenticated();

    const response = await this.httpClient.patch(path, data, {
      headers: this.getAuthHeaders(actingUser),
    });

    // Safe to retry a write — the auth gate rejected this BEFORE the route ran,
    // so nothing was written on the first attempt (see post()).
    if (this.isSessionExpiry(response)) {
      await this.recoverSession();

      const retryResponse = await this.httpClient.patch(path, data, {
        headers: this.getAuthHeaders(actingUser),
      });

      return this.handleRetryResponse(retryResponse);
    }

    return this.handleResponse(response);
  }

  /**
   * Make an authenticated DELETE request to JSON:API
   */
  async delete(actingUser: string, path: string): Promise<any> {
    await this.ensureAuthenticated();

    const response = await this.httpClient.delete(path, {
      headers: this.getAuthHeaders(actingUser),
    });

    // Safe to retry a write — the auth gate rejected this BEFORE the route ran,
    // so nothing was deleted on the first attempt (see post()).
    if (this.isSessionExpiry(response)) {
      await this.recoverSession();

      const retryResponse = await this.httpClient.delete(path, {
        headers: this.getAuthHeaders(actingUser),
      });

      return this.handleRetryResponse(retryResponse);
    }

    return this.handleResponse(response);
  }

  /**
   * The retry after a successful re-login. If Drupal still sends it to sign-in,
   * the fresh service session was not the problem: in D8-3013 the route ran and
   * an uncaught error came back as a login redirect. Coding it keeps callers
   * from telling the user their session expired. The redirect target is logged
   * without its query, which can carry tokens.
   */
  private handleRetryResponse(response: any): any {
    if (this.isAuthRedirect(response)) {
      const location = this.redirectLocation(response);
      this.logger.warn("Drupal redirected to sign-in right after a fresh login", {
        status: response.status,
        location: location ? location.split(/[?#]/)[0] : undefined,
      });
      try {
        return this.handleResponse(response);
      } catch (error) {
        // Keep handleResponse's caller-safe message; only add the code.
        if (error instanceof DrupalApiError) error.code = "auth_redirect_after_relogin";
        throw error;
      }
    }
    return this.handleResponse(response);
  }

  /**
   * Handle JSON:API response, throwing on errors
   */
  private handleResponse(response: any): any {
    if (response.status >= 200 && response.status < 300) {
      return response.data;
    }

    // A non-4xx failure is reported to callers without Drupal's text, so the
    // operator gets a metadata-only line here, never the body.
    if (!isCallerSafeStatus(response.status)) {
      logUpstreamFailure(this.logger, describeAxiosFailure(response, "drupal"));
    }

    // JSON:API error format. Preserve the status + full body on the thrown
    // DrupalApiError (bug #30) while keeping the message text identical to the
    // old plain Error, so callers can branch on e.status/e.body AND existing
    // message-based catchers keep working.
    if (response.data?.errors) {
      const errors = response.data.errors
        .map((e: any) => e.detail || e.title || "Unknown error")
        .join("; ");
      // Core JSON:API puts an uncaught exception's getMessage() in `detail` on
      // a 500, so only a 4xx detail goes into the message. The body stays on
      // the error object for callers in code; it is never logged.
      const message = isCallerSafeStatus(response.status)
        ? `Drupal API error (${response.status}): ${errors}`
        : `Drupal API error (${response.status})`;
      throw new DrupalApiError(
        message,
        response.status,
        response.data
      );
    }

    // A redirect that reaches here is NOT the auth bounce (that path re-logs-in
    // and retries). It is an unexpected redirect — a routing/config issue — so
    // name the target, otherwise the error says only "301 Moved Permanently"
    // and hides the one detail needed to diagnose it.
    const location = this.redirectLocation(response);
    if (location && response.status >= 300 && response.status < 400) {
      throw new DrupalApiError(
        `Drupal API error: ${response.status} ${response.statusText} (unexpected redirect to ${location})`,
        response.status,
        response.data
      );
    }

    throw new DrupalApiError(
      `Drupal API error: ${response.status} ${response.statusText}`,
      response.status,
      response.data
    );
  }
}
