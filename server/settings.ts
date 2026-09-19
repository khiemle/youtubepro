import { chmod, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Request } from "express";
import { z } from "zod";
import { getClaudeStatus } from "./claude-cli";
import { getHiggsfieldConnectionState } from "./higgsfield-image";
import {
  CLAUDE_TEXT_EFFORTS,
  CLAUDE_TEXT_MODELS,
  HIGGSFIELD_IMAGE_MODELS,
  getHiggsfieldImageModel,
  isClaudeTextEffort,
  isClaudeTextModel,
  isHiggsfieldImageModel,
  isHiggsfieldImageTier,
  resolveClaudeTextEffort,
  resolveClaudeTextModel,
  resolveHiggsfieldImageModel,
  resolveHiggsfieldImageTier,
} from "./provider-models";

const ENV_PATH = path.resolve(process.cwd(), ".env");
const ENV_TEMP_PATH = path.resolve(process.cwd(), ".env.tmp");
const SUPPORTED_KEYS = [
  "YOUTUBE_API_KEY",
  "CLAUDE_TEXT_MODEL",
  "CLAUDE_TEXT_EFFORT",
  "HIGGSFIELD_IMAGE_MODEL",
  "HIGGSFIELD_IMAGE_QUALITY",
] as const;

type SupportedKey = (typeof SUPPORTED_KEYS)[number];

export interface ApiKeySettings {
  youtubeApiKey?: string;
  claudeTextModel?: string;
  claudeTextEffort?: string;
  higgsfieldImageModel?: string;
  higgsfieldImageQuality?: string;
}

export const apiKeySettingsSchema = z.object({
  youtubeApiKey: z.string().trim().min(8).max(512).optional(),
  claudeTextModel: z.string().refine(isClaudeTextModel, "Select a supported Claude model.").optional(),
  claudeTextEffort: z.string().refine(isClaudeTextEffort, "Select a supported effort level.").optional(),
  higgsfieldImageModel: z.string().refine(isHiggsfieldImageModel, "Select a supported Higgsfield image model.").optional(),
  higgsfieldImageQuality: z.string().trim().min(1).max(16).optional(),
}).strict().superRefine((settings, ctx) => {
  if (settings.higgsfieldImageModel && settings.higgsfieldImageQuality
    && !isHiggsfieldImageTier(settings.higgsfieldImageModel, settings.higgsfieldImageQuality)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["higgsfieldImageQuality"],
      message: "Select a quality supported by this model.",
    });
  }
});

function isLoopbackAddress(address: string | undefined): boolean {
  if (!address) return false;
  return address === "127.0.0.1"
    || address === "::1"
    || address.startsWith("::ffff:127.");
}

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (normalized === "localhost" || normalized === "::1") return true;
  const octets = normalized.split(".");
  return octets.length === 4
    && octets[0] === "127"
    && octets.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255);
}

export interface LocalSettingsRequestMetadata {
  remoteAddress?: string;
  host?: string;
  origin?: string;
  forwarded?: string;
  xForwardedFor?: string;
  xForwardedHost?: string;
  xForwardedProto?: string;
  via?: string;
  secFetchSite?: string;
}

export function isTrustedLocalSettingsMetadata(input: LocalSettingsRequestMetadata): boolean {
  if (!isLoopbackAddress(input.remoteAddress)) return false;
  if (
    input.forwarded
    || input.xForwardedFor
    || input.xForwardedHost
    || input.xForwardedProto
    || input.via
  ) return false;

  if (!input.host) return false;
  if (/[@/\\\s%]/.test(input.host)) return false;
  let hostUrl: URL;
  try {
    hostUrl = new URL(`http://${input.host}`);
  } catch {
    return false;
  }
  if (!isLoopbackHostname(hostUrl.hostname)) return false;

  if (input.origin) {
    try {
      const origin = new URL(input.origin);
      if (
        !["http:", "https:"].includes(origin.protocol)
        || !isLoopbackHostname(origin.hostname)
        || origin.host !== hostUrl.host
      ) return false;
    } catch {
      return false;
    }
  }

  return !input.secFetchSite || input.secFetchSite === "same-origin" || input.secFetchSite === "none";
}

export function isLocalSettingsRequest(req: Request): boolean {
  return isTrustedLocalSettingsMetadata({
    remoteAddress: req.socket.remoteAddress,
    host: req.get("host"),
    origin: req.get("origin"),
    forwarded: req.get("forwarded"),
    xForwardedFor: req.get("x-forwarded-for"),
    xForwardedHost: req.get("x-forwarded-host"),
    xForwardedProto: req.get("x-forwarded-proto"),
    via: req.get("via"),
    secFetchSite: req.get("sec-fetch-site"),
  });
}

export interface ModelSettings {
  text: string;
  textEffort: string;
  image: string;
  imageQuality: string;
}

