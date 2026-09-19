import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { planSettingsUpdate, type ModelSettings } from "./settings";

const current: ModelSettings = { text: "sonnet", textEffort: "low", image: "gpt_image_2_5", imageQuality: "medium" };

describe("planSettingsUpdate", () => {
  test("keeps current values for anything not supplied", () => {
    assert.deepEqual(planSettingsUpdate({}, current), current);
    assert.deepEqual(planSettingsUpdate({ claudeTextEffort: "high" }, current), { ...current, textEffort: "high" });
  });

  test("keeps the current tier when the new model accepts it", () => {
    assert.deepEqual(planSettingsUpdate({ higgsfieldImageModel: "gpt_image_2" }, current), { ...current, image: "gpt_image_2" });
  });

  test("switches to the new model's default tier when the current tier does not fit", () => {
    assert.deepEqual(
      planSettingsUpdate({ higgsfieldImageModel: "seedream_v5_pro" }, current),
      { ...current, image: "seedream_v5_pro", imageQuality: "2k" },
    );
  });

  test("accepts an explicit valid pair and rejects an invalid one", () => {
    assert.equal(planSettingsUpdate({ higgsfieldImageModel: "seedream_v5_pro", higgsfieldImageQuality: "1k" }, current).imageQuality, "1k");
    assert.throws(() => planSettingsUpdate({ higgsfieldImageQuality: "2k" }, current), /quality supported by this model/);
  });

  test("rejects values outside the allowlists", () => {
    assert.throws(() => planSettingsUpdate({ claudeTextModel: "haiku" }, current), /supported Claude model/);
    assert.throws(() => planSettingsUpdate({ claudeTextEffort: "max" }, current), /supported effort level/);
    assert.throws(() => planSettingsUpdate({ higgsfieldImageModel: "nano-banana" }, current), /supported Higgsfield image model/);
  });
});
