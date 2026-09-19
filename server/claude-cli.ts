import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ProviderErrorCategory } from "@shared/schema";
import { ProviderError } from "./provider-errors";
import {
  resolveClaudeTextEffort,
  resolveClaudeTextModel,
  type ClaudeTextEffort,
  type ClaudeTextModel,
} from "./provider-models";

export const HIGGSFIELD_MCP_NAME = "higgsfield";
export const HIGGSFIELD_MCP_URL = "https://mcp.higgsfield.ai/mcp";
export const TEXT_TIMEOUT_MS = 180_000;
export const MCP_RUN_TIMEOUT_MS = 300_000;
export const QUEUE_WAIT_MS = 30_000;
const KILL_GRACE_MS = 5_000;
const STATUS_TTL_MS = 30_000;
const STATUS_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_CONCURRENCY = 3;
const JSON_SYSTEM_PROMPT = "You are a JSON-only API. Follow the user's instructions exactly.";
const TEXT_SYSTEM_PROMPT = "You are a precise writing assistant. Follow the user's instructions exactly.";

// ---------------------------------------------------------------------------
// Failures
// ---------------------------------------------------------------------------

const FAILURES = {
  CLAUDE_NOT_INSTALLED: {
    category: "missing_key",
    status: 503,
    retryable: false,
    publicMessage: "Claude Code is not installed on this machine.",
    suggestion: "Install Claude Code, or set CLAUDE_BIN in .env to the claude executable path, then try again.",
  },
  CLAUDE_NOT_SIGNED_IN: {
    category: "invalid_key",
    status: 401,
    retryable: false,
    publicMessage: "Claude Code is not signed in.",
    suggestion: "Run `claude` in a terminal and sign in with /login, then try again.",
  },
  CLAUDE_USAGE_LIMIT: {
    category: "quota",
    status: 429,
    retryable: true,
    publicMessage: "Your Claude usage limit has been reached.",
    suggestion: "Wait for your Claude usage window to reset, then retry.",
  },
  CLAUDE_BUSY: {
    category: "quota",
    status: 429,
    retryable: true,
    publicMessage: "Too many Claude requests are running at once.",
    suggestion: "Wait a moment and retry.",
  },
  CLAUDE_TIMEOUT: {
    category: "timeout",
    status: 504,
    retryable: true,
    publicMessage: "Claude took too long to respond.",
    suggestion: "Retry. If it keeps timing out, lower the effort in Settings.",
  },
  CLAUDE_FAILED: {
    category: "provider_server",
    status: 502,
    retryable: true,
    publicMessage: "Claude Code returned an error.",
    suggestion: "Retry once. If it continues, run `claude` in a terminal to check that it works.",
  },
} as const satisfies Record<string, {
  category: ProviderErrorCategory;
  status: number;
  retryable: boolean;
  publicMessage: string;
  suggestion: string;
}>;

export type ClaudeFailureCode = keyof typeof FAILURES;

export function claudeFailure(code: ClaudeFailureCode, cause?: unknown): ProviderError {
  const failure = FAILURES[code];
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
// Environment, arguments, output handling
// ---------------------------------------------------------------------------

const SCRUBBED_ENV_KEYS = [
  "ANTHROPIC_API_KEY",
  "CLAUDE_EFFORT",
  "CLAUDECODE",
  "CLAUDE_PID",
  "CLAUDE_CODE_ENTRYPOINT",
  "CLAUDE_CODE_EXECPATH",
  "CLAUDE_CODE_SESSION_ID",
  "CLAUDE_CODE_SESSION_ATTENDED",
  "CLAUDE_CODE_CHILD_SESSION",
  "CLAUDE_CODE_MESSAGING_SOCKET",
  "CLAUDE_CODE_MESSAGING_TOKEN",
] as const;

/** Copy of `base` without variables that would leak a parent Claude Code session or switch billing to an API key. */
export function buildChildEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env = { ...base };
  for (const key of SCRUBBED_ENV_KEYS) delete env[key];
  return env;
}

