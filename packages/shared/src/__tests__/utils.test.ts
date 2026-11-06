import { describe, test, expect } from "vitest";
import { sanitizeGroupId, formatApiUrl, handleApiError } from "../utils.js";
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

    test("should extract message from response data", () => {
      const error = {
        response: {
          data: { message: "Custom error message" },
        },
      };
      expect(handleApiError(error)).toBe("Custom error message");
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
});
