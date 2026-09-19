// Opt-in live acceptance check. It is NOT part of `npm test`: it calls the real Claude CLI and,
// for `image`, spends Higgsfield credits (about 1-2 per image).
//
//   npm run live:claude -- text
//   npm run live:claude -- image --spend
//   npm run live:claude -- image --with-reference --spend
import { writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadEnvFile } from "node:process";
import { deflateSync } from "node:zlib";
import { DurationFilter, SortBy, UploadDateFilter, type ResearchInsightsRequest } from "@shared/schema";
import { generateResearchInsights } from "../server/ai";
import { getClaudeStatus } from "../server/claude-cli";
import { defaultThumbnailDeps, generateThumbnail } from "../server/higgsfield-image";
import { ProviderError } from "../server/provider-errors";

try {
  loadEnvFile(".env");
} catch (error: any) {
  if (error?.code !== "ENOENT") throw error;
}

const TEXT_BUDGET_MS = 120_000;
const [mode, ...flags] = process.argv.slice(2);

function usage(): never {
  console.error("usage: npm run live:claude -- text\n       npm run live:claude -- image [--with-reference] --spend");
  process.exit(2);
}

function describeFailure(error: unknown): string {
  if (error instanceof ProviderError) {
    const cause = error.cause instanceof Error ? ` | cause: ${error.cause.message}` : "";
    return `${error.code} (${error.status}): ${error.message}${cause}`;
  }
  return String(error);
}

// ---------------------------------------------------------------------------
// text: Research Insights on a synthetic 12-video snapshot
// ---------------------------------------------------------------------------

function buildResearchRequest(): ResearchInsightsRequest {
  const query = "best budget mirrorless camera for vlogging";
  const rows: Array<[string, string, number, number, number, number]> = [
    ["Best Budget Camera for Vlogging in 2026 (I Tested 6)", "Camera Lab Daily", 412000, 15800, 1320, 41],
    ["Sony ZV-E10 II vs Canon R50: Which Vlog Camera Wins?", "Lens & Light", 288000, 9100, 860, 96],
    ["Stop Buying the Wrong Vlogging Camera", "Creator Basics", 954000, 41200, 3900, 210],
    ["Cheapest Way to Start Vlogging (Under $500)", "Budget Creator", 133000, 5200, 410, 18],
    ["Panasonic G100D Review After 1 Year", "Frame by Frame", 67000, 2100, 240, 330],
    ["Is a Mirrorless Camera Worth It for Vlogging? Honest Take", "Sam Films", 221000, 8800, 1105, 130],
    ["Best Vlogging Cameras 2026 - Ranked", "Camera Lab Daily", 176000, 6100, 490, 12],
    ["Fujifilm X-M5 Vlog Test: Surprisingly Good", "Lens & Light", 92000, 3900, 355, 27],
    ["Vlogging Camera Buying Guide for Beginners", "Tech Explained", 505000, 12000, 980, 400],
    ["Sony ZV-1 II: Still the Best Compact Vlog Camera?", "Frame by Frame", 74000, 2600, 190, 75],
    ["$400 vs $2000 Vlogging Camera - Can You Tell?", "Creator Basics", 688000, 27000, 3100, 260],
    ["Canon R50 V Real-World Vlogging Review", "Sam Films", 58000, 1900, 150, 8],
  ];
  const now = Date.now();
  const channels = new Map<string, string>();
  const videos = rows.map(([title, channelTitle, viewCount, likeCount, commentCount, ageDays], index) => {
    if (!channels.has(channelTitle)) channels.set(channelTitle, `UClive${String(channels.size + 1).padStart(4, "0")}`);
    return {
      id: `liveVid${String(index + 1).padStart(3, "0")}`,
      title,
      channelTitle,
      channelId: channels.get(channelTitle)!,
      publishedAt: new Date(now - ageDays * 86_400_000).toISOString(),
      thumbnailUrl: `https://i.ytimg.com/vi/liveVid${index + 1}/hqdefault.jpg`,
      description: `${title}. Timestamps and gear list below.`,
      viewCount,
      likeCount,
      commentCount,
      duration: "PT12M00S",
      hasCaptions: true,
      definition: "hd",
      channelStatistics: { subscriberCount: 100_000 + index * 1_000, hiddenSubscriberCount: false },
    };
  });
  const views = rows.map((row) => row[2]);
  const sorted = [...views].sort((a, b) => a - b);
  const total = views.reduce((sum, value) => sum + value, 0);
  return {
    query,
    videos,
    snapshotId: "yt_livecheck01",
    retrievedAt: new Date(now).toISOString(),
    provenance: {
      provider: "youtube-data-api-v3",
      query,
      filters: { uploadDate: UploadDateFilter.ANY, duration: DurationFilter.ANY, sortBy: SortBy.RELEVANCE, maxResults: videos.length },
      orderedVideoIds: videos.map((video) => video.id),
    },
    analytics: {
      totalVideos: videos.length,
      totalViews: total,
      avgViews: Math.round(total / videos.length),
      medianViews: (sorted[5] + sorted[6]) / 2,
      medianDailyViews: 1_200,
      avgEngagement: 3.4,
      uniqueChannels: channels.size,
      durationData: [{ name: "10-15 min", value: videos.length }],
      recencyData: [{ name: "All", value: videos.length }],
      topTags: [{ label: "vlogging", count: 5 }],
      coverage: { views: 12, engagement: 12, subscribers: 12, captions: 12, tags: 0, hd: 12 },
    },
    enrichment: {
      search: { status: "complete", requested: 12, returned: 12 },
      videoDetails: { status: "complete", requested: 12, returned: 12 },
      channels: { status: "complete", requested: 12, returned: 12 },
    },
    warnings: [],
  };
}

