import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { resolveClaudeTextEffort, resolveClaudeTextModel } from "./provider-models";

describe("Claude text settings", () => {
  test("default to sonnet at low effort and ignore unknown values", () => {
    assert.equal(resolveClaudeTextModel({}), "sonnet");
    assert.equal(resolveClaudeTextEffort({}), "low");
    assert.equal(resolveClaudeTextModel({ CLAUDE_TEXT_MODEL: "gemini-3.7-flash" }), "sonnet");
    assert.equal(resolveClaudeTextEffort({ CLAUDE_TEXT_EFFORT: "xhigh" }), "low");
  });

  test("accept the allowlisted values", () => {
    assert.equal(resolveClaudeTextModel({ CLAUDE_TEXT_MODEL: " opus " }), "opus");
    assert.equal(resolveClaudeTextEffort({ CLAUDE_TEXT_EFFORT: "high" }), "high");
  });
});
