import { describe, test, expect, vi } from "vitest";
import {
  sanitizeGroupId,
  formatApiUrl,
  handleApiError,
  callerSafeUpstreamError,
  isCallerSafeStatus,
  logUpstreamFailure,
  describeAxiosFailure,
} from "../utils.js";
import { DrupalApiError } from "../drupal-auth.js";

describe("Utils", () => {
  describe("sanitizeGroupId", () => {
    test("should remove invalid characters", () => {
      expect(sanitizeGroupId("test@#$%")).toBe("test");
    });

    test("should keep valid characters", () => {
      expect(sanitizeGroupId("test.group-123")).toBe("test.group-123");
    });

    test("should throw error for empty string", () => {
      expect(() => sanitizeGroupId("")).toThrow(
        "groupId parameter is required and cannot be null or undefined"
      );
    });
  });

  describe("formatApiUrl", () => {
    test("should format API URL correctly", () => {
      expect(formatApiUrl("1.0", "users")).toBe("/1.0/users");
    });

    test("should handle empty endpoint", () => {
      expect(formatApiUrl("2.0", "")).toBe("/2.0/");
    });
  });

  describe("handleApiError", () => {
    test("returns Drupal's own message for a client error with a flat body", () => {
      const error = new DrupalApiError("Drupal API error: 409 Conflict", 409, {
        error: "already_registered",
        message: "You are already registered.",
      });
      expect(handleApiError(error)).toBe("You are already registered.");
    });

    test("keeps the generic message when a server error body has a message", () => {
      const error = new DrupalApiError("Drupal API error: 500 Server Error", 500, {
        message: "SQLSTATE[42S02]: Base table not found",
      });
      expect(handleApiError(error)).toBe("Drupal API error: 500 Server Error");
    });

    test("keeps the generic message when the body has no usable message", () => {
      expect(handleApiError(new DrupalApiError("Drupal API error: 404", 404, "<html>"))).toBe(
        "Drupal API error: 404"
      );
      expect(
        handleApiError(new DrupalApiError("Drupal API error: 400", 400, { message: "" }))
      ).toBe("Drupal API error: 400");
    });

    test("should extract message from a 4xx axios response body", () => {
      const error = {
        response: {
          status: 422,
          statusText: "Unprocessable Entity",
          data: { message: "Custom error message" },
        },
      };
      expect(handleApiError(error)).toBe("Custom error message");
    });

    test("does not show an axios 5xx response body message", () => {
      const error = {
        response: {
          status: 500,
          statusText: "Internal Server Error",
          data: { message: "SQLSTATE[42S02]: Base table not found" },
        },
      };
      expect(handleApiError(error)).toBe("API error: 500 Internal Server Error");
    });

    test("does not show an axios response message when there is no status", () => {
      const error = { response: { data: { message: "internal detail" } } };
      expect(handleApiError(error)).toBe("Unknown API error");
    });

    test("returns the joined JSON:API detail for a 4xx DrupalApiError", () => {
      const error = new DrupalApiError("Drupal API error (404): x", 404, {
        errors: [{ detail: "The resource was not found." }],
      });
      expect(handleApiError(error)).toBe("The resource was not found.");
    });

    test("should handle status error", () => {
      const error = {
        response: {
          status: 404,
          statusText: "Not Found",
        },
      };
      expect(handleApiError(error)).toBe("API error: 404 Not Found");
    });

    test("should handle Error instance", () => {
      const error = new Error("Network error");
      expect(handleApiError(error)).toBe("Network error");
    });

    test("should handle unknown error", () => {
      const error = "some string error";
      expect(handleApiError(error)).toBe("Unknown API error");
    });
  });

  describe("isCallerSafeStatus", () => {
    test("is true for 400-499 only", () => {
      expect(isCallerSafeStatus(400)).toBe(true);
      expect(isCallerSafeStatus(499)).toBe(true);
      expect(isCallerSafeStatus(399)).toBe(false);
      expect(isCallerSafeStatus(302)).toBe(false);
      expect(isCallerSafeStatus(500)).toBe(false);
      expect(isCallerSafeStatus(undefined)).toBe(false);
    });
  });

  describe("handleApiError transport errors", () => {
    test("does not show the text of an axios error that has no response", () => {
      const error = Object.assign(new Error("connect ECONNREFUSED 10.0.3.4:5432"), {
        isAxiosError: true,
      });
      expect(handleApiError(error)).toBe("Could not reach the upstream service");
    });

    test("does not show a getaddrinfo failure's hostname", () => {
      const error = Object.assign(new Error("getaddrinfo ENOTFOUND db.internal"), {
        isAxiosError: true,
        code: "ENOTFOUND",
      });
      expect(handleApiError(error)).not.toContain("db.internal");
    });

    test("still returns the message of this codebase's own Error", () => {
      expect(handleApiError(new Error("limit must be a number"))).toBe("limit must be a number");
    });
  });

  describe("handleApiError with a DrupalApiError carrying a flat body", () => {
    test("hides a 5xx flat {message}", () => {
      const error = new DrupalApiError("Drupal API error: 500 Internal Server Error", 500, {
        message: "SQLSTATE[42S02] Base table not found",
      });
      expect(handleApiError(error)).toBe("Drupal API error: 500 Internal Server Error");
    });
  });

  describe("callerSafeUpstreamError", () => {
    test("uses a flat {error} as the message when there is no message, without a code", () => {
      expect(callerSafeUpstreamError(422, { error: "query is too long" })).toEqual({
        message: "query is too long",
        code: undefined,
      });
    });

    test("prefers message over error and keeps error as the code", () => {
      expect(callerSafeUpstreamError(400, { error: "bad", message: "Fix it." })).toEqual({
        message: "Fix it.",
        code: "bad",
      });
    });

    test("ignores an empty-string error", () => {
      expect(callerSafeUpstreamError(400, { error: "" })).toBeUndefined();
    });

    test("returns message and code from a flat 4xx body", () => {
      expect(
        callerSafeUpstreamError(409, { error: "event_full", message: "This event is full." })
      ).toEqual({ message: "This event is full.", code: "event_full" });
    });

    test("returns the message without a code when the body has no error code", () => {
      expect(callerSafeUpstreamError(400, { message: "Bad date." })).toEqual({
        message: "Bad date.",
        code: undefined,
      });
    });

    test("joins JSON:API error details for a 4xx", () => {
      expect(
        callerSafeUpstreamError(422, { errors: [{ detail: "A is bad." }, { detail: "B is bad." }] })
      ).toEqual({ message: "A is bad.; B is bad." });
    });

    test("returns undefined for a 5xx even when the body has a message", () => {
      expect(callerSafeUpstreamError(500, { error: "x", message: "SQLSTATE[42S02]" })).toBeUndefined();
      expect(callerSafeUpstreamError(503, { errors: [{ detail: "internal" }] })).toBeUndefined();
    });

    test("returns undefined for 2xx and 3xx statuses", () => {
      expect(callerSafeUpstreamError(200, { message: "ok" })).toBeUndefined();
      expect(callerSafeUpstreamError(302, { message: "moved" })).toBeUndefined();
    });

    test("returns undefined for an empty, non-string or non-object body", () => {
      expect(callerSafeUpstreamError(400, { message: "" })).toBeUndefined();
      expect(callerSafeUpstreamError(400, { message: 42 })).toBeUndefined();
      expect(callerSafeUpstreamError(404, "<html>")).toBeUndefined();
      expect(callerSafeUpstreamError(404, null)).toBeUndefined();
      expect(callerSafeUpstreamError(400, { errors: [] })).toBeUndefined();
    });
  });

  describe("upstream failure logging", () => {
    const spyLogger = () => {
      const error = vi.fn();
      return { logger: { error, warn: vi.fn(), info: vi.fn(), debug: vi.fn() }, error };
    };

    test("logUpstreamFailure keeps only whitelisted fields and strips the query", () => {
      const { logger, error } = spyLogger();
      logUpstreamFailure(logger, {
        upstream: "uky",
        method: "post",
        path: "https://uky.example/api/retrieve?q=secret#frag",
        status: 502,
        // @ts-expect-error extra fields must not be logged
        body: "SQLSTATE secret",
      });
      const [, context] = error.mock.calls[0];
      expect(context).toEqual({ upstream: "uky", method: "POST", path: "/api/retrieve", status: 502 });
    });

    test("handleApiError logs a 5xx response without its body or status text", () => {
      const { logger, error } = spyLogger();
      const text = handleApiError(
        {
          response: { status: 500, statusText: "Boom", data: "SQLSTATE[42S02] alice@example.org" },
          config: { method: "get", url: "/v1/things?mail=alice@example.org", baseURL: "http://internal:8080" },
        },
        { upstream: "xdmod", logger }
      );
      expect(text).toBe("API error: 500 Boom");
      const line = JSON.stringify(error.mock.calls);
      expect(line).toContain('"status":500');
      expect(line).toContain('"/v1/things"');
      expect(line).not.toContain("SQLSTATE");
      expect(line).not.toContain("alice@example.org");
      expect(line).not.toContain("internal:8080");
    });

    test("handleApiError logs a transport error as code and host without its message", () => {
      const { logger, error } = spyLogger();
      const err = Object.assign(new Error("connect ECONNREFUSED 10.9.8.7:5432 password=hunter2"), {
        isAxiosError: true,
        code: "ECONNREFUSED",
        config: { method: "post", url: "http://drupal.internal:8080/api/x?token=abc" },
      });
      expect(handleApiError(err, { upstream: "drupal", logger })).toBe(
        "Could not reach the upstream service"
      );
      const [, context] = error.mock.calls[0];
      expect(context).toEqual({
        upstream: "drupal",
        method: "POST",
        path: "/api/x",
        code: "ECONNREFUSED",
        host: "drupal.internal:8080",
      });
      const line = JSON.stringify(error.mock.calls);
      expect(line).not.toContain("hunter2");
      expect(line).not.toContain("token=abc");
    });

    test("handleApiError does not log a 4xx, which the caller sees in full", () => {
      const { logger, error } = spyLogger();
      handleApiError({ response: { status: 404, data: { message: "Not found." } } }, { logger });
      expect(error).not.toHaveBeenCalled();
    });

    test("describeAxiosFailure omits code and host when there was a response", () => {
      expect(
        describeAxiosFailure(
          { code: "ERR_BAD_RESPONSE", response: { status: 500 }, config: { url: "/a", method: "get" } },
          "drupal"
        )
      ).toEqual({ upstream: "drupal", method: "get", path: "/a", status: 500 });
    });
  });
});
