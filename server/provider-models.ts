export const GEMINI_TEXT_MODELS = [
  {
    id: "gemini-3.7-flash",
    label: "Gemini 3.7 Flash",
    description: "Recommended production default for capable, fast research and writing.",
  },
  {
    id: "gemini-3.1-pro-preview",
    label: "Gemini 3.1 Pro (Preview)",
    description: "Highest-reasoning option, with preview stability and latency tradeoffs.",
  },
  {
    id: "gemini-3.6-flash",
    label: "Gemini 3.6 Flash",
    description: "Previous-generation balanced model.",
  },
  {
    id: "gemini-3.5-flash",
    label: "Gemini 3.5 Flash",
    description: "Stable general-purpose model.",
  },
  {
    id: "gemini-3.5-flash-lite",
    label: "Gemini 3.5 Flash-Lite",
    description: "Lower-cost choice for high-volume work.",
  },
  {
    id: "gemini-3.1-flash-lite",
    label: "Gemini 3.1 Flash-Lite",
    description: "Efficient earlier-generation model.",
  },
] as const;

export const GEMINI_IMAGE_MODELS = [
  {
    id: "gemini-3.1-flash-image",
    label: "Nano Banana 2",
    description: "Recommended balance of image quality, speed, and cost.",
  },
  {
    id: "gemini-3.1-flash-lite-image",
    label: "Nano Banana 2 Lite",
    description: "Fastest, lowest-cost image option.",
  },
  {
    id: "gemini-3-pro-image",
    label: "Nano Banana Pro",
    description: "Premium option for complex, high-precision thumbnails.",
  },
  {
    id: "gemini-2.5-flash-image",
    label: "Nano Banana (legacy)",
    description: "Legacy image model retained for compatibility.",
  },
] as const;

export const DEFAULT_GEMINI_TEXT_MODEL = GEMINI_TEXT_MODELS[0].id;
export const DEFAULT_GEMINI_IMAGE_MODEL = GEMINI_IMAGE_MODELS[0].id;

export type GeminiTextModel = (typeof GEMINI_TEXT_MODELS)[number]["id"];
export type GeminiImageModel = (typeof GEMINI_IMAGE_MODELS)[number]["id"];

export function isGeminiTextModel(value: string): value is GeminiTextModel {
  return GEMINI_TEXT_MODELS.some((model) => model.id === value);
}

export function isGeminiImageModel(value: string): value is GeminiImageModel {
  return GEMINI_IMAGE_MODELS.some((model) => model.id === value);
}

export function getGeminiImageModelLabel(modelId: string): string {
  return GEMINI_IMAGE_MODELS.find((model) => model.id === modelId)?.label || modelId;
}

export const CLAUDE_TEXT_MODELS = [
  {
    id: "sonnet",
    label: "Claude Sonnet",
    description: "Recommended. The model this app was tested with.",
  },
  {
    id: "opus",
    label: "Claude Opus",
    description: "Highest capability. Slower, and uses more of your Claude plan.",
  },
] as const;

export const CLAUDE_TEXT_EFFORTS = [
  {
    id: "low",
    label: "Low",
    description: "Recommended. About a minute for the largest request.",
  },
  {
    id: "medium",
    label: "Medium",
    description: "More careful reasoning. Slower.",
  },
  {
    id: "high",
    label: "High",
    description: "Slowest. Can take several minutes.",
  },
] as const;

export type ClaudeTextModel = (typeof CLAUDE_TEXT_MODELS)[number]["id"];
export type ClaudeTextEffort = (typeof CLAUDE_TEXT_EFFORTS)[number]["id"];

export const DEFAULT_CLAUDE_TEXT_MODEL: ClaudeTextModel = "sonnet";
export const DEFAULT_CLAUDE_TEXT_EFFORT: ClaudeTextEffort = "low";

export function isClaudeTextModel(value: string): value is ClaudeTextModel {
  return CLAUDE_TEXT_MODELS.some((model) => model.id === value);
}

export function isClaudeTextEffort(value: string): value is ClaudeTextEffort {
  return CLAUDE_TEXT_EFFORTS.some((effort) => effort.id === value);
}

export function resolveClaudeTextModel(env: NodeJS.ProcessEnv = process.env): ClaudeTextModel {
  const value = env.CLAUDE_TEXT_MODEL?.trim() ?? "";
  return isClaudeTextModel(value) ? value : DEFAULT_CLAUDE_TEXT_MODEL;
}

export function resolveClaudeTextEffort(env: NodeJS.ProcessEnv = process.env): ClaudeTextEffort {
  const value = env.CLAUDE_TEXT_EFFORT?.trim() ?? "";
  return isClaudeTextEffort(value) ? value : DEFAULT_CLAUDE_TEXT_EFFORT;
}

export const HIGGSFIELD_IMAGE_MODELS = [
  {
    id: "gpt_image_2_5",
    label: "GPT Image 2.5",
    description: "Recommended. Strong text rendering and reference-image editing.",
    tierParam: "quality",
    tiers: ["low", "medium", "high"],
    defaultTier: "medium",
    mediaRole: "image_references",
  },
  {
    id: "gpt_image_2",
    label: "GPT Image 2",
    description: "Previous OpenAI image model with the same quality tiers.",
    tierParam: "quality",
    tiers: ["low", "medium", "high"],
    defaultTier: "medium",
    mediaRole: "image",
  },
  {
    id: "seedream_v5_pro",
    label: "Seedream 5.0 Pro",
    description: "Bytedance model with resolution tiers up to 2K.",
    tierParam: "resolution",
    tiers: ["1k", "1.5k", "2k"],
    defaultTier: "2k",
    mediaRole: "image_references",
  },
] as const;

export type HiggsfieldImageModel = (typeof HIGGSFIELD_IMAGE_MODELS)[number];
export type HiggsfieldImageModelId = HiggsfieldImageModel["id"];

export const DEFAULT_HIGGSFIELD_IMAGE_MODEL: HiggsfieldImageModelId = "gpt_image_2_5";

export function isHiggsfieldImageModel(value: string): value is HiggsfieldImageModelId {
  return HIGGSFIELD_IMAGE_MODELS.some((model) => model.id === value);
}

export function getHiggsfieldImageModel(id: string): HiggsfieldImageModel | undefined {
  return HIGGSFIELD_IMAGE_MODELS.find((model) => model.id === id);
}

export function isHiggsfieldImageTier(modelId: string, tier: string): boolean {
  const model = getHiggsfieldImageModel(modelId);
  return Boolean(model && (model.tiers as readonly string[]).includes(tier));
}

export function resolveHiggsfieldImageModel(env: NodeJS.ProcessEnv = process.env): HiggsfieldImageModel {
  return getHiggsfieldImageModel(env.HIGGSFIELD_IMAGE_MODEL?.trim() ?? "")
    ?? getHiggsfieldImageModel(DEFAULT_HIGGSFIELD_IMAGE_MODEL)!;
}

export function resolveHiggsfieldImageTier(env: NodeJS.ProcessEnv = process.env): string {
  const model = resolveHiggsfieldImageModel(env);
  const value = env.HIGGSFIELD_IMAGE_QUALITY?.trim() ?? "";
  return isHiggsfieldImageTier(model.id, value) ? value : model.defaultTier;
}
