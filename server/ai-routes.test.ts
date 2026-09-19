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

const titlesRequest = { topic: "Camera comparison", format: "Tutorial/How-to", audience: "General Audience" };

describe("text routes over the claude adapter", () => {
  test("regenerate-titles returns titles from a JSON reply", async () => {
    process.env.FAKE_CLAUDE_MODE = "results";
    process.env.FAKE_CLAUDE_RESULTS = JSON.stringify([JSON.stringify({ titles: ["One", "Two", "Three", "Four", "Five"] })]);
    const response = await harness.post("/api/script/regenerate-titles", titlesRequest);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { titles: ["One", "Two", "Three", "Four", "Five"] });
  });

  test("thumbnail suggestions accept a fenced reply and stay strict about everything else", async () => {
    process.env.FAKE_CLAUDE_MODE = "results";
    process.env.FAKE_CLAUDE_RESULTS = JSON.stringify(['```json\n["A","B","C","D","E"]\n```']);
    const response = await harness.post("/api/thumbnail/suggestions", { topic: "Camera comparison" });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { suggestions: ["A", "B", "C", "D", "E"] });
  });

  test("a signed-out Claude reaches the client with its own code and guidance, even on the legacy routes", async () => {
    process.env.FAKE_CLAUDE_MODE = "auth";
    const response = await harness.post("/api/script/regenerate-titles", titlesRequest);
    assert.equal(response.status, 401);
    const body = await response.json();
    assert.equal(body.code, "CLAUDE_NOT_SIGNED_IN");
    assert.equal(body.category, "invalid_key");
    assert.equal(body.retryable, false);
    assert.match(body.suggestion, /\/login/);
    assert.doesNotMatch(JSON.stringify(body), /Gemini|API key/);
  });

  test("a usage limit maps to 429 on a provider-payload route", async () => {
    process.env.FAKE_CLAUDE_MODE = "limit";
    const response = await harness.post("/api/thumbnail/suggestions", { topic: "Camera comparison" });
    assert.equal(response.status, 429);
    assert.equal((await response.json()).code, "CLAUDE_USAGE_LIMIT");
  });

  test("error payloads never echo the prompt", async () => {
    process.env.FAKE_CLAUDE_MODE = "failed";
    const response = await harness.post("/api/thumbnail/suggestions", { topic: "a very distinctive topic string" });
    assert.equal(response.status, 502);
    assert.doesNotMatch(await response.text(), /distinctive topic/);
  });

  test("narration extraction returns plain text and needs no JSON fence handling", async () => {
    process.env.FAKE_CLAUDE_MODE = "results";
    process.env.FAKE_CLAUDE_RESULTS = JSON.stringify(["Hello everyone. Today we compare two cameras."]);
    const response = await harness.post("/api/script/extract-narration", { scriptContent: "[00:00] Hello everyone. Today we compare two cameras." });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { narration: "Hello everyone. Today we compare two cameras." });
  });
});
