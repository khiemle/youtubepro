import assert from "node:assert/strict";
import { describe, mock, test } from "node:test";
import { ProviderError, logProviderFailure, normalizeProviderError, providerErrorPayload } from "./provider-errors";

describe("providerErrorPayload", () => {
  test("uses the per-category copy when the error carries none", () => {
    const error = normalizeProviderError(new Error("Request timed out"), "ai");
    assert.deepEqual(providerErrorPayload(error, "Ideas generation"), {
      error: "Ideas generation timed out",
      suggestion: "Check the connection and retry. Repeated timeouts may indicate a provider incident.",
      code: "AI_TIMEOUT",
      category: "timeout",
      retryable: true,
    });
  });

  test("prefers the error's own public message and suggestion", () => {
    const error = new ProviderError({
      message: "internal detail that must not reach the client",
      category: "invalid_key",
      code: "CLAUDE_NOT_SIGNED_IN",
      status: 401,
      retryable: false,
      publicMessage: "Claude Code is not signed in.",
      suggestion: "Run `claude` and sign in with /login.",
    });
    assert.deepEqual(providerErrorPayload(error, "Research insights"), {
      error: "Claude Code is not signed in.",
      suggestion: "Run `claude` and sign in with /login.",
      code: "CLAUDE_NOT_SIGNED_IN",
      category: "invalid_key",
      retryable: false,
    });
  });

  test("names claude and higgsfield contexts in generated codes", () => {
    assert.equal(normalizeProviderError(new Error("fetch failed"), "claude").code, "CLAUDE_NETWORK");
    assert.equal(normalizeProviderError(new Error("fetch failed"), "higgsfield").code, "HIGGSFIELD_NETWORK");
  });
});

describe("logProviderFailure", () => {
  test("logs the code only, never the message or cause", () => {
    const spy = mock.method(console, "error", () => {});
    try {
      logProviderFailure("Ideas generation", new ProviderError({
        message: "prompt text and secrets",
        category: "unknown",
        code: "CLAUDE_FAILED",
        status: 502,
        retryable: true,
        cause: new Error("more secrets"),
      }));
      logProviderFailure("Ideas generation", new Error("also secret"));
      logProviderFailure("Ideas generation", "a string");
      assert.deepEqual(spy.mock.calls.map((call) => call.arguments), [
        ["Ideas generation failed:", "CLAUDE_FAILED"],
        ["Ideas generation failed:", "Error"],
        ["Ideas generation failed:", "UnknownError"],
      ]);
    } finally {
      spy.mock.restore();
    }
  });
});
