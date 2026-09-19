import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import type { McpRunOptions, McpRunResult } from "./claude-cli";
import {
  HIGGSFIELD_TOOLS,
  generateThumbnail,
  getHiggsfieldConnectionState,
  resetHiggsfieldConnectionState,
  testHiggsfieldConnection,
  type ThumbnailDeps,
} from "./higgsfield-image";
import type { MediaDeps, MediaUrlPolicy } from "./media-guard";
import { ProviderError } from "./provider-errors";

const FAKE = fileURLToPath(new URL("./test-fixtures/fake-claude.mjs", import.meta.url));
chmodSync(FAKE, 0o755);

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 9, 8, 7]);
const LOCAL_POLICY: MediaUrlPolicy = { protocols: ["http:"], hostSuffixes: ["localhost"], resolve: async () => ["93.184.216.34"] };

const config = {
  style: "tutorial" as const,
  mainText: "Same scene",
  subText: "",
  thumbnailDescription: "Side-by-side comparison.",
  composition: "split-screen" as const,
  cameraAngle: "three-quarter" as const,
  lighting: "studio" as const,
  colorScheme: "complementary" as const,
  textPosition: "bottom" as const,
  autoBlend: false,
  referenceImages: [] as Array<{ image: string; role: "subject" | "style" | "background" | "composition" }>,
  referenceRightsConfirmed: false,
  honestPromise: "See the same test from both cameras.",
  thumbnailConcept: "Two labeled cameras beside one test scene.",
  mode: "create" as const,
  variationDirection: undefined,
};

const servers: http.Server[] = [];
let puts: Array<{ url: string; type?: string; body: Buffer }>;
let base: string;
let downloads: number;
let putStatus: number;

const ENV_KEYS = ["HIGGSFIELD_IMAGE_MODEL", "HIGGSFIELD_IMAGE_QUALITY", "CLAUDE_BIN", "FAKE_CLAUDE_MODE", "FAKE_CLAUDE_LOG", "FAKE_CLAUDE_RESULTS"] as const;
let savedEnv: Record<string, string | undefined>;

