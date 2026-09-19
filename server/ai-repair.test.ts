import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, test } from "node:test";
import { startRouteHarness, type RouteHarness } from "./test-fixtures/route-harness";

let harness: RouteHarness;

beforeEach(async () => {
  harness = await startRouteHarness();
});

afterEach(async () => {
  await harness.stop();
});

/** Every recorded fake-CLI call, in order. */
function calls(): { argv: string[]; stdin: string }[] {
  const path = process.env.FAKE_CLAUDE_LOG;
  assert.ok(path, "the harness must set FAKE_CLAUDE_LOG");
  let raw = "";
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    raw = "";
  }
  return raw.split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

function replies(...results: string[]): void {
  process.env.FAKE_CLAUDE_MODE = "results";
  process.env.FAKE_CLAUDE_RESULTS = JSON.stringify(results);
}

const SNAPSHOT = "yt_12345678";
const BAD = JSON.stringify({ definitely: "not the expected shape" });

const scriptRequest = {
  topic: "Camera comparison",
  format: "Tutorial/How-to",
  audience: "General Audience",
};

const ideasRequest = {
  niche: "Cameras",
  researchContext: {
    query: "camera comparison",
    snapshotId: SNAPSHOT,
    sourceVideoIds: ["video-1"],
    evidenceClaims: [{
      id: "claim-1",
      claim: "The sample is dominated by comparison videos.",
      evidenceClass: "observed",
      sourceVideoIds: ["video-1"],
      confidence: "high",
      limitations: ["Limited to this public snapshot."],
      snapshotId: SNAPSHOT,
    }],
  },
};

const titlesRequest = { topic: "Camera comparison", format: "Tutorial/How-to", audience: "General Audience" };

function researchRequest() {
  return {
    query: "camera comparison",
    snapshotId: SNAPSHOT,
    retrievedAt: "2026-09-19T10:00:00.000Z",
    videos: [{
      id: "video-1",
      title: "Camera A versus Camera B",
      channelTitle: "Lens Lab",
      channelId: "channel-1",
      publishedAt: "2026-09-01T10:00:00Z",
      thumbnailUrl: "https://i.ytimg.com/vi/video-1/hq.jpg",
      description: "A controlled comparison.",
      viewCount: 1_000,
      duration: "PT10M",
    }],
    provenance: {
      provider: "youtube-data-api-v3",
      query: "camera comparison",
      filters: { uploadDate: "any", duration: "any", sortBy: "relevance", maxResults: 25 },
      orderedVideoIds: ["video-1"],
    },
    analytics: {
      totalVideos: 1,
      totalViews: 1_000,
      avgViews: 1_000,
      medianViews: 1_000,
      medianDailyViews: 50,
      avgEngagement: "N/A",
      uniqueChannels: 1,
      durationData: [],
      recencyData: [],
      topTags: [],
      coverage: { views: 1, engagement: 0, subscribers: 0, captions: 0, tags: 0, hd: 0 },
    },
    enrichment: {
      search: { status: "complete", requested: 1, returned: 1 },
      videoDetails: { status: "complete", requested: 1, returned: 1 },
      channels: { status: "complete", requested: 1, returned: 1 },
    },
    warnings: [],
  };
}