function currentModelSettings(): ModelSettings {
  return {
    text: resolveClaudeTextModel(),
    textEffort: resolveClaudeTextEffort(),
    image: resolveHiggsfieldImageModel().id,
    imageQuality: resolveHiggsfieldImageTier(),
  };
}

export async function getApiKeyStatus() {
  return {
    youtube: Boolean(process.env.YOUTUBE_API_KEY?.trim()),
    claude: await getClaudeStatus(),
    higgsfield: { connected: getHiggsfieldConnectionState() },
    models: {
      ...currentModelSettings(),
      textOptions: CLAUDE_TEXT_MODELS,
      effortOptions: CLAUDE_TEXT_EFFORTS,
      imageOptions: HIGGSFIELD_IMAGE_MODELS,
    },
  };
}

/** Merges an update into the current model settings and validates the result. Pure: it never touches the environment or disk. */
export function planSettingsUpdate(input: ApiKeySettings, current: ModelSettings): ModelSettings {
  const image = input.higgsfieldImageModel ?? current.image;
  const imageQuality = input.higgsfieldImageQuality
    ?? (isHiggsfieldImageTier(image, current.imageQuality)
      ? current.imageQuality
      : getHiggsfieldImageModel(image)?.defaultTier ?? "");
  const planned: ModelSettings = {
    text: input.claudeTextModel ?? current.text,
    textEffort: input.claudeTextEffort ?? current.textEffort,
    image,
    imageQuality,
  };

  if (!isClaudeTextModel(planned.text)) throw new Error("Select a supported Claude model.");
  if (!isClaudeTextEffort(planned.textEffort)) throw new Error("Select a supported effort level.");
  if (!isHiggsfieldImageModel(planned.image)) throw new Error("Select a supported Higgsfield image model.");
  if (!isHiggsfieldImageTier(planned.image, planned.imageQuality)) throw new Error("Select a quality supported by this model.");
  return planned;
}

function validateApiKey(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    throw new Error(`${label} must be a string.`);
  }

  const trimmed = value.trim();
  if (!trimmed) return undefined;
  if (trimmed.length < 8 || trimmed.length > 512) {
    throw new Error(`${label} must be between 8 and 512 characters.`);
  }
  if (/\r|\n|\0/.test(trimmed)) {
    throw new Error(`${label} contains unsupported characters.`);
  }
  return trimmed;
}

function setEnvValue(contents: string, key: SupportedKey, value: string): string {
  const assignment = `${key}=${JSON.stringify(value)}`;
  const lines = contents.split(/\r?\n/);
  const lineIndex = lines.findIndex((line) => line.startsWith(`${key}=`));

  if (lineIndex >= 0) {
    lines[lineIndex] = assignment;
  } else {
    if (lines.length > 0 && lines.at(-1) !== "") lines.push("");
    lines.push(assignment);
  }

  return `${lines.join("\n").replace(/\n+$/, "")}\n`;
}

export async function saveApiKeySettings(input: ApiKeySettings) {
  const youtubeApiKey = validateApiKey(input.youtubeApiKey, "YouTube API key");
  const planned = planSettingsUpdate(input, currentModelSettings());

  if (!youtubeApiKey
    && input.claudeTextModel === undefined
    && input.claudeTextEffort === undefined
    && input.higgsfieldImageModel === undefined
    && input.higgsfieldImageQuality === undefined) {
    throw new Error("Enter a replacement key or select a model to save.");
  }

  let contents = "";
  try {
    contents = await readFile(ENV_PATH, "utf8");
  } catch (error: any) {
    if (error?.code !== "ENOENT") throw error;
  }

  if (youtubeApiKey) contents = setEnvValue(contents, "YOUTUBE_API_KEY", youtubeApiKey);
  contents = setEnvValue(contents, "CLAUDE_TEXT_MODEL", planned.text);
  contents = setEnvValue(contents, "CLAUDE_TEXT_EFFORT", planned.textEffort);
  contents = setEnvValue(contents, "HIGGSFIELD_IMAGE_MODEL", planned.image);
  contents = setEnvValue(contents, "HIGGSFIELD_IMAGE_QUALITY", planned.imageQuality);

  await writeFile(ENV_TEMP_PATH, contents, { encoding: "utf8", mode: 0o600 });
  await rename(ENV_TEMP_PATH, ENV_PATH);
  await chmod(ENV_PATH, 0o600);

  if (youtubeApiKey) process.env.YOUTUBE_API_KEY = youtubeApiKey;
  process.env.CLAUDE_TEXT_MODEL = planned.text;
  process.env.CLAUDE_TEXT_EFFORT = planned.textEffort;
  process.env.HIGGSFIELD_IMAGE_MODEL = planned.image;
  process.env.HIGGSFIELD_IMAGE_QUALITY = planned.imageQuality;

  return getApiKeyStatus();
}
