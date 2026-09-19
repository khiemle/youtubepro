import type { Express, NextFunction, Request, Response } from "express";
import { createServer, type Server } from "http";
import { searchVideos } from "./youtube";
import { generateScript, generateIdeas, generateResearchInsights, regenerateTitles, regenerateSection, regenerateParagraph, generateThumbnailSuggestions, extractNarrationText } from "./ai";
import { generateThumbnail, testHiggsfieldConnection } from "./higgsfield-image";
import { ideaGenerationRequestSchema, researchInsightsRequestSchema, searchFiltersSchema, scriptInputSchema } from "@shared/schema";
import { z } from "zod";
import { apiKeySettingsSchema, getApiKeyStatus, isLocalSettingsRequest, saveApiKeySettings } from "./settings";
import { logProviderFailure, normalizeProviderError, providerErrorPayload } from "./provider-errors";
import { thumbnailGenerationRequestSchema, thumbnailSuggestionsRequestSchema } from "./thumbnail-contract";
import {
  paragraphRegenerationRequestSchema,
  sectionRegenerationRequestSchema,
} from "./script-regeneration-contract";
import {
  narrationExtractionRequestSchema,
  titleRegenerationRequestSchema,
} from "./api-contracts";
import { createRateLimiter } from "./rate-limit";

const { middleware: rateLimit } = createRateLimiter();

/**
 * Refuses a non-local settings request before the rate limiter runs, so forwarded requests cannot
 * consume the shared per-minute budget of the AI routes.
 */
function requireLocalSettingsRequest(req: Request, res: Response, next: NextFunction) {
  res.setHeader("Cache-Control", "no-store");
  if (!isLocalSettingsRequest(req)) {
    return res.status(403).json({ error: "Settings are available only from this machine." });
  }
  return next();
}

