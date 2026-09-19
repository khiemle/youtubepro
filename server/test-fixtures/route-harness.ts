import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { resetClaudeStatusCache } from "../claude-cli";
import { resetHiggsfieldConnectionState } from "../higgsfield-image";
import { registerRoutes } from "../routes";

export const FAKE_CLAUDE = fileURLToPath(new URL("./fake-claude.mjs", import.meta.url));
chmodSync(FAKE_CLAUDE, 0o755);

const ENV_KEYS = [
  "CLAUDE_BIN", "FAKE_CLAUDE_MODE", "FAKE_CLAUDE_LOG", "FAKE_CLAUDE_RESULTS", "FAKE_CLAUDE_RESULT",
  "CLAUDE_TEXT_MODEL", "CLAUDE_TEXT_EFFORT", "HIGGSFIELD_IMAGE_MODEL", "HIGGSFIELD_IMAGE_QUALITY",
] as const;

export interface RouteHarness {
  base: string;
  post(route: string, body: unknown, headers?: Record<string, string>): Promise<Response>;
  stop(): Promise<void>;
}

/** The real Express routes on a loopback port, with `claude` replaced by the fake CLI. Restores the environment on stop. */
export async function startRouteHarness(): Promise<RouteHarness> {
  const saved = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  for (const key of ENV_KEYS) delete process.env[key];
  const tmp = mkdtempSync(path.join(os.tmpdir(), "route-harness-"));
  process.env.CLAUDE_BIN = FAKE_CLAUDE;
  process.env.FAKE_CLAUDE_LOG = path.join(tmp, "calls.jsonl");
  resetClaudeStatusCache();
  resetHiggsfieldConnectionState();

  const app = express();
  app.use(express.json());
  const server: Server = createServer(app);
  await registerRoutes(server, app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  return {
    base,
    post: (route, body, headers = {}) => fetch(`${base}${route}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    }),
    stop: async () => {
      for (const key of ENV_KEYS) {
        if (saved[key] === undefined) delete process.env[key];
        else process.env[key] = saved[key];
      }
      await new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      });
      rmSync(tmp, { recursive: true, force: true });
    },
  };
}
