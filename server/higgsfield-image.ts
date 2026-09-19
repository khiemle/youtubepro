import type { ProviderErrorCategory } from "@shared/schema";
import { z } from "zod";
import { buildThumbnailPrompt, type ThumbnailConfig, type ThumbnailResult } from "./ai";
import { HIGGSFIELD_MCP_NAME, runClaudeMcp, type McpRunOptions, type McpRunResult } from "./claude-cli";
import { defaultMediaDeps, downloadImage, uploadBytes, type MediaDeps } from "./media-guard";
import { logProviderFailure, normalizeProviderError, ProviderError } from "./provider-errors";
import { resolveHiggsfieldImageModel, resolveHiggsfieldImageTier, type HiggsfieldImageModel } from "./provider-models";

export const HIGGSFIELD_TOOLS = {
  balance: `mcp__${HIGGSFIELD_MCP_NAME}__balance`,
  mediaUpload: `mcp__${HIGGSFIELD_MCP_NAME}__media_upload`,
  mediaConfirm: `mcp__${HIGGSFIELD_MCP_NAME}__media_confirm`,
  generateBatch: `mcp__${HIGGSFIELD_MCP_NAME}__generate_image_batch`,
  jobsWait: `mcp__${HIGGSFIELD_MCP_NAME}__jobs_wait`,
} as const;

// ---------------------------------------------------------------------------
// Failures
// ---------------------------------------------------------------------------

const RUN_FAILURES = {
  HIGGSFIELD_NOT_CONNECTED: {
    category: "missing_key",
    status: 503,
    retryable: false,
    publicMessage: "Higgsfield is not connected to Claude Code.",
    suggestion: "Run `claude mcp add --transport http higgsfield https://mcp.higgsfield.ai/mcp`, then open `claude` and sign in with /mcp. Use Test connection in Settings to confirm.",
  },
  HIGGSFIELD_NO_CREDITS: {
    category: "quota",
    status: 402,
    retryable: false,
    publicMessage: "Your Higgsfield account is out of credits.",
    suggestion: "Add credits in Higgsfield, then try again.",
  },
  HIGGSFIELD_NO_IMAGE: {
    category: "invalid_response",
    status: 502,
    retryable: false,
    publicMessage: "Higgsfield did not produce an image.",
    suggestion: "The request may have been blocked by content moderation. Adjust the thumbnail text or direction and try again.",
  },
  HIGGSFIELD_FAILED: {
    category: "provider_server",
    status: 502,
    retryable: true,
    publicMessage: "Higgsfield returned an error.",
    suggestion: "Retry once. If it continues, use Test connection in Settings.",
  },
  HIGGSFIELD_INCOMPLETE: {
    category: "timeout",
    status: 504,
    retryable: false,
    publicMessage: "Higgsfield did not finish before the session ended.",
    suggestion: "Credits may already have been spent. Check your Higgsfield generations before retrying.",
  },
} as const satisfies Record<string, {
  category: ProviderErrorCategory;
  status: number;
  retryable: boolean;
  publicMessage: string;
  suggestion: string;
}>;

type RunFailureCode = keyof typeof RUN_FAILURES;

export function higgsfieldFailure(code: RunFailureCode, cause?: unknown): ProviderError {
  const failure = RUN_FAILURES[code];
  return new ProviderError({
    message: failure.publicMessage,
    code,
    category: failure.category,
    status: failure.status,
    retryable: failure.retryable,
    publicMessage: failure.publicMessage,
    suggestion: failure.suggestion,
    cause,
  });
}

// ---------------------------------------------------------------------------
// Structured replies
// ---------------------------------------------------------------------------

const failureReply = z.object({
  status: z.literal("error"),
  reason: z.enum(["UNAVAILABLE", "NO_CREDITS", "BLOCKED", "OTHER"]),
  detail: z.string().max(500).optional(),
});
type FailureReply = z.infer<typeof failureReply>;

const imageReply = z.union([
  z.object({ status: z.literal("ok"), url: z.string().min(1).max(4_096) }),
  failureReply,
]);

const uploadReply = z.union([
  z.object({
    status: z.literal("ok"),
    uploads: z.array(z.object({
      index: z.number().int().min(0),
      upload_url: z.string().min(1).max(4_096),
      media_id: z.string().min(1).max(200),
    })).min(1).max(3),
  }),
  failureReply,
]);

const balanceReply = z.union([
  z.object({ status: z.literal("ok"), credits: z.number().finite() }),
  failureReply,
]);

function extractJson(text: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  const candidate = fenced ? fenced[1] : text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1);
  try {
    return JSON.parse(candidate);
  } catch {
    return null;
  }
}

function parseReply<T>(text: string, schema: z.ZodType<T>): T | null {
  const parsed = schema.safeParse(extractJson(text));
  return parsed.success ? parsed.data : null;
}