export function claudeBin(env: NodeJS.ProcessEnv = process.env): string {
  return env.CLAUDE_BIN?.trim() || "claude";
}

export function buildTextArgs(input: { model: ClaudeTextModel; effort: ClaudeTextEffort; json: boolean }): string[] {
  return [
    "-p",
    "--model", input.model,
    "--effort", input.effort,
    "--output-format", "json",
    "--tools", "",
    "--setting-sources", "",
    "--disable-slash-commands",
    "--strict-mcp-config",
    "--no-session-persistence",
    "--system-prompt", input.json ? JSON_SYSTEM_PROMPT : TEXT_SYSTEM_PROMPT,
  ];
}

export function buildMcpArgs(input: {
  model: string;
  effort?: string;
  allowedTools: readonly string[];
  maxTurns: number;
  resume?: string;
}): string[] {
  const args = [
    "-p",
    "--model", input.model,
    ...(input.effort ? ["--effort", input.effort] : []),
    "--output-format", "json",
    "--max-turns", String(input.maxTurns),
    "--mcp-config", JSON.stringify({ mcpServers: { [HIGGSFIELD_MCP_NAME]: { type: "http", url: HIGGSFIELD_MCP_URL } } }),
    "--strict-mcp-config",
    "--allowedTools", input.allowedTools.join(","),
    "--permission-mode", "dontAsk",
    "--tools", "",
    "--setting-sources", "",
    "--disable-slash-commands",
    "--system-prompt", JSON_SYSTEM_PROMPT,
  ];
  if (input.resume) args.push("--resume", input.resume);
  return args;
}

/** Removes one wrapping markdown fence from a JSON reply. Anything else (prose, trailing text) is left for the strict parsers to reject. */
export function stripJsonFence(text: string): string {
  const trimmed = text.trim();
  // The closing fence may sit on its own line or directly after the JSON, but nothing may follow it.
  const match = /^```(?:json)?[ \t]*\r?\n([\s\S]*?)(?:\r?\n)?```$/i.exec(trimmed);
  return match ? match[1].trim() : trimmed;
}

export interface CliEnvelope {
  type?: string;
  subtype?: string;
  is_error?: boolean;
  result?: unknown;
  session_id?: string;
  api_error_status?: number | null;
  terminal_reason?: string;
}

/** The `claude -p --output-format json` result envelope: the last stdout line that parses as `{"type":"result",...}`. */
export function parseCliOutput(stdout: string): CliEnvelope | null {
  const lines = stdout.trim().split(/\r?\n/);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index].trim();
    if (!line.startsWith("{")) continue;
    try {
      const parsed = JSON.parse(line);
      if (parsed && typeof parsed === "object" && parsed.type === "result") return parsed as CliEnvelope;
    } catch {
      // keep scanning earlier lines
    }
  }
  return null;
}

const AUTH_PATTERN = /please run \/login|not authenticated|not logged in|authentication_error|invalid api key|oauth token has expired/i;
const LIMIT_PATTERN = /spend limit|usage limit|rate limit|quota|credit balance|too many requests|overloaded/i;

export function isOutOfTurns(envelope: CliEnvelope | null): boolean {
  return envelope?.subtype === "error_max_turns" || envelope?.terminal_reason === "max_turns";
}

/** Returns the ProviderError for a failed run, or null when the envelope reports success. Out-of-turns is handled by callers first. */
export function classifyFailure(envelope: CliEnvelope | null, exitCode: number | null): ProviderError | null {
  if (!envelope) return claudeFailure("CLAUDE_FAILED");
  if (!envelope.is_error && exitCode === 0) return null;

  const text = typeof envelope.result === "string" ? envelope.result : "";
  const status = envelope.api_error_status ?? null;
  if (status === 401 || AUTH_PATTERN.test(text)) return claudeFailure("CLAUDE_NOT_SIGNED_IN");
  if (status === 429 || status === 529 || LIMIT_PATTERN.test(text)) return claudeFailure("CLAUDE_USAGE_LIMIT");
  return claudeFailure("CLAUDE_FAILED");
}