beforeEach(async () => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  for (const key of ENV_KEYS) delete process.env[key];
  puts = [];
  downloads = 0;
  putStatus = 200;
  resetHiggsfieldConnectionState();
  const server = http.createServer((req, res) => {
    if (req.method === "PUT") {
      const chunks: Buffer[] = [];
      req.on("data", (chunk) => chunks.push(chunk));
      req.on("end", () => {
        puts.push({ url: req.url ?? "", type: req.headers["content-type"], body: Buffer.concat(chunks) });
        res.statusCode = putStatus;
        res.end();
      });
      return;
    }
    downloads += 1;
    res.end(PNG);
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "localhost", resolve));
  base = `http://localhost:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => {
    server.closeAllConnections();
    server.close(() => resolve());
  })));
});

type Scripted = string | McpRunResult;

function scripted(replies: Scripted[]) {
  const calls: McpRunOptions[] = [];
  const runMcp = async (options: McpRunOptions): Promise<McpRunResult> => {
    calls.push(options);
    const next = replies[calls.length - 1];
    if (next === undefined) throw new Error("unexpected extra MCP run");
    return typeof next === "string" ? { result: next, sessionId: "sess-1", outOfTurns: false } : next;
  };
  return { calls, runMcp };
}

function thumbnailDeps(runMcp: ThumbnailDeps["runMcp"]): ThumbnailDeps {
  const media: MediaDeps = { fetchImpl: (input, init) => fetch(input, init), policy: LOCAL_POLICY, sleep: async () => {}, maxBytes: 1024 };
  return { runMcp, media };
}

async function rejection(promise: Promise<unknown>): Promise<ProviderError> {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof ProviderError, `expected ProviderError, got ${String(error)}`);
    return error;
  }
  throw new assert.AssertionError({ message: "expected the promise to reject" });
}

const ok = (url: string) => JSON.stringify({ status: "ok", url });
const failure = (reason: string) => JSON.stringify({ status: "error", reason });

describe("generateThumbnail without reference images", () => {
  test("runs one generate session with the right tools and returns a data URL", async () => {
    const { calls, runMcp } = scripted([ok(`${base}/result.png`)]);
    const result = await generateThumbnail("Camera comparison", config, thumbnailDeps(runMcp));

    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].allowedTools, [HIGGSFIELD_TOOLS.generateBatch, HIGGSFIELD_TOOLS.jobsWait]);
    assert.match(calls[0].prompt, /"model":"gpt_image_2_5","quality":"medium"/);
    assert.match(calls[0].prompt, /"aspect_ratio": "16:9"/);
    assert.match(calls[0].prompt, /"use_unlim": false/);
    assert.match(calls[0].prompt, /Never pass "use_unlim": true/);
    assert.equal(result.imageData, `data:image/png;base64,${PNG.toString("base64")}`);
    assert.equal(result.model, "GPT Image 2.5 (gpt_image_2_5)");
    assert.match(result.prompt, /Camera comparison/);
    assert.equal(getHiggsfieldConnectionState(), true);
  });

  test("uses the configured model, its tier parameter, and falls back on unknown values", async () => {
    process.env.HIGGSFIELD_IMAGE_MODEL = "seedream_v5_pro";
    process.env.HIGGSFIELD_IMAGE_QUALITY = "1k";
    let run = scripted([ok(`${base}/a.png`)]);
    await generateThumbnail("t", config, thumbnailDeps(run.runMcp));
    assert.match(run.calls[0].prompt, /"model":"seedream_v5_pro","resolution":"1k"/);

    process.env.HIGGSFIELD_IMAGE_MODEL = "nope";
    process.env.HIGGSFIELD_IMAGE_QUALITY = "ultra";
    run = scripted([ok(`${base}/a.png`)]);
    await generateThumbnail("t", config, thumbnailDeps(run.runMcp));
    assert.match(run.calls[0].prompt, /"model":"gpt_image_2_5","quality":"medium"/);
  });

  test("maps each structured failure to its code", async () => {
    const expected: Array<[string, string, number, boolean]> = [
      ["UNAVAILABLE", "HIGGSFIELD_NOT_CONNECTED", 503, false],
      ["NO_CREDITS", "HIGGSFIELD_NO_CREDITS", 402, false],
      ["BLOCKED", "HIGGSFIELD_NO_IMAGE", 502, false],
      ["OTHER", "HIGGSFIELD_FAILED", 502, true],
    ];
    for (const [reason, code, status, retryable] of expected) {
      const error = await rejection(generateThumbnail("t", config, thumbnailDeps(scripted([failure(reason)]).runMcp)));
      assert.deepEqual([error.code, error.status, error.retryable], [code, status, retryable], reason);
    }
    assert.equal(getHiggsfieldConnectionState(), false);
  });

  test("rescues an unparseable reply and an out-of-turns run with one --resume re-ask", async () => {
    let run = scripted(["I finished!", ok(`${base}/a.png`)]);
    await generateThumbnail("t", config, thumbnailDeps(run.runMcp));
    assert.equal(run.calls.length, 2);
    assert.equal(run.calls[1].resume, "sess-1");
    assert.match(run.calls[1].prompt, /Reply now with ONLY/);

    run = scripted([{ result: "", sessionId: "sess-2", outOfTurns: true }, ok(`${base}/a.png`)]);
    await generateThumbnail("t", config, thumbnailDeps(run.runMcp));
    assert.equal(run.calls[1].resume, "sess-2");
  });

  test("fails with HIGGSFIELD_INCOMPLETE when the re-ask does not help", async () => {
    const run = scripted(["nope", "still nope"]);
    const error = await rejection(generateThumbnail("t", config, thumbnailDeps(run.runMcp)));
    assert.equal(error.code, "HIGGSFIELD_INCOMPLETE");
    assert.equal(error.status, 504);
    assert.equal(error.retryable, false);
  });

  test("refuses a result URL outside the policy before downloading anything", async () => {
    const error = await rejection(generateThumbnail("t", config, thumbnailDeps(scripted([ok("http://evil.example/a.png")]).runMcp)));
    assert.equal(error.code, "HIGGSFIELD_BAD_MEDIA");
    assert.equal(downloads, 0);
  });
});

describe("generateThumbnail with reference images", () => {
  const refBytes = [Buffer.from("first reference bytes"), Buffer.from("second reference bytes")];
  const refsConfig = {
    ...config,
    referenceImages: [
      { image: `data:image/png;base64,${refBytes[0].toString("base64")}`, role: "subject" as const },
      { image: `data:image/jpeg;base64,${refBytes[1].toString("base64")}`, role: "style" as const },
    ],
    referenceRightsConfirmed: true,
  };
  const uploadReply = () => JSON.stringify({
    status: "ok",
    uploads: [
      { index: 1, upload_url: `${base}/up/1`, media_id: "media-b" },
      { index: 0, upload_url: `${base}/up/0`, media_id: "media-a" },
    ],
  });

  test("uploads the exact bytes, then generates with the confirmed media in order", async () => {
    const { calls, runMcp } = scripted([uploadReply(), ok(`${base}/result.png`)]);
    const result = await generateThumbnail("t", refsConfig, thumbnailDeps(runMcp));

    assert.equal(calls.length, 2);
    assert.deepEqual(calls[0].allowedTools, [HIGGSFIELD_TOOLS.mediaUpload]);
    assert.match(calls[0].prompt, /"filename":"reference-1\.png","content_type":"image\/png"/);
    assert.match(calls[0].prompt, /"filename":"reference-2\.jpg","content_type":"image\/jpeg"/);

    assert.deepEqual(puts.map((put) => put.url).sort(), ["/up/0", "/up/1"]);
    assert.deepEqual(puts.find((put) => put.url === "/up/0")?.body, refBytes[0]);
    assert.equal(puts.find((put) => put.url === "/up/0")?.type, "image/png");
    assert.deepEqual(puts.find((put) => put.url === "/up/1")?.body, refBytes[1]);
    assert.equal(puts.find((put) => put.url === "/up/1")?.type, "image/jpeg");

    assert.deepEqual(calls[1].allowedTools, [HIGGSFIELD_TOOLS.mediaConfirm, HIGGSFIELD_TOOLS.generateBatch, HIGGSFIELD_TOOLS.jobsWait]);
    assert.match(calls[1].prompt, /\["media-a","media-b"\]/);
    assert.match(calls[1].prompt, /"role":"image_references"/);
    assert.equal(result.imageData.startsWith("data:image/png;base64,"), true);
  });

  test("uses the selected model's media role", async () => {
    process.env.HIGGSFIELD_IMAGE_MODEL = "gpt_image_2";
    const { calls, runMcp } = scripted([uploadReply(), ok(`${base}/result.png`)]);
    await generateThumbnail("t", refsConfig, thumbnailDeps(runMcp));
    assert.match(calls[1].prompt, /"role":"image"/);
  });

  test("never starts a generate run when an upload fails", async () => {
    putStatus = 500;
    const { calls, runMcp } = scripted([uploadReply()]);
    const error = await rejection(generateThumbnail("t", refsConfig, thumbnailDeps(runMcp)));
    assert.equal(error.code, "HIGGSFIELD_UPLOAD_FAILED");
    assert.equal(calls.length, 1);
  });

  test("rejects an upload reply that does not match the references", async () => {
    const short = JSON.stringify({ status: "ok", uploads: [{ index: 0, upload_url: `${base}/up/0`, media_id: "media-a" }] });
    const { calls, runMcp } = scripted([short]);
    const error = await rejection(generateThumbnail("t", refsConfig, thumbnailDeps(runMcp)));
    assert.equal(error.code, "HIGGSFIELD_FAILED");
    assert.equal(calls.length, 1);
    assert.equal(puts.length, 0);
  });
});

describe("testHiggsfieldConnection", () => {
  test("reads the balance with a Haiku session and marks Higgsfield connected", async () => {
    const { calls, runMcp } = scripted([JSON.stringify({ status: "ok", credits: 280.13 })]);
    assert.deepEqual(await testHiggsfieldConnection(runMcp), { connected: true, credits: 280.13 });
    assert.deepEqual(calls[0].allowedTools, [HIGGSFIELD_TOOLS.balance]);
    assert.equal(calls[0].model, "haiku");
    assert.equal(calls[0].effort, null);
    assert.equal(getHiggsfieldConnectionState(), true);
  });

  test("reports an unavailable server as HIGGSFIELD_NOT_CONNECTED", async () => {
    const error = await rejection(testHiggsfieldConnection(scripted([failure("UNAVAILABLE")]).runMcp));
    assert.equal(error.code, "HIGGSFIELD_NOT_CONNECTED");
    assert.equal(getHiggsfieldConnectionState(), false);
  });
});

describe("through the real MCP runner and the fake CLI", () => {
  test("wires CLAUDE_BIN, the MCP profile and the reply parser together", async () => {
    const tmp = mkdtempSync(path.join(os.tmpdir(), "higgsfield-e2e-"));
    try {
      process.env.CLAUDE_BIN = FAKE;
      process.env.FAKE_CLAUDE_MODE = "results";
      process.env.FAKE_CLAUDE_LOG = path.join(tmp, "calls.jsonl");
      process.env.FAKE_CLAUDE_RESULTS = JSON.stringify([ok(`${base}/result.png`)]);
      const media: MediaDeps = { fetchImpl: (input, init) => fetch(input, init), policy: LOCAL_POLICY, sleep: async () => {}, maxBytes: 1024 };
      const { runClaudeMcp } = await import("./claude-cli");

      const result = await generateThumbnail("t", config, { runMcp: runClaudeMcp, media });

      assert.equal(result.imageData.startsWith("data:image/png;base64,"), true);
      assert.equal(existsSync(process.env.FAKE_CLAUDE_LOG), true);
      const [call] = readFileSync(process.env.FAKE_CLAUDE_LOG, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
      assert.ok(call.argv.includes("--mcp-config"));
      assert.equal(call.argv[call.argv.indexOf("--allowedTools") + 1], `${HIGGSFIELD_TOOLS.generateBatch},${HIGGSFIELD_TOOLS.jobsWait}`);
      assert.match(call.stdin, /Generate one image using the Higgsfield MCP tools/);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