function throwFailureReply(reply: FailureReply): never {
  const code: RunFailureCode = reply.reason === "UNAVAILABLE" ? "HIGGSFIELD_NOT_CONNECTED"
    : reply.reason === "NO_CREDITS" ? "HIGGSFIELD_NO_CREDITS"
    : reply.reason === "BLOCKED" ? "HIGGSFIELD_NO_IMAGE"
    : "HIGGSFIELD_FAILED";
  throw higgsfieldFailure(code, reply.detail);
}

export type McpRunner = (options: McpRunOptions) => Promise<McpRunResult>;

const REASK_PROMPT = "You ran out of turns, or your last reply was not the required JSON. Use no further tools. Reply now with ONLY the one JSON object described in the original instructions.";

/** Runs a session and parses its reply. One `--resume` re-ask rescues an unparseable reply or a run that hit the turn limit. */
async function askForReply<T>(options: McpRunOptions, schema: z.ZodType<T>, runMcp: McpRunner): Promise<T> {
  let run = await runMcp(options);
  let reply = run.outOfTurns ? null : parseReply(run.result, schema);
  if (reply) return reply;
  if (!run.sessionId) throw higgsfieldFailure("HIGGSFIELD_INCOMPLETE");

  run = await runMcp({ ...options, prompt: REASK_PROMPT, resume: run.sessionId, maxTurns: 3 });
  reply = run.outOfTurns ? null : parseReply(run.result, schema);
  if (reply) return reply;
  throw higgsfieldFailure("HIGGSFIELD_INCOMPLETE");
}

// ---------------------------------------------------------------------------
// Briefs
// ---------------------------------------------------------------------------

const ERROR_REPLY_INSTRUCTIONS = [
  'If the Higgsfield tools are unavailable or you must sign in, reply {"status":"error","reason":"UNAVAILABLE"}.',
  'If a tool reports insufficient credits, reply {"status":"error","reason":"NO_CREDITS"}.',
  'If a job fails or is blocked by moderation, reply {"status":"error","reason":"BLOCKED"}.',
  'For any other failure reply {"status":"error","reason":"OTHER","detail":"<one short sentence>"}.',
].join("\n");

interface DecodedReference {
  bytes: Buffer;
  mimeType: "image/png" | "image/jpeg";
  filename: string;
}

function decodeReferences(images: ThumbnailConfig["referenceImages"]): DecodedReference[] {
  const decoded: DecodedReference[] = [];
  for (const reference of images) {
    const match = /^data:(image\/(?:png|jpeg));base64,(.+)$/.exec(reference.image);
    if (!match) continue;
    const mimeType = match[1] as DecodedReference["mimeType"];
    decoded.push({
      bytes: Buffer.from(match[2], "base64"),
      mimeType,
      filename: `reference-${decoded.length + 1}.${mimeType === "image/png" ? "png" : "jpg"}`,
    });
  }
  return decoded;
}

export function buildUploadBrief(references: readonly Pick<DecodedReference, "filename" | "mimeType">[]): string {
  const files = references.map((reference) => ({ filename: reference.filename, content_type: reference.mimeType }));
  return [
    `Use the Higgsfield MCP tools (server "${HIGGSFIELD_MCP_NAME}").`,
    `Call \`${HIGGSFIELD_TOOLS.mediaUpload}\` once with these files: ${JSON.stringify(files)}. It returns presigned upload URLs. Do not upload any bytes yourself and do not call any other tool.`,
    "Reply with ONLY one JSON object, nothing else:",
    '{"status":"ok","uploads":[{"index":0,"upload_url":"<exact upload URL for file 0>","media_id":"<exact media id the tool returned for file 0>"}]}',
    "Include one entry per file, in the order above. Copy every value exactly, character for character.",
    ERROR_REPLY_INSTRUCTIONS,
  ].join("\n");
}

export function buildGenerateBrief(input: {
  prompt: string;
  model: HiggsfieldImageModel;
  tier: string;
  mediaIds: readonly string[];
}): string {
  const params = { model: input.model.id, [input.model.tierParam]: input.tier };
  const withReferences = input.mediaIds.length > 0;
  const medias = input.mediaIds.map((id) => `{"value":"<confirmed media id for ${id}>","role":"${input.model.mediaRole}"}`);
  return [
    `Generate one image using the Higgsfield MCP tools (server "${HIGGSFIELD_MCP_NAME}").`,
    `Model params, used unchanged: ${JSON.stringify(params)}`,
    `Prompt (a JSON string): ${JSON.stringify(input.prompt)}`,
    withReferences ? `Reference media ids, already uploaded and in this order: ${JSON.stringify(input.mediaIds)}` : "",
    "Steps:",
    withReferences
      ? `1. Call \`${HIGGSFIELD_TOOLS.mediaConfirm}\` for each reference media id (read that tool's own schema for its parameters) and note the confirmed media id it returns.`
      : "",
    `${withReferences ? "2" : "1"}. Call \`${HIGGSFIELD_TOOLS.generateBatch}\` with exactly one job: the model params, the prompt, "aspect_ratio": "16:9", "use_unlim": false, "count": 1${withReferences ? `, and "medias": [${medias.join(",")}] in that order` : ""}. Never pass "use_unlim": true.`,
    `${withReferences ? "3" : "2"}. Call \`${HIGGSFIELD_TOOLS.jobsWait}\` with jobs=[{"index":0,"job_id":<the job id>}] and timeout_seconds <= 15, again and again and respecting poll_after_seconds, until all_terminal is true.`,
    `${withReferences ? "4" : "3"}. Reply with ONLY one JSON object, nothing else: {"status":"ok","url":"<the result image URL, copied exactly>"}`,
    ERROR_REPLY_INSTRUCTIONS,
  ].filter(Boolean).join("\n");
}

