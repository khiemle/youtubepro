import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { apiErrorCode, apiErrorText, readApiErrorBody } from "./api-error-message";

const body = JSON.stringify({
  error: "Claude Code is not signed in.",
  code: "CLAUDE_NOT_SIGNED_IN",
  category: "invalid_key",
  retryable: false,
  suggestion: "Run `claude` in a terminal and sign in with /login, then try again.",
});

describe("readApiErrorBody", () => {
  test("parses the JSON body out of an apiRequest error message", () => {
    assert.deepEqual(readApiErrorBody(`401: ${body}`), {
      error: "Claude Code is not signed in.",
      suggestion: "Run `claude` in a terminal and sign in with /login, then try again.",
      code: "CLAUDE_NOT_SIGNED_IN",
      category: "invalid_key",
      retryable: false,
    });
  });

  test("returns null for anything that is not a status followed by a JSON object", () => {
    assert.equal(readApiErrorBody("Network request failed"), null);
    assert.equal(readApiErrorBody("500: Internal Server Error"), null);
    assert.equal(readApiErrorBody("500: {not json}"), null);
    assert.equal(readApiErrorBody("500: [1,2]"), null);
  });

  test("ignores fields of the wrong type", () => {
    assert.deepEqual(readApiErrorBody('400: {"error":5,"suggestion":null,"retryable":"yes"}'), {
      error: undefined, suggestion: undefined, code: undefined, category: undefined, retryable: undefined,
    });
  });
});

describe("apiErrorText", () => {
  test("prefers the suggestion, then the error, then the raw message, then the fallback", () => {
    assert.match(apiErrorText(new Error(`401: ${body}`), "fallback"), /sign in with \/login/);
    assert.equal(apiErrorText(new Error('500: {"error":"Something broke"}'), "fallback"), "Something broke");
    assert.equal(apiErrorText(new Error("Network request failed"), "fallback"), "Network request failed");
    assert.equal(apiErrorText(undefined, "fallback"), "fallback");
  });
});

describe("apiErrorCode", () => {
  test("returns the server's error code from an apiRequest error message", () => {
    assert.equal(apiErrorCode(new Error('503: {"error":"x","code":"HIGGSFIELD_NOT_CONNECTED"}')), "HIGGSFIELD_NOT_CONNECTED");
    assert.equal(apiErrorCode(new Error(`401: ${body}`)), "CLAUDE_NOT_SIGNED_IN");
  });

  test("returns undefined when there is no error code to read", () => {
    assert.equal(apiErrorCode(new Error("Network request failed")), undefined);
    assert.equal(apiErrorCode(new Error('500: {"error":"x"}')), undefined);
    assert.equal(apiErrorCode(new Error('500: {"error":"x","code":5}')), undefined);
    assert.equal(apiErrorCode('503: {"error":"x","code":"HIGGSFIELD_NOT_CONNECTED"}'), undefined);
    assert.equal(apiErrorCode({ code: "HIGGSFIELD_NOT_CONNECTED" }), undefined);
    assert.equal(apiErrorCode(undefined), undefined);
  });
});