// ---------------------------------------------------------------------------
// Process execution
// ---------------------------------------------------------------------------

let isolatedCwd: string | null = null;

/** An unpredictable, owner-only empty directory, so no project files or CLAUDE.md are ever discovered. */
function getIsolatedCwd(): string {
  if (!isolatedCwd) {
    const dir = mkdtempSync(path.join(os.tmpdir(), "youtubepro-claude-"));
    process.once("exit", () => rmSync(dir, { recursive: true, force: true }));
    isolatedCwd = dir;
  }
  return isolatedCwd;
}

interface ExecResult {
  stdout: string;
  code: number | null;
}

function execClaude(args: string[], stdin: string | null, timeoutMs: number): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(claudeBin(), args, {
      cwd: getIsolatedCwd(),
      env: buildChildEnv(),
      stdio: [stdin === null ? "ignore" : "pipe", "pipe", "ignore"],
    });
    let stdout = "";
    let settled = false;
    let timedOut = false;
    let killTimer: NodeJS.Timeout | undefined;

    const finish = (action: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(killTimer);
      action();
    };

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      killTimer = setTimeout(() => child.kill("SIGKILL"), KILL_GRACE_MS);
    }, timeoutMs);

    child.stdout!.on("data", (chunk) => { stdout += chunk; });
    child.on("error", (error: NodeJS.ErrnoException) => {
      finish(() => reject(claudeFailure(error.code === "ENOENT" ? "CLAUDE_NOT_INSTALLED" : "CLAUDE_FAILED", error)));
    });
    child.on("close", (code) => {
      finish(() => (timedOut ? reject(claudeFailure("CLAUDE_TIMEOUT")) : resolve({ stdout, code })));
    });

    if (stdin !== null) {
      child.stdin!.on("error", () => { /* the child exited before reading; the close handler reports it */ });
      child.stdin!.end(stdin);
    }
  });
}

// ---------------------------------------------------------------------------
// Concurrency
// ---------------------------------------------------------------------------

export function maxConcurrency(env: NodeJS.ProcessEnv = process.env): number {
  const parsed = Number.parseInt(env.CLAUDE_MAX_CONCURRENCY ?? "", 10);
  return Number.isInteger(parsed) && parsed >= 1 && parsed <= 16 ? parsed : DEFAULT_MAX_CONCURRENCY;
}

/** FIFO limiter. `acquire` rejects with CLAUDE_BUSY when no slot frees up within `waitMs`. */
export class ConcurrencyGate {
  private active = 0;
  private queue: Array<{ grant: () => void; timer: NodeJS.Timeout }> = [];

  constructor(private readonly limit: () => number) {}

  acquire(waitMs: number): Promise<() => void> {
    return new Promise((resolve, reject) => {
      // A second release must be a no-op: decrementing twice would over-admit past the cap.
      let released = false;
      const release = () => {
        if (released) return;
        released = true;
        this.active -= 1;
        this.drain();
      };
      if (this.active < this.limit()) {
        this.active += 1;
        resolve(release);
        return;
      }
      const entry = {
        grant: () => {
          clearTimeout(entry.timer);
          this.active += 1;
          resolve(release);
        },
        timer: setTimeout(() => {
          this.queue = this.queue.filter((queued) => queued !== entry);
          reject(claudeFailure("CLAUDE_BUSY"));
        }, waitMs),
      };
      this.queue.push(entry);
    });
  }

  private drain(): void {
    while (this.queue.length > 0 && this.active < this.limit()) {
      this.queue.shift()!.grant();
    }
  }
}

const gate = new ConcurrencyGate(() => maxConcurrency());