async function runTextCheck(): Promise<boolean> {
  const status = await getClaudeStatus();
  console.log(`claude: ${JSON.stringify(status)}`);
  const started = Date.now();
  try {
    const result = await generateResearchInsights(buildResearchRequest());
    const seconds = (Date.now() - started) / 1000;
    const inTime = seconds * 1000 <= TEXT_BUDGET_MS;
    console.log(`Research Insights returned valid output in ${seconds.toFixed(1)} s (budget ${TEXT_BUDGET_MS / 1000} s)`);
    console.log(`claims=${result.evidenceClaims.length} questions=${result.peopleAlsoAsk.length} actions=${result.recommendedActions.length}`);
    console.log(`summary: ${result.summary.slice(0, 200)}`);
    console.log("NOTE: the fixture is synthetic. Read the output above and judge its quality on real research data separately.");
    return inTime;
  } catch (error) {
    console.error(`FAIL after ${((Date.now() - started) / 1000).toFixed(1)} s: ${describeFailure(error)}`);
    return false;
  }
}

// ---------------------------------------------------------------------------
// image: one thumbnail through Higgsfield
// ---------------------------------------------------------------------------

function crc32(buffer: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

/** A valid solid-colour RGB PNG, used as the reference image so no personal file is needed. */
function solidPng(size: number, [red, green, blue]: [number, number, number]): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8;
  header[9] = 2;
  const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({ length: size }, () => [red, green, blue]).flat())]);
  const raw = Buffer.concat(Array.from({ length: size }, () => row));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(raw)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

async function runImageCheck(withReference: boolean): Promise<boolean> {
  const hosts = new Set<string>();
  const deps = {
    ...defaultThumbnailDeps,
    media: {
      ...defaultThumbnailDeps.media,
      fetchImpl: (input: RequestInfo | URL, init?: RequestInit) => {
        hosts.add(new URL(input.toString()).host);
        return defaultThumbnailDeps.media.fetchImpl(input, init);
      },
    },
  };
  const config = {
    style: "tutorial" as const,
    mainText: "Same scene",
    subText: "",
    thumbnailDescription: "Side-by-side comparison of two cameras.",
    composition: "split-screen" as const,
    cameraAngle: "three-quarter" as const,
    lighting: "studio" as const,
    colorScheme: "complementary" as const,
    textPosition: "bottom" as const,
    autoBlend: false,
    referenceImages: withReference
      ? [{ image: `data:image/png;base64,${solidPng(256, [200, 60, 60]).toString("base64")}`, role: "style" as const }]
      : [],
    referenceRightsConfirmed: withReference,
    honestPromise: "See the same test from both cameras.",
    thumbnailConcept: "Two labeled cameras beside one test scene.",
    mode: "create" as const,
    variationDirection: undefined,
  };

  const started = Date.now();
  try {
    const result = await generateThumbnail("Camera comparison", config, deps);
    const match = /^data:(image\/[a-z]+);base64,(.+)$/.exec(result.imageData);
    if (!match) throw new Error("result was not an image data URL");
    const file = path.join(os.tmpdir(), `live-check-thumbnail-${withReference ? "reference" : "plain"}.${match[1].split("/")[1]}`);
    writeFileSync(file, Buffer.from(match[2], "base64"));
    console.log(`PASS in ${((Date.now() - started) / 1000).toFixed(1)} s | model ${result.model} | ${match[1]} | saved to ${file}`);
    console.log(`media hosts used: ${Array.from(hosts).join(", ") || "(none)"}`);
    return true;
  } catch (error) {
    console.error(`FAIL after ${((Date.now() - started) / 1000).toFixed(1)} s: ${describeFailure(error)}`);
    console.error(`media hosts seen before the failure: ${Array.from(hosts).join(", ") || "(none)"}`);
    return false;
  }
}

async function main(): Promise<void> {
  if (mode === "text") {
    process.exit((await runTextCheck()) ? 0 : 1);
  }
  if (mode === "image") {
    if (!flags.includes("--spend")) {
      console.error("This check spends Higgsfield credits (about 1-2 per image). Re-run with --spend to confirm.");
      process.exit(2);
    }
    process.exit((await runImageCheck(flags.includes("--with-reference"))) ? 0 : 1);
  }
  usage();
}

void main();
