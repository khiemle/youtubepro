import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, mock, test } from "node:test";
import { startRouteHarness, type RouteHarness } from "./test-fixtures/route-harness";

let harness: RouteHarness;

beforeEach(async () => {
  harness = await startRouteHarness();
});

afterEach(async () => {
  await harness.stop();
});

describe("route hygiene", () => {
  test("a refused forwarded test-higgsfield request does not consume the shared rate-limit budget", async () => {
    for (let attempt = 0; attempt < 12; attempt += 1) {
      const refused = await harness.post("/api/settings/test-higgsfield", {}, { "x-forwarded-for": "203.0.113.9" });
      assert.equal(refused.status, 403, `request ${attempt + 1} must be refused before the rate limiter`);
      await refused.arrayBuffer();
    }

    process.env.FAKE_CLAUDE_MODE = "results";
    process.env.FAKE_CLAUDE_RESULTS = JSON.stringify([JSON.stringify(["A", "B", "C", "D", "E"])]);
    const allowed = await harness.post("/api/thumbnail/suggestions", { topic: "Camera comparison" });
    assert.equal(allowed.status, 200, "the local AI budget must still be intact");
    assert.deepEqual(await allowed.json(), { suggestions: ["A", "B", "C", "D", "E"] });
  });

  test("a failing AI route logs a normalized code and never the request topic", async () => {
    process.env.FAKE_CLAUDE_MODE = "failed";
    const logged: unknown[][] = [];
    const restore = mock.method(console, "error", (...args: unknown[]) => { logged.push(args); });
    let response: Response;
    try {
      response = await harness.post("/api/thumbnail/suggestions", { topic: "a very distinctive topic string" });
      await response.arrayBuffer();
    } finally {
      restore.mock.restore();
    }
    assert.equal(response.status, 502);

    const failure = logged.find((args) => args[1] === "CLAUDE_FAILED");
    assert.ok(failure, `expected a CLAUDE_FAILED log line, got ${JSON.stringify(logged)}`);
    assert.equal(JSON.stringify(logged).includes("distinctive topic"), false);
  });
});