/** A research reply that satisfies researchInsightsContentSchema for the one-video request above. */
function validResearchContent() {
  return {
    summary: "The sample shows a clear review intent. Test one focused comparison.",
    queryIntent: {
      primaryIntent: "Compare cameras",
      viewerNeed: "Choose a camera",
      discoverySurface: "Search, based on the explicit comparison query",
      credibilityNote: "Demonstrate the tested setup",
    },
    evidenceSignals: {
      observed: ["Observed one", "Observed two", "Observed three"],
      inferred: ["Inference one", "Inference two", "Inference three"],
      requiresStudio: ["Studio one", "Studio two", "Studio three"],
    },
    evidenceClaims: Array.from({ length: 9 }, (_, index) => ({
      id: `claim-${index + 1}`,
      claim: `Evidence claim ${index + 1}`,
      evidenceClass: index < 3 ? "observed" : index < 6 ? "inferred" : "requires_studio",
      sourceVideoIds: index < 3 ? ["video-1"] : [],
      confidence: index < 3 ? "high" : "medium",
      limitations: ["Limited to this public snapshot."],
      snapshotId: SNAPSHOT,
    })) as Record<string, unknown>[],
    peopleAlsoAsk: Array.from({ length: 6 }, (_, index) => ({
      question: `Question ${index + 1}?`,
      answer: `Answer ${index + 1}`,
    })),
    targetAudience: {
      primaryDemographic: "Inferred camera buyers",
      ageRange: "Insufficient evidence",
      interests: ["Cameras"],
      painPoints: ["Comparing specifications"],
      contentPreferences: ["Direct demonstrations"],
    },
    nicheAnalysis: {
      competitionLevel: "Medium sample signal",
      growthTrend: "Insufficient evidence",
      bestPostingTimes: ["Insufficient evidence from this snapshot"],
      recommendedFormats: ["Comparison"],
      monetizationPotential: "Commercial-intent hypothesis only",
    },
    contentGaps: ["A controlled low-light comparison"],
    trendingSubtopics: ["Low-light video"],
    recommendedActions: Array.from({ length: 3 }, (_, index) => ({
      title: `Experiment ${index + 1}`,
      rationale: "Validate the hypothesis with Studio impressions and retention.",
      format: "Comparison",
    })),
    methodology: {
      sampleSize: 1,
      basis: "Public YouTube Data API search-result metadata snapshot",
      limitations: ["Missing owner-only Analytics metrics"],
    },
  };
}

/** The same content with the last claim missing its snapshotId, which fails the schema at evidenceClaims.8.snapshotId. */
function researchContentMissingSnapshotId() {
  const content = validResearchContent();
  delete content.evidenceClaims[8].snapshotId;
  return content;
}

describe("post-repair AI failures carry their own codes", () => {
  const cases = [
    { name: "script generation", route: "/api/script/generate", body: scriptRequest, code: "AI_SCRIPT_INVALID" },
    { name: "ideas generation", route: "/api/ideas/generate", body: ideasRequest, code: "AI_IDEAS_INVALID" },
    { name: "title regeneration", route: "/api/script/regenerate-titles", body: titlesRequest, code: "AI_TITLES_INVALID" },
  ];

  for (const testCase of cases) {
    test(`${testCase.name} reports ${testCase.code} after one repair attempt`, async () => {
      replies(BAD, BAD);
      const response = await harness.post(testCase.route, testCase.body);
      assert.equal(response.status, 502);
      const payload = await response.json();
      assert.equal(payload.code, testCase.code);
      assert.equal(payload.category, "invalid_response");
      assert.equal(payload.retryable, false);
      assert.equal(typeof payload.suggestion, "string");
      assert.ok(payload.suggestion.length > 0);
      assert.equal(calls().length, 2, "exactly one repair attempt");
    });
  }
});

describe("Research Insights repairs once", () => {
  test("a schema miss is repaired with a compact validation summary", async () => {
    replies(JSON.stringify(researchContentMissingSnapshotId()), JSON.stringify(validResearchContent()));
    const response = await harness.post("/api/research/insights", researchRequest());
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.snapshotId, SNAPSHOT);

    const recorded = calls();
    assert.equal(recorded.length, 2);
    assert.match(recorded[1].stdin, /failed validation/);
    assert.match(recorded[1].stdin, /evidenceClaims\.8\.snapshotId/);
  });

  test("two invalid replies end as AI_RESEARCH_SCHEMA_MISMATCH", async () => {
    const invalid = JSON.stringify(researchContentMissingSnapshotId());
    replies(invalid, invalid);
    const response = await harness.post("/api/research/insights", researchRequest());
    assert.equal(response.status, 502);
    const payload = await response.json();
    assert.equal(payload.code, "AI_RESEARCH_SCHEMA_MISMATCH");
    assert.equal(payload.category, "invalid_response");
    assert.equal(calls().length, 2);
  });

  test("a provider failure is never retried", async () => {
    process.env.FAKE_CLAUDE_MODE = "auth";
    const response = await harness.post("/api/research/insights", researchRequest());
    assert.equal(response.status, 401);
    assert.equal((await response.json()).code, "CLAUDE_NOT_SIGNED_IN");
    assert.equal(calls().length, 1, "a signed-out CLI must not be retried");
  });
});
