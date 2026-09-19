import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  HIGGSFIELD_IMAGE_MODELS,
  isHiggsfieldImageTier,
  resolveClaudeTextEffort,
  resolveClaudeTextModel,
  resolveHiggsfieldImageModel,
  resolveHiggsfieldImageTier,
} from "./provider-models";

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

describe("Higgsfield image settings", () => {
  test("default to gpt_image_2_5 at medium quality", () => {
    const model = resolveHiggsfieldImageModel({});
    assert.equal(model.id, "gpt_image_2_5");
    assert.equal(resolveHiggsfieldImageTier({}), "medium");
  });

  test("use each model's own tier parameter and default", () => {
    const env = { HIGGSFIELD_IMAGE_MODEL: "seedream_v5_pro" };
    assert.equal(resolveHiggsfieldImageModel(env).tierParam, "resolution");
    assert.equal(resolveHiggsfieldImageTier(env), "2k");
    assert.equal(resolveHiggsfieldImageTier({ ...env, HIGGSFIELD_IMAGE_QUALITY: "1k" }), "1k");
  });

  test("fall back when a tier does not belong to the selected model", () => {
    assert.equal(resolveHiggsfieldImageTier({ HIGGSFIELD_IMAGE_QUALITY: "2k" }), "medium");
    assert.equal(resolveHiggsfieldImageTier({ HIGGSFIELD_IMAGE_MODEL: "seedream_v5_pro", HIGGSFIELD_IMAGE_QUALITY: "high" }), "2k");
    assert.equal(resolveHiggsfieldImageModel({ HIGGSFIELD_IMAGE_MODEL: "nano-banana" }).id, "gpt_image_2_5");
  });

  test("every table entry has a default tier that it accepts", () => {
    for (const model of HIGGSFIELD_IMAGE_MODELS) {
      assert.equal(isHiggsfieldImageTier(model.id, model.defaultTier), true, model.id);
    }
  });
});