async function runGated(args: string[], prompt: string, timeoutMs: number): Promise<ExecResult> {
  const release = await gate.acquire(QUEUE_WAIT_MS);
  try {
    return await execClaude(args, prompt, timeoutMs);
  } finally {
    release();
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface ClaudeTextOptions {
  json: boolean;
  model?: ClaudeTextModel;
  effort?: ClaudeTextEffort;
  timeoutMs?: number;
}

/** One isolated, tool-less `claude -p` call. With `json: true` a wrapping markdown fence is removed from the reply. */
export async function claudeText(prompt: string, options: ClaudeTextOptions): Promise<string> {
  const args = buildTextArgs({
    model: options.model ?? resolveClaudeTextModel(),
    effort: options.effort ?? resolveClaudeTextEffort(),
    json: options.json,
  });
  const { stdout, code } = await runGated(args, prompt, options.timeoutMs ?? TEXT_TIMEOUT_MS);
  const envelope = parseCliOutput(stdout);
  const failure = classifyFailure(envelope, code);
  if (failure) throw failure;
  const result = typeof envelope?.result === "string" ? envelope.result : "";
  return options.json ? stripJsonFence(result) : result;
}

export interface McpRunOptions {
  prompt: string;
  allowedTools: readonly string[];
  model?: string;
  effort?: string | null;
  maxTurns?: number;
  resume?: string;
  timeoutMs?: number;
}

export interface McpRunResult {
  result: string;
  sessionId?: string;
  outOfTurns: boolean;
}

/** One `claude -p` session that can reach only the Higgsfield MCP server, restricted to `allowedTools`. */
export async function runClaudeMcp(options: McpRunOptions): Promise<McpRunResult> {
  const args = buildMcpArgs({
    model: options.model ?? "sonnet",
    effort: options.effort === null ? undefined : options.effort ?? "low",
    allowedTools: options.allowedTools,
    maxTurns: options.maxTurns ?? 12,
    resume: options.resume,
  });
  const { stdout, code } = await runGated(args, options.prompt, options.timeoutMs ?? MCP_RUN_TIMEOUT_MS);
  const envelope = parseCliOutput(stdout);
  if (isOutOfTurns(envelope)) {
    return { result: "", sessionId: envelope?.session_id, outOfTurns: true };
  }
  const failure = classifyFailure(envelope, code);
  if (failure) throw failure;
  return {
    result: typeof envelope?.result === "string" ? envelope.result : "",
    sessionId: envelope?.session_id,
    outOfTurns: false,
  };
}

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

export interface ClaudeStatus {
  installed: boolean;
  signedIn: boolean;
  authMethod?: string;
  version?: string;
}

let statusCache: { at: number; value: ClaudeStatus } | null = null;

export function resetClaudeStatusCache(): void {
  statusCache = null;
}

/** `claude --version` plus `claude auth status`: no model call. Cached for about 30 seconds. */
export async function getClaudeStatus(now: number = Date.now()): Promise<ClaudeStatus> {
  if (statusCache && now - statusCache.at < STATUS_TTL_MS) return statusCache.value;

  let value: ClaudeStatus;
  try {
    const versionRun = await execClaude(["--version"], null, STATUS_TIMEOUT_MS);
    const version = versionRun.stdout.trim().split(/\s+/)[0] || undefined;
    let signedIn = false;
    let authMethod: string | undefined;
    try {
      const authRun = await execClaude(["auth", "status"], null, STATUS_TIMEOUT_MS);
      const parsed = JSON.parse(authRun.stdout.trim());
      signedIn = parsed?.loggedIn === true;
      authMethod = typeof parsed?.authMethod === "string" ? parsed.authMethod : undefined;
    } catch {
      signedIn = false;
    }
    value = { installed: true, signedIn, authMethod, version };
  } catch {
    value = { installed: false, signedIn: false };
  }

  statusCache = { at: now, value };
  return value;
}