const BALANCE_BRIEF = [
  `Call \`${HIGGSFIELD_TOOLS.balance}\` with no arguments. Do not call any other tool.`,
  'Reply with ONLY one JSON object, nothing else: {"status":"ok","credits":<the credits number the tool returned>}',
  ERROR_REPLY_INSTRUCTIONS,
].join("\n");

// ---------------------------------------------------------------------------
// Connection state
// ---------------------------------------------------------------------------

let connected: boolean | null = null;

/** In-memory only: null until a thumbnail or the connection test has run. */
export function getHiggsfieldConnectionState(): boolean | null {
  return connected;
}

export function resetHiggsfieldConnectionState(): void {
  connected = null;
}

function noteFailure(error: ProviderError): void {
  if (error.code === "HIGGSFIELD_NOT_CONNECTED") connected = false;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface ThumbnailDeps {
  runMcp: McpRunner;
  media: MediaDeps;
}

export const defaultThumbnailDeps: ThumbnailDeps = { runMcp: runClaudeMcp, media: defaultMediaDeps };

async function uploadReferences(references: DecodedReference[], deps: ThumbnailDeps): Promise<string[]> {
  const reply = await askForReply(
    { prompt: buildUploadBrief(references), allowedTools: [HIGGSFIELD_TOOLS.mediaUpload] },
    uploadReply,
    deps.runMcp,
  );
  if (reply.status === "error") throwFailureReply(reply);

  const ordered = [...reply.uploads].sort((a, b) => a.index - b.index);
  if (ordered.length !== references.length || ordered.some((upload, position) => upload.index !== position)) {
    throw higgsfieldFailure("HIGGSFIELD_FAILED", new Error("Upload reply did not match the reference images."));
  }
  for (let position = 0; position < ordered.length; position += 1) {
    await uploadBytes(ordered[position].upload_url, references[position].bytes, references[position].mimeType, deps.media);
  }
  return ordered.map((upload) => upload.media_id);
}

export async function generateThumbnail(
  topic: string,
  config: ThumbnailConfig,
  deps: ThumbnailDeps = defaultThumbnailDeps,
): Promise<ThumbnailResult> {
  const prompt = buildThumbnailPrompt(topic, config);
  const model = resolveHiggsfieldImageModel();
  const tier = resolveHiggsfieldImageTier();

  try {
    const references = decodeReferences(config.referenceImages);
    const mediaIds = references.length > 0 ? await uploadReferences(references, deps) : [];
    const allowedTools = [
      ...(mediaIds.length > 0 ? [HIGGSFIELD_TOOLS.mediaConfirm] : []),
      HIGGSFIELD_TOOLS.generateBatch,
      HIGGSFIELD_TOOLS.jobsWait,
    ];
    const reply = await askForReply(
      { prompt: buildGenerateBrief({ prompt, model, tier, mediaIds }), allowedTools },
      imageReply,
      deps.runMcp,
    );
    if (reply.status === "error") throwFailureReply(reply);

    const { bytes, mimeType } = await downloadImage(reply.url, deps.media);
    connected = true;
    return {
      imageData: `data:${mimeType};base64,${bytes.toString("base64")}`,
      prompt,
      model: `${model.label} (${model.id})`,
    };
  } catch (error) {
    const normalized = normalizeProviderError(error, "higgsfield");
    noteFailure(normalized);
    logProviderFailure("Thumbnail generation", normalized);
    throw normalized;
  }
}

/** Runs the read-only `balance` tool through a Haiku session. Spends no credits. */
export async function testHiggsfieldConnection(
  runMcp: McpRunner = runClaudeMcp,
): Promise<{ connected: true; credits: number }> {
  try {
    const reply = await askForReply(
      { prompt: BALANCE_BRIEF, allowedTools: [HIGGSFIELD_TOOLS.balance], model: "haiku", effort: null, maxTurns: 4 },
      balanceReply,
      runMcp,
    );
    if (reply.status === "error") throwFailureReply(reply);
    connected = true;
    return { connected: true, credits: reply.credits };
  } catch (error) {
    const normalized = normalizeProviderError(error, "higgsfield");
    noteFailure(normalized);
    logProviderFailure("Higgsfield connection test", normalized);
    throw normalized;
  }
}
