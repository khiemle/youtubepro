import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "node:test";
import { startRouteHarness, type RouteHarness } from "./test-fixtures/route-harness";

let harness: RouteHarness;

beforeEach(async () => {
  harness = await startRouteHarness();
});

afterEach(async () => {
  await harness.stop();
});

describe("settings routes", () => {
  test("status reports the Claude CLI without any API key and keeps the image option shape", async () => {
    const response = await fetch(`${harness.base}/api/settings/status`);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.deepEqual(body.claude, { installed: true, signedIn: true, authMethod: "claude.ai", version: "2.1.278" });
    assert.deepEqual(body.higgsfield, { connected: null });
    assert.equal(body.models.text, "sonnet");
    assert.equal(body.models.textEffort, "low");
    assert.equal(body.models.image, "gpt_image_2_5");
    assert.equal(body.models.imageQuality, "medium");
    assert.ok(body.models.imageOptions.every((option: { id: string; label: string; description: string }) => option.id && option.label && option.description));
    assert.equal("gemini" in body, false);
  });

  test("settings routes refuse forwarded requests", async () => {
    const response = await fetch(`${harness.base}/api/settings/status`, { headers: { "x-forwarded-for": "203.0.113.9" } });
    assert.equal(response.status, 403);
    assert.equal((await harness.post("/api/settings/test-higgsfield", {}, { "x-forwarded-for": "203.0.113.9" })).status, 403);
  });

  test("test-higgsfield returns the balance and marks Higgsfield connected", async () => {
    process.env.FAKE_CLAUDE_MODE = "results";
    process.env.FAKE_CLAUDE_RESULTS = JSON.stringify([JSON.stringify({ status: "ok", credits: 12.5 })]);
    const response = await harness.post("/api/settings/test-higgsfield", {});
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { connected: true, credits: 12.5 });
    const status = await (await fetch(`${harness.base}/api/settings/status`)).json();
    assert.deepEqual(status.higgsfield, { connected: true });
  });

  test("test-higgsfield reports a disconnected server with setup guidance", async () => {
    process.env.FAKE_CLAUDE_MODE = "results";
    process.env.FAKE_CLAUDE_RESULTS = JSON.stringify([JSON.stringify({ status: "error", reason: "UNAVAILABLE" })]);
    const response = await harness.post("/api/settings/test-higgsfield", {});
    assert.equal(response.status, 503);
    const body = await response.json();
    assert.equal(body.code, "HIGGSFIELD_NOT_CONNECTED");
    assert.match(body.suggestion, /claude mcp add --transport http higgsfield/);
  });
});
