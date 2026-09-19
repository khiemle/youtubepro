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