export async function registerRoutes(
  httpServer: Server,
  app: Express
): Promise<Server> {
  app.get("/api/settings/status", async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    if (!isLocalSettingsRequest(req)) {
      return res.status(403).json({ error: "Settings are available only from this machine." });
    }
    return res.json(await getApiKeyStatus());
  });

  app.put("/api/settings/api-keys", async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    if (!isLocalSettingsRequest(req)) {
      return res.status(403).json({ error: "Settings are available only from this machine." });
    }

    try {
      const input = apiKeySettingsSchema.parse(req.body);
      const status = await saveApiKeySettings(input);
      return res.json({ success: true, status });
    } catch (error: any) {
      return res.status(400).json({
        error: error?.message || "Unable to save API settings.",
      });
    }
  });

  app.post("/api/settings/test-higgsfield", requireLocalSettingsRequest, rateLimit, async (req, res) => {
    try {
      return res.json(await testHiggsfieldConnection());
    } catch (error: unknown) {
      const providerError = normalizeProviderError(error, "higgsfield");
      return res.status(providerError.status).json(providerErrorPayload(providerError, "Higgsfield connection test"));
    }
  });

  app.get("/api/youtube/search", rateLimit, async (req, res) => {
    try {
      const { query, uploadDate, duration, sortBy, maxResults } = req.query;

      if (!query || typeof query !== "string") {
        return res.status(400).json({ error: "Query parameter is required" });
      }

      const filters = searchFiltersSchema.parse({
        query,
        uploadDate: uploadDate || "any",
        duration: duration || "any",
        sortBy: sortBy || "relevance",
        maxResults: maxResults ? parseInt(maxResults as string, 10) : 25,
      });

      const result = await searchVideos(filters);
      res.json(result);
    } catch (error: any) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({ error: "Invalid search parameters", details: error.errors });
      }
      const providerError = normalizeProviderError(error, "youtube");
      logProviderFailure("YouTube search", providerError);
      res.status(providerError.status).json(providerErrorPayload(providerError, "YouTube Data API"));
    }
  });

  app.post("/api/script/generate", rateLimit, async (req, res) => {
    try {
      const input = scriptInputSchema.parse(req.body);
      const result = await generateScript(input);
      res.json(result);
    } catch (error: any) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({ error: "Invalid script input", details: error.errors });
      }
      const providerError = normalizeProviderError(error, "ai");
      logProviderFailure("Script generation", providerError);
      res.status(providerError.status).json(providerErrorPayload(providerError, "Script generation"));
    }
  });

  app.post("/api/script/extract-narration", rateLimit, async (req, res) => {
    try {
      const { scriptContent } = narrationExtractionRequestSchema.parse(req.body);
      const narration = await extractNarrationText(scriptContent);
      res.json({ narration });
    } catch (error: any) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({ error: "Invalid narration extraction request", details: error.errors });
      }
      const providerError = normalizeProviderError(error, "ai");
      logProviderFailure("Narration extraction", providerError);
      res.status(providerError.status).json(providerErrorPayload(providerError, "Narration extraction"));
    }
  });

  app.post("/api/ideas/generate", rateLimit, async (req, res) => {
    try {
      const parsed = ideaGenerationRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: "Invalid grounded idea request", details: parsed.error.errors });
      }

      const result = await generateIdeas(parsed.data);
      res.json(result);
    } catch (error: unknown) {
      const providerError = normalizeProviderError(error, "ai");
      logProviderFailure("Ideas generation", providerError);
      res.status(providerError.status).json(providerErrorPayload(providerError, "Ideas generation"));
    }
  });

  app.post("/api/research/insights", rateLimit, async (req, res) => {
    try {
      const parsed = researchInsightsRequestSchema.safeParse(req.body);

      if (!parsed.success) {
        return res.status(400).json({
          error: "A query and between 1 and 50 valid videos are required.",
          code: "RESEARCH_REQUEST_INVALID",
          details: parsed.error.errors,
        });
      }

      const result = await generateResearchInsights(parsed.data);
      res.json(result);
    } catch (error: unknown) {
      const providerError = normalizeProviderError(error, "ai");
      logProviderFailure("Research insights", providerError);
      res.status(providerError.status).json(providerErrorPayload(providerError, "Research insights"));
    }
  });

  app.post("/api/script/regenerate-titles", rateLimit, async (req, res) => {
    try {
      const { topic, format, audience, evidenceContext } = titleRegenerationRequestSchema.parse(req.body);
      const titles = await regenerateTitles(
        topic,
        format,
        audience,
        evidenceContext,
      );
      res.json({ titles });
    } catch (error: any) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({ error: "Invalid title regeneration request", details: error.errors });
      }
      const providerError = normalizeProviderError(error, "ai");
      logProviderFailure("Title regeneration", providerError);
      res.status(providerError.status).json(providerErrorPayload(providerError, "Title regeneration"));
    }
  });

  app.post("/api/script/regenerate-section", rateLimit, async (req, res) => {
    try {
      const parsed = sectionRegenerationRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({
          error: "Invalid section regeneration request",
          code: "SCRIPT_SECTION_REGENERATION_REQUEST_INVALID",
          category: "invalid_response",
          retryable: false,
          suggestion: "Keep the current section and review its topic, format, audience, and evidence context.",
          details: parsed.error.flatten(),
        });
      }

      const result = await regenerateSection(parsed.data);
      res.json(result);
    } catch (error: unknown) {
      const providerError = normalizeProviderError(error, "ai");
      logProviderFailure("Section regeneration", providerError);
      res.status(providerError.status).json(providerErrorPayload(providerError, "Section regeneration"));
    }
  });

  app.post("/api/script/regenerate-paragraph", rateLimit, async (req, res) => {
    try {
      const parsed = paragraphRegenerationRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({
          error: "Invalid paragraph regeneration request",
          code: "SCRIPT_PARAGRAPH_REGENERATION_REQUEST_INVALID",
          category: "invalid_response",
          retryable: false,
          suggestion: "Keep the current paragraph and review its section, topic, format, audience, and evidence context.",
          details: parsed.error.flatten(),
        });
      }

      const result = await regenerateParagraph(parsed.data);
      res.json(result);
    } catch (error: unknown) {
      const providerError = normalizeProviderError(error, "ai");
      logProviderFailure("Paragraph regeneration", providerError);
      res.status(providerError.status).json(providerErrorPayload(providerError, "Paragraph regeneration"));
    }
  });

  app.post("/api/thumbnail/generate", rateLimit, async (req, res) => {
    try {
      const parsed = thumbnailGenerationRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({
          error: "Invalid thumbnail generation request",
          code: "THUMBNAIL_REQUEST_INVALID",
          category: "invalid_response",
          retryable: false,
          suggestion: "Review the thumbnail fields and reference image requirements, then try again.",
          details: parsed.error.flatten(),
        });
      }

      const { topic, ...config } = parsed.data;
      const result = await generateThumbnail(topic, config);
      res.json(result);
    } catch (error: unknown) {
      const providerError = normalizeProviderError(error, "higgsfield");
      logProviderFailure("Thumbnail generation", providerError);
      res.status(providerError.status).json(providerErrorPayload(providerError, "Thumbnail generation"));
    }
  });

  app.post("/api/thumbnail/suggestions", rateLimit, async (req, res) => {
    try {
      const parsed = thumbnailSuggestionsRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({
          error: "Invalid thumbnail suggestions request",
          code: "THUMBNAIL_SUGGESTIONS_REQUEST_INVALID",
          category: "invalid_response",
          retryable: false,
          suggestion: "Add a valid topic and shorten any supplied idea context.",
          details: parsed.error.flatten(),
        });
      }

      const suggestions = await generateThumbnailSuggestions(parsed.data);
      res.json({ suggestions });
    } catch (error: unknown) {
      const providerError = normalizeProviderError(error, "ai");
      logProviderFailure("Thumbnail suggestions", providerError);
      res.status(providerError.status).json(providerErrorPayload(providerError, "Thumbnail suggestions"));
    }
  });

  return httpServer;
}
