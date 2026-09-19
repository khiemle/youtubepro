# Claude CLI and Higgsfield Provider Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the Gemini API with the operator's local Claude Code sign-in: text generation through `claude -p`, thumbnail images through Higgsfield's MCP server driven by a locked-down `claude -p` session, with reference-image uploads kept.

**Architecture:** One module (`server/claude-cli.ts`) is the only place that spawns `claude`, with an isolated tool-less text profile and a Higgsfield-only MCP profile. `server/ai.ts` keeps every prompt builder, parser and repair loop and calls `claudeText()`. `server/higgsfield-image.ts` keeps `generateThumbnail()`'s signature and `data:` URL result, using a guarded media download/upload (`server/media-guard.ts`). Error categories and the response shape the client reads are unchanged; only `code` and `suggestion` vary.

**Tech Stack:** TypeScript (Node 22.12+), Express 5, Zod 3, `node:test` via `tsx`, React 18 + Vite, the `claude` CLI (verified on 2.1.278).

**Spec:** `docs/superpowers/specs/2026-09-19-claude-cli-provider-design.md`. Read it first; this plan implements it.

## Global Constraints

- Node.js `>=22.12.0` (`package.json` engines); CI also runs Node 24.
- Work on the local branch `claude-cli-provider`. Never push. End every commit message with the attribution trailers your session instructs.
- `npm test`, `npm run check` and `npm run build` must pass at the end of every task. `npm test` must never make a live provider call: it uses the fake CLI at `server/test-fixtures/fake-claude.mjs`.
- `tsconfig.json` has no `downlevelIteration`: in `server/`, `client/` and `shared/` non-test code, never `for...of` an iterator (`Map`/`Set` entries, `.entries()`), and never spread a typed array. Use `Array.from(...)` or index loops. (Test files are not type-checked and may use them.)
- The prompt goes to `claude` on **stdin**, never argv. The child environment drops `ANTHROPIC_API_KEY`, `CLAUDE_EFFORT`, `CLAUDECODE`, `CLAUDE_PID` and the parent-session variables listed in `SCRUBBED_ENV_KEYS`; other variables (including any `CLAUDE_CODE_OAUTH_TOKEN`) pass through.
- Text defaults: model `sonnet`, effort `low`. Timeouts: text 180 s, each MCP run 300 s (SIGTERM, then SIGKILL after 5 s). Concurrency: `CLAUDE_MAX_CONCURRENCY`, default 3, FIFO, a request waits at most 30 s, then `CLAUDE_BUSY`.
- Higgsfield runs always pass `"use_unlim": false`. Result and upload URLs are untrusted: `https:` only, allowlisted hostname, no IP literals, no private resolution, downloads capped at 25 MB with a PNG/JPEG/WebP magic-byte check, 3 in-request download attempts.
- Logs carry error codes only: never prompts, envelopes, messages, or response bodies (`logProviderFailure`).
- Error categories stay the existing 8 and the payload stays `{error, code, category, retryable, suggestion}`.
- After Task 7, no `Gemini`/`genai` string may remain in `server/`, `client/` or `shared/` except the four intentional regression assertions listed in the Task 8 gate.
- Do not edit `docs/launch-video/*` or `docs/YOUTUBE_RESEARCH_PLAYBOOK.md` (upstream material).

## Plan notes (read before starting)

These differ from, or add to, the spec. Each is deliberate.

1. **Task order.** The spec rolls out "text swap, then Higgsfield". This plan builds the Higgsfield module first (Tasks 4-5), then switches Settings once (Task 6), then swaps text and thumbnails (Task 7). Reason: `settings.ts` would otherwise be rewritten twice with a throwaway "Gemini image only" state in between. It also lets **Live check #2** (the riskiest unknown: reference-image upload) run in Task 5, before the large switch-over.
2. **Repair loops stay.** `generateScript`, `generateIdeas`, `regenerateTitles` and script regeneration already retry once at the application level when validation fails. Each attempt is now a fresh `claudeText()` call. The spec's "no automatic re-ask" refers to the transport adapter, which adds none.
3. **Legacy routes.** `script/generate`, `script/extract-narration` and `script/regenerate-titles` used a separate error path (always HTTP 500, generic "contact support" copy, no `code`). They now use `providerErrorPayload` like the other routes, so `CLAUDE_NOT_SIGNED_IN` guidance reaches the Script page. `getUserFriendlyError` is deleted.
4. **Error flattening.** Four operations in `ai.ts` caught errors and rethrew `new Error(error.message)`, which would erase the new codes. They now rethrow `ProviderError` unchanged.
5. **`ProviderError.publicMessage`** is added next to the spec's `suggestion`, because the per-category `error` copy ("rejected the configured API key") is wrong for Claude.
6. **Client error text.** `apiRequest` throws `Error("<status>: <json body>")`. A small pure helper, `shared/api-error-message.ts`, reads the server's `suggestion` so the Script page and Settings show it (substring guessing would show "malformed revision" for `invalid_key`).
7. **Settings.** `planSettingsUpdate` is a pure function so the merge/validation rules are testable without touching `.env`. `getApiKeyStatus` becomes async (it reads `claude` status).
8. **Media role per model.** `gpt_image_2` takes media role `image`; the other two table entries take `image_references`. The table carries `mediaRole`.
9. **Denylist deferred.** Allowlisting does not hide the ~51.6k tokens of Higgsfield tool schemas per MCP session. The spec's optional denylist is not implemented here; revisit only if live check #2 shows the overhead matters.

## File structure

| File | Task | Responsibility |
|---|---|---|
| `server/gemini*.ts`, `server/gemini-*.test.ts` | 1 | Renamed to `ai.ts`, `provider-models.ts`, `ai-*.test.ts`; `GEMINI_*` error codes become `AI_*`. |
| `server/provider-errors.ts` | 2 | `ProviderError` gains `publicMessage`/`suggestion`; contexts `youtube \| ai \| claude \| higgsfield`; `logProviderFailure`. |
| `server/claude-cli.ts` | 3 | The only `claude` spawner: profiles, env scrub, gate, timeouts, envelope parsing, classification, status. |
| `server/test-fixtures/fake-claude.mjs` | 3 | Test double for the `claude` CLI. |
| `server/provider-models.ts` | 3, 5, 7 | Claude tables (3), Higgsfield table (5), Gemini tables removed (7). |
| `server/media-guard.ts` | 4 | URL policy, guarded fetch, capped download, magic-byte sniff, guarded upload. |
| `server/higgsfield-image.ts` | 5 | Structured replies, briefs, `generateThumbnail`, `testHiggsfieldConnection`, connection state. |
| `script/live-claude-check.ts` | 5 | Opt-in live acceptance (not in `npm test`). |
| `server/settings.ts`, `server/routes.ts` | 6, 7 | Settings contract and status; test-connection route; text/thumbnail switch-over. |
| `shared/api-error-message.ts` | 6 | Reads `suggestion` out of an `apiRequest` error. |
| `client/src/pages/settings.tsx` | 6 | Claude row, Higgsfield row with Test connection. |
| `server/ai.ts`, client copy | 7 | Text through `claudeText`; provider-neutral wording. |
| `package.json`, lockfile, `.env.example`, docs | 5, 8 | Script, dependency removal, documentation. |

## Working files outside the repo

Several steps run one-off edit scripts. Create a scratch directory once and keep every script there (never commit them):

```bash
export PLAN_TMP="$(mktemp -d)"
echo "$PLAN_TMP"
```

Save this helper as `$PLAN_TMP/apply-edits.mjs`. It applies `[old, new]` edits and fails unless each `old` occurs **exactly once**, which is what makes the later scripts safe:

````js
// Applies [old, new] edits to a file and fails loudly unless every `old` occurs exactly once.
import { readFileSync, writeFileSync } from "node:fs";

export function applyEdits(file, edits) {
  let text = readFileSync(file, "utf8");
  edits.forEach(([oldText, newText], index) => {
    const count = text.split(oldText).length - 1;
    if (count !== 1) throw new Error(`${file}: edit #${index + 1} matched ${count} times:\n${oldText.slice(0, 200)}`);
    text = text.replace(oldText, () => newText);
  });
  writeFileSync(file, text);
  console.log(`${file}: ${edits.length} edits applied`);
}
````

---

### Task 1: Rename the Gemini modules and error codes to neutral names

A pure refactor: the existing 62 tests are the safety net. The app is still Gemini-backed afterwards.

**Files:**
- Rename: `server/gemini.ts` -> `server/ai.ts`; `server/gemini-models.ts` -> `server/provider-models.ts`
- Rename: `server/gemini-evidence.test.ts`, `server/gemini-research.test.ts`, `server/gemini-thumbnail.test.ts` -> `server/ai-evidence.test.ts`, `server/ai-research.test.ts`, `server/ai-thumbnail.test.ts`
- Modify: every `server/*.ts` that imports them; `README.md`, `PORTING.md`, `HANDOFF.md` (file paths only)

**Interfaces:**
- Produces: modules `./ai` and `./provider-models` (same exports as before); error codes `AI_MISSING_KEY`, `AI_RESEARCH_*`, `AI_THUMBNAIL_SUGGESTIONS_INVALID`, `AI_SCRIPT_REGENERATION_INVALID`, `AI_IMAGE_INVALID_RESPONSE`; `ProviderErrorContext` becomes `"youtube" | "ai"`.

- [ ] **Step 1: Confirm the baseline**

Run: `git status --short && npm test 2>&1 | grep -E "ℹ (tests|pass|fail)" && npm run check`
Expected: clean tree on `claude-cli-provider`; `ℹ tests 62`, `ℹ pass 62`, `ℹ fail 0`; `tsc` prints no errors.

- [ ] **Step 2: Rename and rewrite references**

```bash
git mv server/gemini.ts server/ai.ts
git mv server/gemini-models.ts server/provider-models.ts
git mv server/gemini-evidence.test.ts server/ai-evidence.test.ts
git mv server/gemini-research.test.ts server/ai-research.test.ts
git mv server/gemini-thumbnail.test.ts server/ai-thumbnail.test.ts
perl -pi -e 's#from "\./gemini"#from "./ai"#g; s#from "\./gemini-models"#from "./provider-models"#g' server/*.ts
perl -pi -e 's/GEMINI_(MISSING_KEY|RESEARCH_[A-Z_]+|THUMBNAIL_SUGGESTIONS_INVALID|SCRIPT_REGENERATION_INVALID|IMAGE_INVALID_RESPONSE)/AI_$1/g' server/*.ts
perl -pi -e 's/normalizeProviderError\(error, "gemini"\)/normalizeProviderError(error, "ai")/g' server/*.ts
perl -pi -e 's/type ProviderErrorContext = "youtube" \| "gemini";/type ProviderErrorContext = "youtube" | "ai";/' server/provider-errors.ts
perl -pi -e 's#server/gemini-models\.ts#server/provider-models.ts#g; s#server/gemini\.ts#server/ai.ts#g' README.md PORTING.md HANDOFF.md
```

Do not rename `GEMINI_API_KEY`, `GEMINI_TEXT_MODEL`, `GEMINI_IMAGE_MODEL`, `GEMINI_TEXT_MODELS`, `GEMINI_IMAGE_MODELS` or the `geminiApiKey` variables: those still do real work until Task 7.

- [ ] **Step 3: Verify nothing still points at the old names**

Run: `grep -rn -E 'from "\./gemini|"gemini"\)|"GEMINI_(MISSING|RESEARCH|THUMBNAIL|SCRIPT|IMAGE_INVALID)|server/gemini' server client shared README.md PORTING.md HANDOFF.md`
Expected: no output.

Run: `npm test 2>&1 | grep -E "ℹ (tests|pass|fail)" && npm run check`
Expected: `ℹ tests 62`, `ℹ pass 62`, `ℹ fail 0`; no `tsc` errors.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "Rename Gemini modules and error codes to neutral names"
```

---

### Task 2: ProviderError carries its own copy, and logs are code-only

**Files:**
- Modify: `server/provider-errors.ts`
- Create: `server/provider-errors.test.ts`

**Interfaces:**
- Consumes: `ProviderErrorCategory`, `ProviderErrorResponse` from `@shared/schema`.
- Produces: `ProviderError` with optional `publicMessage` and `suggestion`; `normalizeProviderError(error, context)` where context is `"youtube" | "ai" | "claude" | "higgsfield"`; `providerErrorPayload(error, contextLabel)` preferring the error's own copy; `logProviderFailure(scope: string, error: unknown): void`.

- [ ] **Step 1: Write the failing test**

Create `server/provider-errors.test.ts`:

````ts
import assert from "node:assert/strict";
import { describe, mock, test } from "node:test";
import { ProviderError, logProviderFailure, normalizeProviderError, providerErrorPayload } from "./provider-errors";

describe("providerErrorPayload", () => {
  test("uses the per-category copy when the error carries none", () => {
    const error = normalizeProviderError(new Error("Request timed out"), "ai");
    assert.deepEqual(providerErrorPayload(error, "Ideas generation"), {
      error: "Ideas generation timed out",
      suggestion: "Check the connection and retry. Repeated timeouts may indicate a provider incident.",
      code: "AI_TIMEOUT",
      category: "timeout",
      retryable: true,
    });
  });

  test("prefers the error's own public message and suggestion", () => {
    const error = new ProviderError({
      message: "internal detail that must not reach the client",
      category: "invalid_key",
      code: "CLAUDE_NOT_SIGNED_IN",
      status: 401,
      retryable: false,
      publicMessage: "Claude Code is not signed in.",
      suggestion: "Run `claude` and sign in with /login.",
    });
    assert.deepEqual(providerErrorPayload(error, "Research insights"), {
      error: "Claude Code is not signed in.",
      suggestion: "Run `claude` and sign in with /login.",
      code: "CLAUDE_NOT_SIGNED_IN",
      category: "invalid_key",
      retryable: false,
    });
  });

  test("names claude and higgsfield contexts in generated codes", () => {
    assert.equal(normalizeProviderError(new Error("fetch failed"), "claude").code, "CLAUDE_NETWORK");
    assert.equal(normalizeProviderError(new Error("fetch failed"), "higgsfield").code, "HIGGSFIELD_NETWORK");
  });
});

describe("logProviderFailure", () => {
  test("logs the code only, never the message or cause", () => {
    const spy = mock.method(console, "error", () => {});
    try {
      logProviderFailure("Ideas generation", new ProviderError({
        message: "prompt text and secrets",
        category: "unknown",
        code: "CLAUDE_FAILED",
        status: 502,
        retryable: true,
        cause: new Error("more secrets"),
      }));
      logProviderFailure("Ideas generation", new Error("also secret"));
      logProviderFailure("Ideas generation", "a string");
      assert.deepEqual(spy.mock.calls.map((call) => call.arguments), [
        ["Ideas generation failed:", "CLAUDE_FAILED"],
        ["Ideas generation failed:", "Error"],
        ["Ideas generation failed:", "UnknownError"],
      ]);
    } finally {
      spy.mock.restore();
    }
  });
});
````

- [ ] **Step 2: Run it and watch it fail**

Run: `npx tsx --test server/provider-errors.test.ts`
Expected: FAIL: `logProviderFailure` is not exported from `./provider-errors`.

- [ ] **Step 3: Replace the implementation**

Replace the whole of `server/provider-errors.ts`:

````ts
import type { ProviderErrorCategory, ProviderErrorResponse } from "@shared/schema";

export class ProviderError extends Error {
  readonly category: ProviderErrorCategory;
  readonly code: string;
  readonly status: number;
  readonly retryable: boolean;
  readonly publicMessage?: string;
  readonly suggestion?: string;

  constructor(options: {
    message: string;
    category: ProviderErrorCategory;
    code: string;
    status: number;
    retryable: boolean;
    publicMessage?: string;
    suggestion?: string;
    cause?: unknown;
  }) {
    super(options.message, { cause: options.cause });
    this.name = "ProviderError";
    this.category = options.category;
    this.code = options.code;
    this.status = options.status;
    this.retryable = options.retryable;
    this.publicMessage = options.publicMessage;
    this.suggestion = options.suggestion;
  }
}

type ProviderErrorContext = "youtube" | "ai" | "claude" | "higgsfield";

function categoryFromMessage(message: string): ProviderErrorCategory {
  const normalized = message.toLowerCase();
  if (normalized.includes("not configured") || normalized.includes("missing api key")) return "missing_key";
  if (
    normalized.includes("api key not valid")
    || normalized.includes("keyinvalid")
    || normalized.includes("invalid api key")
    || normalized.includes("api_key_invalid")
    || normalized.includes("permission_denied")
    || normalized.includes("authentication")
    || normalized.includes("unauthorized")
  ) return "invalid_key";
  if (
    normalized.includes("quota")
    || normalized.includes("ratelimit")
    || normalized.includes("rate limit")
    || normalized.includes("too many requests")
    || normalized.includes("daily limit")
    || normalized.includes("resource_exhausted")
  ) return "quota";
  if (normalized.includes("timeout") || normalized.includes("timed out") || normalized.includes("abort")) return "timeout";
  if (normalized.includes("network") || normalized.includes("fetch failed") || normalized.includes("econn")) return "network";
  if (normalized.includes("invalid response") || normalized.includes("malformed") || normalized.includes("schema")) return "invalid_response";
  return "unknown";
}

function defaultsForCategory(category: ProviderErrorCategory): Pick<ProviderError, "status" | "retryable"> {
  switch (category) {
    case "missing_key": return { status: 503, retryable: false };
    case "invalid_key": return { status: 401, retryable: false };
    case "quota": return { status: 429, retryable: true };
    case "timeout": return { status: 504, retryable: true };
    case "network":
    case "provider_server": return { status: 502, retryable: true };
    case "invalid_response": return { status: 502, retryable: false };
    default: return { status: 500, retryable: true };
  }
}

export function normalizeProviderError(error: unknown, context: ProviderErrorContext): ProviderError {
  if (error instanceof ProviderError) return error;

  const message = error instanceof Error ? error.message : String(error || "Unknown provider error");
  const category = categoryFromMessage(message);
  const defaults = defaultsForCategory(category);

  return new ProviderError({
    message,
    code: `${context.toUpperCase()}_${category.toUpperCase()}`,
    category,
    ...defaults,
    cause: error,
  });
}

export function providerErrorPayload(error: ProviderError, contextLabel: string): ProviderErrorResponse {
  const copy: Record<ProviderErrorCategory, { error: string; suggestion: string }> = {
    missing_key: {
      error: `${contextLabel} is not configured`,
      suggestion: "Add the provider API key in Settings, then try again.",
    },
    invalid_key: {
      error: `${contextLabel} rejected the configured API key`,
      suggestion: "Replace the API key in Settings and verify its provider restrictions.",
    },
    quota: {
      error: `${contextLabel} quota is unavailable`,
      suggestion: "Wait for quota to reset or review the provider quota before retrying.",
    },
    timeout: {
      error: `${contextLabel} timed out`,
      suggestion: "Check the connection and retry. Repeated timeouts may indicate a provider incident.",
    },
    network: {
      error: `${contextLabel} could not be reached`,
      suggestion: "Check the server network connection and retry.",
    },
    provider_server: {
      error: `${contextLabel} returned a server error`,
      suggestion: "Retry after a short delay. If it continues, check the provider status page.",
    },
    invalid_response: {
      error: `${contextLabel} returned an invalid response`,
      suggestion: "Retry once. If it continues, choose another supported model or report the response contract failure.",
    },
    unknown: {
      error: `${contextLabel} encountered an issue`,
      suggestion: "Retry once. If it continues, inspect the server logs for the provider error code.",
    },
  };

  return {
    error: error.publicMessage ?? copy[error.category].error,
    suggestion: error.suggestion ?? copy[error.category].suggestion,
    code: error.code,
    category: error.category,
    retryable: error.retryable,
  };
}

/** Logs a provider failure by code only: never the message, cause, prompt, or response body. */
export function logProviderFailure(scope: string, error: unknown): void {
  const label = error instanceof ProviderError ? error.code : error instanceof Error ? error.name : "UnknownError";
  console.error(`${scope} failed:`, label);
}
````

- [ ] **Step 4: Run it and watch it pass**

Run: `npx tsx --test server/provider-errors.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 5: Gate and commit**

Run: `npm test 2>&1 | grep -E "ℹ (tests|pass|fail)" && npm run check`
Expected: `ℹ tests 66`, `ℹ pass 66`, `ℹ fail 0`; no `tsc` errors.

```bash
git add server/provider-errors.ts server/provider-errors.test.ts
git commit -m "Let ProviderError carry its own message and guidance, and log codes only"
```

---

### Task 3: The `claude` adapter for text, tested through a fake CLI

**Files:**
- Create: `server/claude-cli.ts`, `server/test-fixtures/fake-claude.mjs`, `server/claude-cli.test.ts`, `server/provider-models.test.ts`
- Modify: `server/provider-models.ts` (append the Claude section)

**Interfaces:**
- Consumes: `ProviderError` (Task 2).
- Produces (from `server/claude-cli.ts`): `claudeText(prompt: string, options: { json: boolean; model?: ClaudeTextModel; effort?: ClaudeTextEffort; timeoutMs?: number }): Promise<string>`; `runClaudeMcp(options: McpRunOptions): Promise<McpRunResult>` with `McpRunOptions = { prompt; allowedTools: readonly string[]; model?: string; effort?: string | null; maxTurns?: number; resume?: string; timeoutMs?: number }` and `McpRunResult = { result: string; sessionId?: string; outOfTurns: boolean }`; `getClaudeStatus(now?: number): Promise<{ installed: boolean; signedIn: boolean; authMethod?: string; version?: string }>`; `resetClaudeStatusCache()`; `HIGGSFIELD_MCP_NAME = "higgsfield"`; plus the pure helpers `buildTextArgs`, `buildMcpArgs`, `buildChildEnv`, `stripJsonFence`, `parseCliOutput`, `classifyFailure`, `isOutOfTurns`, `ConcurrencyGate`, `claudeFailure`.
- Produces (from `provider-models.ts`): `CLAUDE_TEXT_MODELS`, `CLAUDE_TEXT_EFFORTS`, `ClaudeTextModel`, `ClaudeTextEffort`, `isClaudeTextModel`, `isClaudeTextEffort`, `resolveClaudeTextModel(env?)`, `resolveClaudeTextEffort(env?)`.
- Failure codes thrown: `CLAUDE_NOT_INSTALLED` (503), `CLAUDE_NOT_SIGNED_IN` (401), `CLAUDE_USAGE_LIMIT` (429), `CLAUDE_BUSY` (429), `CLAUDE_TIMEOUT` (504), `CLAUDE_FAILED` (502).

- [ ] **Step 1: Write the fake CLI and the failing tests**

Create `server/test-fixtures/fake-claude.mjs`, then make it executable (tests spawn it directly):

````js
#!/usr/bin/env node
// Test double for the `claude` CLI. Selected in tests with CLAUDE_BIN=<this file>.
//
// Every call appends one JSON line to FAKE_CLAUDE_LOG (when set):
//   { argv, stdin, env: {ANTHROPIC_API_KEY, CLAUDE_EFFORT, CLAUDECODE, KEEP_ME}, startedAt, endedAt }
// Behaviour is chosen with FAKE_CLAUDE_MODE:
//   ok        envelope whose result is FAKE_CLAUDE_RESULT (default "ok")
//   results   envelope whose result is FAKE_CLAUDE_RESULTS[callIndex] (JSON array; needs FAKE_CLAUDE_LOG)
//   auth      exit 1, is_error envelope, api_error_status 401
//   limit     exit 1, is_error envelope, api_error_status 429
//   failed    exit 1, is_error envelope, generic text
//   garbage   exit 0, stdout is not JSON
//   max_turns exit 1, envelope subtype error_max_turns with session_id "sess-1"
//   hang      writes its pid to FAKE_CLAUDE_PID_FILE and never exits
// FAKE_CLAUDE_DELAY_MS delays any mode before it answers.
// `--version` and `auth status` are answered directly (FAKE_CLAUDE_AUTH_JSON overrides the auth JSON).
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";

const argv = process.argv.slice(2);
const mode = process.env.FAKE_CLAUDE_MODE || "ok";
const logPath = process.env.FAKE_CLAUDE_LOG;

if (argv[0] === "--version") {
  console.log("2.1.278 (Claude Code)");
  process.exit(0);
}
if (argv[0] === "auth" && argv[1] === "status") {
  console.log(process.env.FAKE_CLAUDE_AUTH_JSON || '{"loggedIn":true,"authMethod":"claude.ai"}');
  process.exit(0);
}

let stdin = "";
try {
  stdin = readFileSync(0, "utf8");
} catch {
  stdin = "";
}

const startedAt = Date.now();
const priorCalls = logPath && existsSync(logPath)
  ? readFileSync(logPath, "utf8").split("\n").filter(Boolean).length
  : 0;

function record() {
  if (!logPath) return;
  appendFileSync(logPath, `${JSON.stringify({
    argv,
    stdin,
    env: {
      ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY ?? null,
      CLAUDE_EFFORT: process.env.CLAUDE_EFFORT ?? null,
      CLAUDECODE: process.env.CLAUDECODE ?? null,
      KEEP_ME: process.env.KEEP_ME ?? null,
    },
    startedAt,
    endedAt: Date.now(),
  })}\n`);
}

function envelope(overrides) {
  return JSON.stringify({
    type: "result",
    subtype: "success",
    is_error: false,
    result: "ok",
    session_id: "fake-session",
    num_turns: 1,
    ...overrides,
  });
}

function answer(code, body) {
  record();
  process.stdout.write(`${body}\n`, () => process.exit(code));
}

async function main() {
  const delay = Number(process.env.FAKE_CLAUDE_DELAY_MS || 0);
  if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));

  switch (mode) {
    case "results": {
      const results = JSON.parse(process.env.FAKE_CLAUDE_RESULTS || "[]");
      return answer(0, envelope({ result: results[priorCalls] ?? "" }));
    }
    case "auth":
      return answer(1, envelope({ is_error: true, api_error_status: 401, result: "Please run /login" }));
    case "limit":
      return answer(1, envelope({ is_error: true, api_error_status: 429, result: "You've hit your usage limit" }));
    case "failed":
      return answer(1, envelope({ is_error: true, result: "Something went wrong" }));
    case "garbage":
      return answer(0, "this is not json");
    case "max_turns":
      return answer(1, envelope({ subtype: "error_max_turns", is_error: true, session_id: "sess-1", result: "" }));
    case "hang":
      if (process.env.FAKE_CLAUDE_PID_FILE) writeFileSync(process.env.FAKE_CLAUDE_PID_FILE, String(process.pid));
      record();
      setInterval(() => {}, 1000);
      return undefined;
    default:
      return answer(0, envelope({ result: process.env.FAKE_CLAUDE_RESULT ?? "ok" }));
  }
}

main();
````

```bash
chmod +x server/test-fixtures/fake-claude.mjs
```

Create `server/provider-models.test.ts` (Higgsfield cases are added in Task 5):

````ts
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { resolveClaudeTextEffort, resolveClaudeTextModel } from "./provider-models";

describe("Claude text settings", () => {
  test("default to sonnet at low effort and ignore unknown values", () => {
    assert.equal(resolveClaudeTextModel({}), "sonnet");
    assert.equal(resolveClaudeTextEffort({}), "low");
    assert.equal(resolveClaudeTextModel({ CLAUDE_TEXT_MODEL: "gemini-3.7-flash" }), "sonnet");
    assert.equal(resolveClaudeTextEffort({ CLAUDE_TEXT_EFFORT: "xhigh" }), "low");
  });

  test("accept the allowlisted values", () => {
    assert.equal(resolveClaudeTextModel({ CLAUDE_TEXT_MODEL: " opus " }), "opus");
    assert.equal(resolveClaudeTextEffort({ CLAUDE_TEXT_EFFORT: "high" }), "high");
  });
});
````

Create `server/claude-cli.test.ts`:

````ts
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  HIGGSFIELD_MCP_URL,
  buildChildEnv,
  buildMcpArgs,
  buildTextArgs,
  claudeText,
  classifyFailure,
  ConcurrencyGate,
  getClaudeStatus,
  parseCliOutput,
  resetClaudeStatusCache,
  runClaudeMcp,
  stripJsonFence,
} from "./claude-cli";
import { ProviderError } from "./provider-errors";

const FAKE = fileURLToPath(new URL("./test-fixtures/fake-claude.mjs", import.meta.url));
chmodSync(FAKE, 0o755);

const TOUCHED_ENV = [
  "CLAUDE_BIN", "CLAUDE_TEXT_MODEL", "CLAUDE_TEXT_EFFORT", "CLAUDE_MAX_CONCURRENCY",
  "ANTHROPIC_API_KEY", "CLAUDE_EFFORT", "CLAUDECODE", "KEEP_ME",
  "FAKE_CLAUDE_MODE", "FAKE_CLAUDE_LOG", "FAKE_CLAUDE_RESULT", "FAKE_CLAUDE_RESULTS",
  "FAKE_CLAUDE_DELAY_MS", "FAKE_CLAUDE_PID_FILE", "FAKE_CLAUDE_AUTH_JSON",
] as const;

let savedEnv: Record<string, string | undefined>;
let tmp: string;

beforeEach(() => {
  savedEnv = Object.fromEntries(TOUCHED_ENV.map((key) => [key, process.env[key]]));
  for (const key of TOUCHED_ENV) delete process.env[key];
  tmp = mkdtempSync(path.join(os.tmpdir(), "claude-cli-test-"));
  process.env.CLAUDE_BIN = FAKE;
  process.env.FAKE_CLAUDE_LOG = path.join(tmp, "calls.jsonl");
  resetClaudeStatusCache();
});

afterEach(() => {
  for (const key of TOUCHED_ENV) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  rmSync(tmp, { recursive: true, force: true });
});

interface LoggedCall {
  argv: string[];
  stdin: string;
  env: Record<string, string | null>;
  startedAt: number;
  endedAt: number;
}

function loggedCalls(): LoggedCall[] {
  const file = process.env.FAKE_CLAUDE_LOG!;
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
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

describe("stripJsonFence", () => {
  test("leaves raw JSON alone and trims whitespace", () => {
    assert.equal(stripJsonFence('  {"a":1}\n'), '{"a":1}');
  });

  test("removes a ```json fence", () => {
    assert.equal(stripJsonFence('```json\n{"a":1}\n```'), '{"a":1}');
  });

  test("removes a bare ``` fence", () => {
    assert.equal(stripJsonFence('```\n["x"]\n```'), '["x"]');
  });

  test("does not rescue prose around JSON, so the strict parsers still reject it", () => {
    assert.equal(stripJsonFence('```json\n{"a":1}\n```\nHope that helps!'), '```json\n{"a":1}\n```\nHope that helps!');
    assert.equal(stripJsonFence('Here you go: {"a":1}'), 'Here you go: {"a":1}');
  });
});

describe("parseCliOutput", () => {
  const line = JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "hi", session_id: "s" });

  test("reads the single-line envelope", () => {
    assert.equal(parseCliOutput(`${line}\n`)?.result, "hi");
  });

  test("ignores a warning line printed after the envelope", () => {
    assert.equal(parseCliOutput(`${line}\nupdate available: 9.9.9\n`)?.session_id, "s");
  });

  test("returns null when there is no result envelope", () => {
    assert.equal(parseCliOutput("not json"), null);
    assert.equal(parseCliOutput('{"type":"system"}'), null);
  });
});

describe("classifyFailure", () => {
  const ok = { type: "result", subtype: "success", is_error: false, result: "fine" };

  test("returns null for a successful envelope", () => {
    assert.equal(classifyFailure(ok, 0), null);
  });

  test("maps 401 and login prompts to CLAUDE_NOT_SIGNED_IN", () => {
    const byStatus = classifyFailure({ ...ok, is_error: true, api_error_status: 401, result: "x" }, 1)!;
    assert.equal(byStatus.code, "CLAUDE_NOT_SIGNED_IN");
    assert.equal(byStatus.category, "invalid_key");
    assert.equal(byStatus.status, 401);
    assert.equal(byStatus.retryable, false);
    assert.equal(classifyFailure({ ...ok, is_error: true, result: "Please run /login" }, 1)!.code, "CLAUDE_NOT_SIGNED_IN");
  });

  test("maps 429, 529 and limit text to CLAUDE_USAGE_LIMIT", () => {
    const limited = classifyFailure({ ...ok, is_error: true, api_error_status: 429, result: "x" }, 1)!;
    assert.equal(limited.code, "CLAUDE_USAGE_LIMIT");
    assert.equal(limited.category, "quota");
    assert.equal(limited.retryable, true);
    assert.equal(classifyFailure({ ...ok, is_error: true, api_error_status: 529, result: "x" }, 1)!.code, "CLAUDE_USAGE_LIMIT");
    assert.equal(
      classifyFailure({ ...ok, is_error: true, result: "You've hit your monthly spend limit" }, 1)!.code,
      "CLAUDE_USAGE_LIMIT",
    );
  });

  test("maps everything else to CLAUDE_FAILED", () => {
    assert.equal(classifyFailure({ ...ok, is_error: true, result: "boom" }, 1)!.code, "CLAUDE_FAILED");
    assert.equal(classifyFailure(ok, 1)!.code, "CLAUDE_FAILED");
    assert.equal(classifyFailure(null, 0)!.code, "CLAUDE_FAILED");
  });
});

describe("argument builders", () => {
  test("text profile is fully isolated and always passes model and effort", () => {
    assert.deepEqual(buildTextArgs({ model: "sonnet", effort: "low", json: true }), [
      "-p", "--model", "sonnet", "--effort", "low", "--output-format", "json",
      "--tools", "", "--setting-sources", "", "--disable-slash-commands", "--strict-mcp-config",
      "--no-session-persistence", "--system-prompt", "You are a JSON-only API. Follow the user's instructions exactly.",
    ]);
  });

  test("plain-text calls get a non-JSON system prompt", () => {
    const args = buildTextArgs({ model: "opus", effort: "high", json: false });
    assert.match(args[args.indexOf("--system-prompt") + 1], /precise writing assistant/);
  });

  test("MCP profile exposes only the Higgsfield server and the run's allowed tools", () => {
    const args = buildMcpArgs({ model: "sonnet", effort: "low", allowedTools: ["mcp__higgsfield__jobs_wait", "mcp__higgsfield__media_confirm"], maxTurns: 12 });
    assert.deepEqual(JSON.parse(args[args.indexOf("--mcp-config") + 1]), {
      mcpServers: { higgsfield: { type: "http", url: HIGGSFIELD_MCP_URL } },
    });
    assert.ok(args.includes("--strict-mcp-config"));
    assert.equal(args[args.indexOf("--allowedTools") + 1], "mcp__higgsfield__jobs_wait,mcp__higgsfield__media_confirm");
    assert.equal(args[args.indexOf("--permission-mode") + 1], "dontAsk");
    assert.equal(args[args.indexOf("--max-turns") + 1], "12");
    assert.equal(args[args.indexOf("--tools") + 1], "");
    assert.equal(args.includes("--no-session-persistence"), false);
    assert.equal(args.includes("--resume"), false);
  });

  test("MCP profile can resume a session and can omit effort", () => {
    const args = buildMcpArgs({ model: "haiku", allowedTools: ["mcp__higgsfield__balance"], maxTurns: 4, resume: "sess-9" });
    assert.equal(args[args.indexOf("--resume") + 1], "sess-9");
    assert.equal(args.includes("--effort"), false);
  });
});

describe("buildChildEnv", () => {
  test("drops billing and parent-session variables and keeps everything else", () => {
    const env = buildChildEnv({
      ANTHROPIC_API_KEY: "secret",
      CLAUDE_EFFORT: "xhigh",
      CLAUDECODE: "1",
      CLAUDE_CODE_SESSION_ID: "abc",
      CLAUDE_CODE_MESSAGING_TOKEN: "tok",
      CLAUDE_CODE_OAUTH_TOKEN: "keep-me",
      PATH: "/usr/bin",
    });
    assert.deepEqual(env, { CLAUDE_CODE_OAUTH_TOKEN: "keep-me", PATH: "/usr/bin" });
  });
});

describe("ConcurrencyGate", () => {
  test("queues in FIFO order and rejects with CLAUDE_BUSY after the wait", async () => {
    const gate = new ConcurrencyGate(() => 1);
    const releaseFirst = await gate.acquire(1_000);
    const order: string[] = [];
    const second = gate.acquire(1_000).then((release) => { order.push("second"); return release; });
    const third = gate.acquire(1_000).then((release) => { order.push("third"); return release; });
    releaseFirst();
    (await second)();
    (await third)();
    assert.deepEqual(order, ["second", "third"]);

    const held = await gate.acquire(1_000);
    const busy = await rejection(gate.acquire(30));
    assert.equal(busy.code, "CLAUDE_BUSY");
    assert.equal(busy.status, 429);
    held();
  });
});

describe("claudeText through the fake CLI", () => {
  test("returns the result, sends the prompt on stdin and never in argv", async () => {
    process.env.FAKE_CLAUDE_RESULT = "hello";
    const text = await claudeText("secret prompt text", { json: false });
    assert.equal(text, "hello");
    const [call] = loggedCalls();
    assert.equal(call.stdin, "secret prompt text");
    assert.equal(call.argv.some((arg) => arg.includes("secret prompt text")), false);
  });

  test("uses the configured model and effort, and explicit options override them", async () => {
    process.env.CLAUDE_TEXT_MODEL = "opus";
    process.env.CLAUDE_TEXT_EFFORT = "medium";
    await claudeText("a", { json: true });
    await claudeText("b", { json: true, model: "sonnet", effort: "high" });
    const [first, second] = loggedCalls();
    assert.deepEqual([first.argv[2], first.argv[4]], ["opus", "medium"]);
    assert.deepEqual([second.argv[2], second.argv[4]], ["sonnet", "high"]);
  });

  test("falls back to sonnet at low effort when the environment holds unknown values", async () => {
    process.env.CLAUDE_TEXT_MODEL = "not-a-model";
    process.env.CLAUDE_TEXT_EFFORT = "xhigh";
    await claudeText("a", { json: true });
    const [call] = loggedCalls();
    assert.deepEqual([call.argv[2], call.argv[4]], ["sonnet", "low"]);
  });

  test("strips a JSON fence only when json is true", async () => {
    process.env.FAKE_CLAUDE_RESULT = '```json\n{"a":1}\n```';
    assert.equal(await claudeText("p", { json: true }), '{"a":1}');
    assert.equal(await claudeText("p", { json: false }), '```json\n{"a":1}\n```');
  });

  test("scrubs the child environment but keeps unrelated variables", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-secret";
    process.env.CLAUDE_EFFORT = "xhigh";
    process.env.CLAUDECODE = "1";
    process.env.KEEP_ME = "yes";
    await claudeText("p", { json: false });
    const [call] = loggedCalls();
    assert.deepEqual(call.env, { ANTHROPIC_API_KEY: null, CLAUDE_EFFORT: null, CLAUDECODE: null, KEEP_ME: "yes" });
  });

  test("maps CLI failures to provider errors", async () => {
    process.env.FAKE_CLAUDE_MODE = "auth";
    assert.equal((await rejection(claudeText("p", { json: false }))).code, "CLAUDE_NOT_SIGNED_IN");
    process.env.FAKE_CLAUDE_MODE = "limit";
    assert.equal((await rejection(claudeText("p", { json: false }))).code, "CLAUDE_USAGE_LIMIT");
    process.env.FAKE_CLAUDE_MODE = "failed";
    assert.equal((await rejection(claudeText("p", { json: false }))).code, "CLAUDE_FAILED");
    process.env.FAKE_CLAUDE_MODE = "garbage";
    assert.equal((await rejection(claudeText("p", { json: false }))).code, "CLAUDE_FAILED");
  });

  test("reports a missing executable as CLAUDE_NOT_INSTALLED", async () => {
    process.env.CLAUDE_BIN = path.join(tmp, "does-not-exist");
    const error = await rejection(claudeText("p", { json: false }));
    assert.equal(error.code, "CLAUDE_NOT_INSTALLED");
    assert.equal(error.category, "missing_key");
  });

  test("kills a hung process and reports CLAUDE_TIMEOUT", async () => {
    process.env.FAKE_CLAUDE_MODE = "hang";
    process.env.FAKE_CLAUDE_PID_FILE = path.join(tmp, "pid");
    const error = await rejection(claudeText("p", { json: false, timeoutMs: 300 }));
    assert.equal(error.code, "CLAUDE_TIMEOUT");
    assert.equal(error.status, 504);
    const pid = Number(readFileSync(process.env.FAKE_CLAUDE_PID_FILE, "utf8"));
    assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
  });

  test("never runs more children at once than CLAUDE_MAX_CONCURRENCY", async () => {
    process.env.CLAUDE_MAX_CONCURRENCY = "2";
    process.env.FAKE_CLAUDE_DELAY_MS = "250";
    await Promise.all(Array.from({ length: 4 }, (_, index) => claudeText(`p${index}`, { json: false })));
    const calls = loggedCalls();
    assert.equal(calls.length, 4);
    const points = calls.flatMap((call) => [[call.startedAt, 1], [call.endedAt, -1]] as const)
      .sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    let active = 0;
    let peak = 0;
    for (const [, delta] of points) {
      active += delta;
      peak = Math.max(peak, active);
    }
    assert.ok(peak <= 2, `peak concurrency was ${peak}`);
  });
});

describe("runClaudeMcp through the fake CLI", () => {
  test("returns the reply and session id and passes the run's tools", async () => {
    process.env.FAKE_CLAUDE_RESULT = '{"status":"ok"}';
    const run = await runClaudeMcp({ prompt: "go", allowedTools: ["mcp__higgsfield__balance"], model: "haiku", effort: null, maxTurns: 4 });
    assert.deepEqual(run, { result: '{"status":"ok"}', sessionId: "fake-session", outOfTurns: false });
    const [call] = loggedCalls();
    assert.equal(call.stdin, "go");
    assert.equal(call.argv[call.argv.indexOf("--allowedTools") + 1], "mcp__higgsfield__balance");
    assert.equal(call.argv.includes("--effort"), false);
  });

  test("reports running out of turns instead of failing, with the session to resume", async () => {
    process.env.FAKE_CLAUDE_MODE = "max_turns";
    const run = await runClaudeMcp({ prompt: "go", allowedTools: ["mcp__higgsfield__jobs_wait"] });
    assert.deepEqual(run, { result: "", sessionId: "sess-1", outOfTurns: true });
  });

  test("maps failures like the text profile does", async () => {
    process.env.FAKE_CLAUDE_MODE = "auth";
    assert.equal((await rejection(runClaudeMcp({ prompt: "go", allowedTools: [] }))).code, "CLAUDE_NOT_SIGNED_IN");
  });
});

describe("getClaudeStatus", () => {
  test("reports version and sign-in state without a model call", async () => {
    assert.deepEqual(await getClaudeStatus(0), { installed: true, signedIn: true, authMethod: "claude.ai", version: "2.1.278" });
    assert.equal(loggedCalls().length, 0);
  });

  test("reports signed-out and not-installed states", async () => {
    process.env.FAKE_CLAUDE_AUTH_JSON = '{"loggedIn":false}';
    assert.equal((await getClaudeStatus(0)).signedIn, false);
    resetClaudeStatusCache();
    process.env.CLAUDE_BIN = path.join(tmp, "does-not-exist");
    assert.deepEqual(await getClaudeStatus(0), { installed: false, signedIn: false });
  });

  test("caches for about 30 seconds", async () => {
    assert.equal((await getClaudeStatus(0)).signedIn, true);
    process.env.FAKE_CLAUDE_AUTH_JSON = '{"loggedIn":false}';
    assert.equal((await getClaudeStatus(1_000)).signedIn, true);
    assert.equal((await getClaudeStatus(31_000)).signedIn, false);
  });
});
````

- [ ] **Step 2: Run them and watch them fail**

Run: `npx tsx --test server/claude-cli.test.ts server/provider-models.test.ts`
Expected: FAIL: `resolveClaudeTextModel` is not exported by `./provider-models`, and `./claude-cli` cannot be found.

- [ ] **Step 3: Implement**

Append this to the **end** of `server/provider-models.ts`. Keep the existing Gemini code above it; it is removed in Task 7.

````ts
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
````

Create `server/claude-cli.ts`:

````ts
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
  const match = /^```(?:json)?[ \t]*\r?\n([\s\S]*?)\r?\n```$/i.exec(trimmed);
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
      const release = () => {
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
````

- [ ] **Step 4: Run them and watch them pass**

Run: `npx tsx --test server/claude-cli.test.ts server/provider-models.test.ts`
Expected: PASS, 34 tests (the process-based tests take about 2 seconds).

- [ ] **Step 5: Gate and commit**

Run: `npm test 2>&1 | grep -E "ℹ (tests|pass|fail)" && npm run check`
Expected: `ℹ tests 100`, `ℹ pass 100`, `ℹ fail 0`; no `tsc` errors.

```bash
git add server/claude-cli.ts server/claude-cli.test.ts server/provider-models.ts server/provider-models.test.ts server/test-fixtures/fake-claude.mjs
git commit -m "Add the claude CLI adapter for text generation, tested through a fake CLI"
```

---

### Task 4: Media guard for Higgsfield URLs, downloads and uploads

**Files:**
- Create: `server/media-guard.ts`, `server/media-guard.test.ts`

**Interfaces:**
- Consumes: `ProviderError` (Task 2).
- Produces: `HIGGSFIELD_MEDIA_HOST_SUFFIXES` (initially `[".higgsfield.ai"]`); `MediaUrlPolicy = { protocols; hostSuffixes; resolve }`; `MediaDeps = { fetchImpl: typeof fetch; policy: MediaUrlPolicy; sleep(ms): Promise<void>; maxBytes: number }`; `defaultMediaDeps`; `assertSafeMediaUrl(raw, policy?): Promise<URL>`; `isPrivateAddress(address): boolean`; `sniffImageMime(bytes): "image/png" | "image/jpeg" | "image/webp" | null`; `downloadImage(rawUrl, deps?): Promise<{ bytes: Buffer; mimeType }>`; `uploadBytes(rawUrl, bytes, contentType, deps?): Promise<void>`. Failure codes: `HIGGSFIELD_BAD_MEDIA` (502, not retryable), `HIGGSFIELD_DOWNLOAD_FAILED` and `HIGGSFIELD_UPLOAD_FAILED` (502, retryable).

- [ ] **Step 1: Write the failing test**

Create `server/media-guard.test.ts` (it talks to real local HTTP servers on `localhost`, using a test policy that keeps every other rule):

````ts
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, test } from "node:test";
import {
  DEFAULT_MEDIA_POLICY,
  assertSafeMediaUrl,
  downloadImage,
  isPrivateAddress,
  sniffImageMime,
  uploadBytes,
  type MediaDeps,
  type MediaUrlPolicy,
} from "./media-guard";
import { ProviderError } from "./provider-errors";

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
const PUBLIC_IP = "93.184.216.34";

/** Lets tests talk to a local http server while keeping every other rule of the real policy. */
const LOCAL_POLICY: MediaUrlPolicy = { protocols: ["http:"], hostSuffixes: ["localhost"], resolve: async () => [PUBLIC_IP] };

const servers: http.Server[] = [];

async function startServer(handler: http.RequestListener): Promise<string> {
  const server = http.createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "localhost", resolve));
  return `http://localhost:${(server.address() as AddressInfo).port}`;
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => {
    server.closeAllConnections();
    server.close(() => resolve());
  })));
});

function deps(overrides: Partial<MediaDeps> = {}): MediaDeps & { sleeps: number[] } {
  const sleeps: number[] = [];
  return {
    fetchImpl: (input, init) => fetch(input, init),
    policy: LOCAL_POLICY,
    sleep: async (ms) => { sleeps.push(ms); },
    maxBytes: 1024,
    ...overrides,
    sleeps,
  };
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

describe("isPrivateAddress", () => {
  test("flags loopback, private, link-local and unusable addresses", () => {
    for (const address of ["127.0.0.1", "10.1.2.3", "172.16.0.1", "172.31.255.255", "192.168.1.1", "169.254.1.1", "0.0.0.0", "100.64.0.1", "::1", "::", "fe80::1", "fd00::1", "::ffff:10.0.0.1", "not-an-ip"]) {
      assert.equal(isPrivateAddress(address), true, address);
    }
  });

  test("allows public addresses", () => {
    for (const address of ["8.8.8.8", "93.184.216.34", "172.32.0.1", "2606:4700:4700::1111"]) {
      assert.equal(isPrivateAddress(address), false, address);
    }
  });
});

describe("assertSafeMediaUrl with the default policy", () => {
  const resolvesPublic: MediaUrlPolicy = { ...DEFAULT_MEDIA_POLICY, resolve: async () => [PUBLIC_IP] };

  test("accepts an https URL on an allowlisted host", async () => {
    const url = await assertSafeMediaUrl("https://cdn.higgsfield.ai/a/b.png?sig=1", resolvesPublic);
    assert.equal(url.hostname, "cdn.higgsfield.ai");
  });

  test("rejects other protocols, hosts, credentials and IP literals", async () => {
    for (const bad of [
      "http://cdn.higgsfield.ai/a.png",
      "https://evil.example/a.png",
      "https://higgsfield.ai.evil.example/a.png",
      "https://user:pw@cdn.higgsfield.ai/a.png",
      "https://127.0.0.1/a.png",
      "https://[::1]/a.png",
      "not a url",
    ]) {
      const error = await rejection(assertSafeMediaUrl(bad, resolvesPublic));
      assert.equal(error.code, "HIGGSFIELD_BAD_MEDIA", bad);
    }
  });

  test("rejects an allowlisted host that resolves to a private address", async () => {
    const error = await rejection(assertSafeMediaUrl("https://cdn.higgsfield.ai/a.png", { ...DEFAULT_MEDIA_POLICY, resolve: async () => ["10.0.0.5"] }));
    assert.equal(error.code, "HIGGSFIELD_BAD_MEDIA");
  });
});

describe("sniffImageMime", () => {
  test("recognises PNG, JPEG and WebP by their bytes", () => {
    assert.equal(sniffImageMime(PNG), "image/png");
    assert.equal(sniffImageMime(Buffer.from([0xff, 0xd8, 0xff, 0xe0])), "image/jpeg");
    assert.equal(sniffImageMime(Buffer.from("RIFF\0\0\0\0WEBPVP8 ")), "image/webp");
    assert.equal(sniffImageMime(Buffer.from("<html>")), null);
  });
});

describe("downloadImage", () => {
  test("returns the bytes and sniffed type", async () => {
    const base = await startServer((_req, res) => { res.setHeader("content-type", "application/octet-stream"); res.end(PNG); });
    const result = await downloadImage(`${base}/a.png`, deps());
    assert.deepEqual(result, { bytes: PNG, mimeType: "image/png" });
  });

  test("retries a 5xx twice with backoff, then succeeds", async () => {
    let calls = 0;
    const base = await startServer((_req, res) => {
      calls += 1;
      if (calls < 3) { res.statusCode = 500; res.end("no"); } else { res.end(PNG); }
    });
    const testDeps = deps();
    const result = await downloadImage(`${base}/flaky.png`, testDeps);
    assert.equal(result.mimeType, "image/png");
    assert.equal(calls, 3);
    assert.deepEqual(testDeps.sleeps, [500, 1_500]);
  });

  test("gives up after three failed attempts with HIGGSFIELD_DOWNLOAD_FAILED", async () => {
    const base = await startServer((_req, res) => { res.statusCode = 503; res.end(); });
    const error = await rejection(downloadImage(`${base}/x.png`, deps()));
    assert.equal(error.code, "HIGGSFIELD_DOWNLOAD_FAILED");
    assert.equal(error.retryable, true);
  });

  test("does not retry a 4xx", async () => {
    let calls = 0;
    const base = await startServer((_req, res) => { calls += 1; res.statusCode = 404; res.end(); });
    const error = await rejection(downloadImage(`${base}/gone.png`, deps()));
    assert.equal(error.code, "HIGGSFIELD_DOWNLOAD_FAILED");
    assert.equal(calls, 1);
  });

  test("rejects non-image bytes and oversize bodies without retrying", async () => {
    const html = await startServer((_req, res) => { res.end("<html>hello</html>"); });
    assert.equal((await rejection(downloadImage(`${html}/a`, deps()))).code, "HIGGSFIELD_BAD_MEDIA");

    const big = await startServer((_req, res) => { res.end(Buffer.concat([PNG, Buffer.alloc(2_000)])); });
    assert.equal((await rejection(downloadImage(`${big}/a`, deps({ maxBytes: 100 })))).code, "HIGGSFIELD_BAD_MEDIA");
  });

  test("follows a redirect that stays on an allowed host and refuses one that leaves it", async () => {
    const base = await startServer((req, res) => {
      if (req.url === "/start") { res.statusCode = 302; res.setHeader("location", "/final.png"); res.end(); }
      else if (req.url === "/leave") { res.statusCode = 302; res.setHeader("location", "http://evil.example/steal"); res.end(); }
      else { res.end(PNG); }
    });
    assert.equal((await downloadImage(`${base}/start`, deps())).mimeType, "image/png");
    assert.equal((await rejection(downloadImage(`${base}/leave`, deps()))).code, "HIGGSFIELD_BAD_MEDIA");
  });

  test("applies the URL policy before any request is made", async () => {
    let requested = false;
    const base = await startServer((_req, res) => { requested = true; res.end(PNG); });
    const strict: MediaUrlPolicy = { ...LOCAL_POLICY, hostSuffixes: ["not-localhost.test"] };
    assert.equal((await rejection(downloadImage(`${base}/a.png`, deps({ policy: strict })))).code, "HIGGSFIELD_BAD_MEDIA");
    assert.equal(requested, false);
  });
});

describe("uploadBytes", () => {
  test("PUTs the exact bytes with the content type", async () => {
    let received: { method?: string; type?: string; body: Buffer } | undefined;
    const base = await startServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk) => chunks.push(chunk));
      req.on("end", () => { received = { method: req.method, type: req.headers["content-type"], body: Buffer.concat(chunks) }; res.end(); });
    });
    await uploadBytes(`${base}/upload/1`, PNG, "image/png", deps());
    assert.equal(received?.method, "PUT");
    assert.equal(received?.type, "image/png");
    assert.deepEqual(received?.body, PNG);
  });

  test("reports a failed upload as HIGGSFIELD_UPLOAD_FAILED", async () => {
    const base = await startServer((_req, res) => { res.statusCode = 403; res.end(); });
    const error = await rejection(uploadBytes(`${base}/upload/1`, PNG, "image/png", deps()));
    assert.equal(error.code, "HIGGSFIELD_UPLOAD_FAILED");
    assert.equal(error.retryable, true);
  });

  test("refuses an upload URL outside the policy", async () => {
    const error = await rejection(uploadBytes("https://evil.example/put", PNG, "image/png", deps({ policy: DEFAULT_MEDIA_POLICY })));
    assert.equal(error.code, "HIGGSFIELD_BAD_MEDIA");
  });
});
````

- [ ] **Step 2: Run it and watch it fail**

Run: `npx tsx --test server/media-guard.test.ts`
Expected: FAIL: cannot find module `./media-guard`.

- [ ] **Step 3: Implement**

Create `server/media-guard.ts`:

````ts
import { lookup } from "node:dns/promises";
import net from "node:net";
import { ProviderError } from "./provider-errors";

/** Hosts Higgsfield media (result images and upload URLs) may live on. Live check #2 records the real hosts. */
export const HIGGSFIELD_MEDIA_HOST_SUFFIXES = [".higgsfield.ai"] as const;

const MAX_REDIRECTS = 2;
const DOWNLOAD_ATTEMPTS = 3;
const DOWNLOAD_BACKOFF_MS = [500, 1_500] as const;

export type ImageMime = "image/png" | "image/jpeg" | "image/webp";

export interface MediaUrlPolicy {
  protocols: readonly string[];
  /** Entries match the host itself and any subdomain; a leading dot is optional. */
  hostSuffixes: readonly string[];
  resolve: (hostname: string) => Promise<string[]>;
}

export interface MediaDeps {
  fetchImpl: typeof fetch;
  policy: MediaUrlPolicy;
  sleep: (ms: number) => Promise<void>;
  maxBytes: number;
}

export const DEFAULT_MEDIA_POLICY: MediaUrlPolicy = {
  protocols: ["https:"],
  hostSuffixes: HIGGSFIELD_MEDIA_HOST_SUFFIXES,
  resolve: async (hostname) => (await lookup(hostname, { all: true })).map((entry) => entry.address),
};

export const defaultMediaDeps: MediaDeps = {
  fetchImpl: (input, init) => fetch(input, init),
  policy: DEFAULT_MEDIA_POLICY,
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  maxBytes: 25 * 1024 * 1024,
};

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

function badMedia(message: string, cause?: unknown): ProviderError {
  return new ProviderError({
    message,
    code: "HIGGSFIELD_BAD_MEDIA",
    category: "invalid_response",
    status: 502,
    retryable: false,
    publicMessage: "Higgsfield returned media the server refused to use.",
    suggestion: "Retry once. If it continues, report the HIGGSFIELD_BAD_MEDIA code from the server log.",
    cause,
  });
}

export function downloadFailed(cause?: unknown): ProviderError {
  return new ProviderError({
    message: "Downloading the generated image failed.",
    code: "HIGGSFIELD_DOWNLOAD_FAILED",
    category: "network",
    status: 502,
    retryable: true,
    publicMessage: "The generated image could not be downloaded.",
    suggestion: "Check the server network connection and retry.",
    cause,
  });
}

export function uploadFailed(cause?: unknown): ProviderError {
  return new ProviderError({
    message: "Uploading a reference image failed.",
    code: "HIGGSFIELD_UPLOAD_FAILED",
    category: "network",
    status: 502,
    retryable: true,
    publicMessage: "A reference image could not be uploaded to Higgsfield.",
    suggestion: "Check the server network connection and retry. Nothing was generated or charged.",
    cause,
  });
}

// ---------------------------------------------------------------------------
// URL policy
// ---------------------------------------------------------------------------

export function isPrivateAddress(address: string): boolean {
  const family = net.isIP(address);
  if (family === 4) {
    const [a, b] = address.split(".").map(Number);
    return a === 0
      || a === 10
      || a === 127
      || (a === 100 && b >= 64 && b <= 127)
      || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168);
  }
  if (family === 6) {
    const lower = address.toLowerCase();
    if (lower === "::" || lower === "::1") return true;
    if (lower.startsWith("fe80:") || lower.startsWith("fc") || lower.startsWith("fd")) return true;
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
    return mapped ? isPrivateAddress(mapped[1]) : false;
  }
  return true;
}

/** Throws HIGGSFIELD_BAD_MEDIA unless `raw` is an allowed protocol on an allowlisted hostname that resolves only to public addresses. */
export async function assertSafeMediaUrl(raw: string, policy: MediaUrlPolicy = DEFAULT_MEDIA_POLICY): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch (error) {
    throw badMedia("Media URL is not a valid URL.", error);
  }
  if (!policy.protocols.includes(url.protocol)) throw badMedia(`Media URL protocol ${url.protocol} is not allowed.`);
  if (url.username || url.password) throw badMedia("Media URL must not carry credentials.");

  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (net.isIP(host) !== 0) throw badMedia("Media URL must use a hostname, not an IP address.");
  const allowed = policy.hostSuffixes.some((suffix) => {
    const bare = suffix.replace(/^\./, "").toLowerCase();
    return host === bare || host.endsWith(`.${bare}`);
  });
  if (!allowed) throw badMedia(`Media host ${host} is not on the allowlist.`);

  let addresses: string[];
  try {
    addresses = await policy.resolve(host);
  } catch (error) {
    throw badMedia("Media host could not be resolved.", error);
  }
  if (addresses.length === 0 || addresses.some(isPrivateAddress)) {
    throw badMedia("Media host resolves to a private or unusable address.");
  }
  return url;
}

// ---------------------------------------------------------------------------
// Fetching
// ---------------------------------------------------------------------------

async function guardedFetch(rawUrl: string, init: RequestInit, deps: MediaDeps): Promise<Response> {
  let current = rawUrl;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    const url = await assertSafeMediaUrl(current, deps.policy);
    const response = await deps.fetchImpl(url, { ...init, redirect: "manual" });
    const location = response.headers.get("location");
    if (response.status >= 300 && response.status < 400 && location) {
      await response.body?.cancel();
      current = new URL(location, url).toString();
      continue;
    }
    return response;
  }
  throw badMedia("Media URL redirected too many times.");
}

async function readCapped(response: Response, maxBytes: number): Promise<Buffer> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel();
    throw badMedia("Media is larger than the allowed size.");
  }
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw badMedia("Media is larger than the allowed size.");
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}

export function sniffImageMime(bytes: Uint8Array): ImageMime | null {
  if (bytes.length >= 4 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return "image/png";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  const ascii = (start: number, length: number) => String.fromCharCode(...Array.from(bytes.subarray(start, start + length)));
  if (bytes.length >= 12 && ascii(0, 4) === "RIFF" && ascii(8, 4) === "WEBP") return "image/webp";
  return null;
}

/** GETs an image through the URL policy. Retries network failures and 5xx twice; policy, size and type failures fail immediately. */
export async function downloadImage(
  rawUrl: string,
  deps: MediaDeps = defaultMediaDeps,
): Promise<{ bytes: Buffer; mimeType: ImageMime }> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= DOWNLOAD_ATTEMPTS; attempt += 1) {
    try {
      const response = await guardedFetch(rawUrl, { method: "GET" }, deps);
      if (response.status >= 500) throw new Error(`HTTP ${response.status}`);
      if (!response.ok) throw downloadFailed(new Error(`HTTP ${response.status}`));
      const bytes = await readCapped(response, deps.maxBytes);
      const mimeType = sniffImageMime(bytes);
      if (!mimeType) throw badMedia("Downloaded media is not a PNG, JPEG, or WebP image.");
      return { bytes, mimeType };
    } catch (error) {
      if (error instanceof ProviderError) throw error;
      lastError = error;
      if (attempt < DOWNLOAD_ATTEMPTS) await deps.sleep(DOWNLOAD_BACKOFF_MS[attempt - 1]);
    }
  }
  throw downloadFailed(lastError);
}

/** PUTs bytes to a presigned upload URL through the URL policy. Not retried: nothing has been submitted or charged yet. */
export async function uploadBytes(
  rawUrl: string,
  bytes: Buffer,
  contentType: string,
  deps: MediaDeps = defaultMediaDeps,
): Promise<void> {
  let response: Response;
  try {
    response = await guardedFetch(rawUrl, { method: "PUT", headers: { "content-type": contentType }, body: new Uint8Array(bytes) }, deps);
  } catch (error) {
    if (error instanceof ProviderError) throw error;
    throw uploadFailed(error);
  }
  if (!response.ok) throw uploadFailed(new Error(`HTTP ${response.status}`));
}
````

- [ ] **Step 4: Run it and watch it pass**

Run: `npx tsx --test server/media-guard.test.ts`
Expected: PASS, 16 tests.

- [ ] **Step 5: Gate and commit**

Run: `npm test 2>&1 | grep -E "ℹ (tests|pass|fail)" && npm run check`
Expected: `ℹ tests 116`, `ℹ pass 116`, `ℹ fail 0`; no `tsc` errors.

```bash
git add server/media-guard.ts server/media-guard.test.ts
git commit -m "Add a guarded download and upload path for Higgsfield media"
```

---

### Task 5: Higgsfield thumbnail generation, and Live check #2

**Files:**
- Create: `server/higgsfield-image.ts`, `server/higgsfield-image.test.ts`, `script/live-claude-check.ts`
- Modify: `server/provider-models.ts` (append the Higgsfield section), `server/provider-models.test.ts` (replace), `package.json` (one script)

**Interfaces:**
- Consumes: `runClaudeMcp`, `HIGGSFIELD_MCP_NAME`, `McpRunOptions`, `McpRunResult` (Task 3); `MediaDeps`, `defaultMediaDeps`, `downloadImage`, `uploadBytes` (Task 4); `ProviderError`, `normalizeProviderError`, `logProviderFailure` (Task 2); `buildThumbnailPrompt`, `ThumbnailConfig`, `ThumbnailResult` from `./ai`.
- Produces (from `provider-models.ts`): `HIGGSFIELD_IMAGE_MODELS` (entries carry `id, label, description, tierParam, tiers, defaultTier, mediaRole`), `HiggsfieldImageModel`, `DEFAULT_HIGGSFIELD_IMAGE_MODEL`, `isHiggsfieldImageModel`, `getHiggsfieldImageModel(id)`, `isHiggsfieldImageTier(modelId, tier)`, `resolveHiggsfieldImageModel(env?)`, `resolveHiggsfieldImageTier(env?)`.
- Produces (from `higgsfield-image.ts`): `generateThumbnail(topic: string, config: ThumbnailConfig, deps?: ThumbnailDeps): Promise<ThumbnailResult>`; `testHiggsfieldConnection(runMcp?): Promise<{ connected: true; credits: number }>`; `getHiggsfieldConnectionState(): boolean | null`; `resetHiggsfieldConnectionState()`; `HIGGSFIELD_TOOLS`; `ThumbnailDeps = { runMcp: McpRunner; media: MediaDeps }`; `defaultThumbnailDeps`. Failure codes: `HIGGSFIELD_NOT_CONNECTED` (503), `HIGGSFIELD_NO_CREDITS` (402), `HIGGSFIELD_NO_IMAGE` (502), `HIGGSFIELD_FAILED` (502, retryable), `HIGGSFIELD_INCOMPLETE` (504, not retryable).

- [ ] **Step 1: Write the failing tests**

Replace `server/provider-models.test.ts` with the full version (adds the Higgsfield cases):

````ts
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  HIGGSFIELD_IMAGE_MODELS,
  isHiggsfieldImageTier,
  resolveClaudeTextEffort,
  resolveClaudeTextModel,
  resolveHiggsfieldImageModel,
  resolveHiggsfieldImageTier,
} from "./provider-models";

describe("Claude text settings", () => {
  test("default to sonnet at low effort and ignore unknown values", () => {
    assert.equal(resolveClaudeTextModel({}), "sonnet");
    assert.equal(resolveClaudeTextEffort({}), "low");
    assert.equal(resolveClaudeTextModel({ CLAUDE_TEXT_MODEL: "gemini-3.7-flash" }), "sonnet");
    assert.equal(resolveClaudeTextEffort({ CLAUDE_TEXT_EFFORT: "xhigh" }), "low");
  });

  test("accept the allowlisted values", () => {
    assert.equal(resolveClaudeTextModel({ CLAUDE_TEXT_MODEL: " opus " }), "opus");
    assert.equal(resolveClaudeTextEffort({ CLAUDE_TEXT_EFFORT: "high" }), "high");
  });
});

describe("Higgsfield image settings", () => {
  test("default to gpt_image_2_5 at medium quality", () => {
    const model = resolveHiggsfieldImageModel({});
    assert.equal(model.id, "gpt_image_2_5");
    assert.equal(resolveHiggsfieldImageTier({}), "medium");
  });

  test("use each model's own tier parameter and default", () => {
    const env = { HIGGSFIELD_IMAGE_MODEL: "seedream_v5_pro" };
    assert.equal(resolveHiggsfieldImageModel(env).tierParam, "resolution");
    assert.equal(resolveHiggsfieldImageTier(env), "2k");
    assert.equal(resolveHiggsfieldImageTier({ ...env, HIGGSFIELD_IMAGE_QUALITY: "1k" }), "1k");
  });

  test("fall back when a tier does not belong to the selected model", () => {
    assert.equal(resolveHiggsfieldImageTier({ HIGGSFIELD_IMAGE_QUALITY: "2k" }), "medium");
    assert.equal(resolveHiggsfieldImageTier({ HIGGSFIELD_IMAGE_MODEL: "seedream_v5_pro", HIGGSFIELD_IMAGE_QUALITY: "high" }), "2k");
    assert.equal(resolveHiggsfieldImageModel({ HIGGSFIELD_IMAGE_MODEL: "nano-banana" }).id, "gpt_image_2_5");
  });

  test("every table entry has a default tier that it accepts", () => {
    for (const model of HIGGSFIELD_IMAGE_MODELS) {
      assert.equal(isHiggsfieldImageTier(model.id, model.defaultTier), true, model.id);
    }
  });
});
````

Create `server/higgsfield-image.test.ts` (stubs the MCP runner for the flow cases and adds one end-to-end case through the real runner and the fake CLI):

````ts
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
````

- [ ] **Step 2: Run them and watch them fail**

Run: `npx tsx --test server/provider-models.test.ts server/higgsfield-image.test.ts`
Expected: FAIL: `resolveHiggsfieldImageTier` is not exported, and `./higgsfield-image` cannot be found.

- [ ] **Step 3: Implement**

Append this to the **end** of `server/provider-models.ts`:

````ts
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
````

Create `server/higgsfield-image.ts`:

````ts
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
````

Create `script/live-claude-check.ts` (opt-in; it is not matched by the `npm test` glob and is not type-checked by `tsc`):

````ts
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
````

Add the npm script. In `package.json`, change the `"test"` line and add one line after it:

```json
    "test": "tsx --test server/*.test.ts shared/*.test.ts",
    "live:claude": "tsx script/live-claude-check.ts"
```

- [ ] **Step 4: Run them and watch them pass**

Run: `npx tsx --test server/provider-models.test.ts server/higgsfield-image.test.ts`
Expected: PASS.

Run: `npm run live:claude` then `npm run live:claude -- image`
Expected: the first prints the usage lines and exits 2; the second prints `This check spends Higgsfield credits ... Re-run with --spend to confirm.` and exits 2. Neither touches a provider.

- [ ] **Step 5: Gate and commit**

Run: `npm test 2>&1 | grep -E "ℹ (tests|pass|fail)" && npm run check`
Expected: `ℹ tests 133`, `ℹ pass 133`, `ℹ fail 0`; no `tsc` errors.

```bash
git add server/higgsfield-image.ts server/higgsfield-image.test.ts server/provider-models.ts server/provider-models.test.ts script/live-claude-check.ts package.json
git commit -m "Add Higgsfield thumbnail generation through a locked-down claude session"
```

- [ ] **Step 6: Live check #2 (spends Higgsfield credits: ask the operator before running)**

This is the riskiest unknown in the design: it proves the two-run reference-image upload and records the real media hosts. **Stop and ask the operator for a go-ahead first.** It costs about 1-2 credits per image and uses the operator's existing Higgsfield login.

Run: `npm run live:claude -- image --spend`
Expected on success: `PASS in ... s | model GPT Image 2.5 (gpt_image_2_5) | image/png | saved to <tmp>/live-check-thumbnail-plain.png`, then `media hosts used: <host>`.

Run: `npm run live:claude -- image --with-reference --spend`
Expected on success: the same shape, saved as `...-reference.png`, with the upload host(s) and the download host listed.

Open both saved images and confirm they are real 16:9-ish thumbnails.

Handle the outcomes:
- **`HIGGSFIELD_BAD_MEDIA` naming a host** (the FAIL line reads `Media host <host> is not on the allowlist.`): that result or upload host is not allowlisted. The guard refuses it before any request is made, so it is named in the failure line, not under `media hosts used`. Add exactly the host it names to `HIGGSFIELD_MEDIA_HOST_SUFFIXES` in `server/media-guard.ts` as a dot-prefixed entry (a host `cdn.example.com` becomes `".cdn.example.com"`), and re-run. A reference run can need this once for the upload host and once more for the result host. When both runs pass, commit: `git commit -am "Allow the Higgsfield media hosts recorded by live check #2"`.
- **`HIGGSFIELD_NOT_CONNECTED`**: Higgsfield is not connected for this checkout's `claude`. Run `claude mcp add --transport http higgsfield https://mcp.higgsfield.ai/mcp`, then `/mcp` inside `claude` to sign in, and retry.
- **The reference run fails but the plain run passes** (for example the batch tool rejects `medias`, or the upload reply shape does not match): **stop and report to the operator** with the printed error. Do not drop reference images without their decision (spec, section 11). Report also whether a direct MCP client is worth revisiting.
- **`HIGGSFIELD_UPLOAD_FAILED` or `HIGGSFIELD_DOWNLOAD_FAILED` on a URL that looks truncated or altered**: the model mis-copied a long signed URL into its reply. Report this to the operator. The documented fallback (spec, section 11) is to switch image runs to `--output-format stream-json --verbose` and read URLs from the tool results instead of the final reply. It is not implemented in this plan, so do not attempt it without the operator's decision.
- **`HIGGSFIELD_INCOMPLETE`**: credits may have been spent. Tell the operator to check their Higgsfield generations before any retry.

Record the result (hosts, timings, credits used) in the commit message or a note to the operator.

---

### Task 6: Settings for Claude and Higgsfield (server contract and client page)

**Files:**
- Replace: `server/settings.ts`, `client/src/pages/settings.tsx`
- Modify: `server/routes.ts` (edit script), `server/security-contracts.test.ts` (edit script)
- Create: `server/settings.test.ts`, `server/settings-routes.test.ts`, `server/test-fixtures/route-harness.ts`, `shared/api-error-message.ts`, `shared/api-error-message.test.ts`

**Interfaces:**
- Consumes: `getClaudeStatus` (Task 3); `getHiggsfieldConnectionState`, `testHiggsfieldConnection` (Task 5); the Claude and Higgsfield tables and resolvers (Tasks 3, 5).
- Produces: `PUT /api/settings/api-keys` payload `{ youtubeApiKey?, claudeTextModel?, claudeTextEffort?, higgsfieldImageModel?, higgsfieldImageQuality? }` (strict, allowlisted); `GET /api/settings/status` returning `{ youtube, claude: {installed, signedIn, authMethod?, version?}, higgsfield: {connected: boolean | null}, models: { text, textEffort, image, imageQuality, textOptions, effortOptions, imageOptions } }` (`imageOptions` keeps `id`/`label`/`description`, so the Thumbnail page label keeps working); new `POST /api/settings/test-higgsfield` returning `{ connected: true, credits }`; `planSettingsUpdate(input, current): ModelSettings`; `readApiErrorBody(message)` and `apiErrorText(error, fallback)` from `@shared/api-error-message`; test helper `startRouteHarness(): Promise<{ base; post(route, body, headers?); stop() }>`.

Note: after this task the old Gemini API key field is gone from Settings, while `ai.ts` still reads `GEMINI_*` from the environment until Task 7.

- [ ] **Step 1: Write the failing tests**

Create `server/test-fixtures/route-harness.ts` (the real Express routes on a loopback port, `claude` replaced by the fake CLI, environment restored on `stop`):

````ts
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
````

Create `server/settings-routes.test.ts`:

````ts
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "node:test";
import { startRouteHarness, type RouteHarness } from "./test-fixtures/route-harness";

let harness: RouteHarness;

beforeEach(async () => {
  harness = await startRouteHarness();
});

afterEach(async () => {
  await harness.stop();
});

describe("settings routes", () => {
  test("status reports the Claude CLI without any API key and keeps the image option shape", async () => {
    const response = await fetch(`${harness.base}/api/settings/status`);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.deepEqual(body.claude, { installed: true, signedIn: true, authMethod: "claude.ai", version: "2.1.278" });
    assert.deepEqual(body.higgsfield, { connected: null });
    assert.equal(body.models.text, "sonnet");
    assert.equal(body.models.textEffort, "low");
    assert.equal(body.models.image, "gpt_image_2_5");
    assert.equal(body.models.imageQuality, "medium");
    assert.ok(body.models.imageOptions.every((option: { id: string; label: string; description: string }) => option.id && option.label && option.description));
    assert.equal("gemini" in body, false);
  });

  test("settings routes refuse forwarded requests", async () => {
    const response = await fetch(`${harness.base}/api/settings/status`, { headers: { "x-forwarded-for": "203.0.113.9" } });
    assert.equal(response.status, 403);
    assert.equal((await harness.post("/api/settings/test-higgsfield", {}, { "x-forwarded-for": "203.0.113.9" })).status, 403);
  });

  test("test-higgsfield returns the balance and marks Higgsfield connected", async () => {
    process.env.FAKE_CLAUDE_MODE = "results";
    process.env.FAKE_CLAUDE_RESULTS = JSON.stringify([JSON.stringify({ status: "ok", credits: 12.5 })]);
    const response = await harness.post("/api/settings/test-higgsfield", {});
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { connected: true, credits: 12.5 });
    const status = await (await fetch(`${harness.base}/api/settings/status`)).json();
    assert.deepEqual(status.higgsfield, { connected: true });
  });

  test("test-higgsfield reports a disconnected server with setup guidance", async () => {
    process.env.FAKE_CLAUDE_MODE = "results";
    process.env.FAKE_CLAUDE_RESULTS = JSON.stringify([JSON.stringify({ status: "error", reason: "UNAVAILABLE" })]);
    const response = await harness.post("/api/settings/test-higgsfield", {});
    assert.equal(response.status, 503);
    const body = await response.json();
    assert.equal(body.code, "HIGGSFIELD_NOT_CONNECTED");
    assert.match(body.suggestion, /claude mcp add --transport http higgsfield/);
  });
});
````

Create `server/settings.test.ts`:

````ts
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { planSettingsUpdate, type ModelSettings } from "./settings";

const current: ModelSettings = { text: "sonnet", textEffort: "low", image: "gpt_image_2_5", imageQuality: "medium" };

describe("planSettingsUpdate", () => {
  test("keeps current values for anything not supplied", () => {
    assert.deepEqual(planSettingsUpdate({}, current), current);
    assert.deepEqual(planSettingsUpdate({ claudeTextEffort: "high" }, current), { ...current, textEffort: "high" });
  });

  test("keeps the current tier when the new model accepts it", () => {
    assert.deepEqual(planSettingsUpdate({ higgsfieldImageModel: "gpt_image_2" }, current), { ...current, image: "gpt_image_2" });
  });

  test("switches to the new model's default tier when the current tier does not fit", () => {
    assert.deepEqual(
      planSettingsUpdate({ higgsfieldImageModel: "seedream_v5_pro" }, current),
      { ...current, image: "seedream_v5_pro", imageQuality: "2k" },
    );
  });

  test("accepts an explicit valid pair and rejects an invalid one", () => {
    assert.equal(planSettingsUpdate({ higgsfieldImageModel: "seedream_v5_pro", higgsfieldImageQuality: "1k" }, current).imageQuality, "1k");
    assert.throws(() => planSettingsUpdate({ higgsfieldImageQuality: "2k" }, current), /quality supported by this model/);
  });

  test("rejects values outside the allowlists", () => {
    assert.throws(() => planSettingsUpdate({ claudeTextModel: "haiku" }, current), /supported Claude model/);
    assert.throws(() => planSettingsUpdate({ claudeTextEffort: "max" }, current), /supported effort level/);
    assert.throws(() => planSettingsUpdate({ higgsfieldImageModel: "nano-banana" }, current), /supported Higgsfield image model/);
  });
});
````

Create `shared/api-error-message.test.ts`:

````ts
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { apiErrorText, readApiErrorBody } from "./api-error-message";

const body = JSON.stringify({
  error: "Claude Code is not signed in.",
  code: "CLAUDE_NOT_SIGNED_IN",
  category: "invalid_key",
  retryable: false,
  suggestion: "Run `claude` in a terminal and sign in with /login, then try again.",
});

describe("readApiErrorBody", () => {
  test("parses the JSON body out of an apiRequest error message", () => {
    assert.deepEqual(readApiErrorBody(`401: ${body}`), {
      error: "Claude Code is not signed in.",
      suggestion: "Run `claude` in a terminal and sign in with /login, then try again.",
      code: "CLAUDE_NOT_SIGNED_IN",
      category: "invalid_key",
      retryable: false,
    });
  });

  test("returns null for anything that is not a status followed by a JSON object", () => {
    assert.equal(readApiErrorBody("Network request failed"), null);
    assert.equal(readApiErrorBody("500: Internal Server Error"), null);
    assert.equal(readApiErrorBody("500: {not json}"), null);
    assert.equal(readApiErrorBody("500: [1,2]"), null);
  });

  test("ignores fields of the wrong type", () => {
    assert.deepEqual(readApiErrorBody('400: {"error":5,"suggestion":null,"retryable":"yes"}'), {
      error: undefined, suggestion: undefined, code: undefined, category: undefined, retryable: undefined,
    });
  });
});

describe("apiErrorText", () => {
  test("prefers the suggestion, then the error, then the raw message, then the fallback", () => {
    assert.match(apiErrorText(new Error(`401: ${body}`), "fallback"), /sign in with \/login/);
    assert.equal(apiErrorText(new Error('500: {"error":"Something broke"}'), "fallback"), "Something broke");
    assert.equal(apiErrorText(new Error("Network request failed"), "fallback"), "Network request failed");
    assert.equal(apiErrorText(undefined, "fallback"), "fallback");
  });
});
````

Save this as `$PLAN_TMP/task6a-tests.mjs` and run it from the repo root. It extends the existing "Settings payload is strict" test:

````js
import { applyEdits } from "./apply-edits.mjs";

applyEdits("server/security-contracts.test.ts", [[
`  assert.equal(apiKeySettingsSchema.safeParse({ geminiTextModel: "unknown-model" }).success, false);`,
`  assert.equal(apiKeySettingsSchema.safeParse({ claudeTextModel: "unknown-model" }).success, false);
  assert.equal(apiKeySettingsSchema.safeParse({ claudeTextEffort: "xhigh" }).success, false);
  assert.equal(apiKeySettingsSchema.safeParse({ higgsfieldImageModel: "unknown-model" }).success, false);
  assert.equal(apiKeySettingsSchema.safeParse({ higgsfieldImageModel: "gpt_image_2_5", higgsfieldImageQuality: "2k" }).success, false);
  assert.equal(apiKeySettingsSchema.safeParse({ geminiTextModel: "gemini-3.7-flash" }).success, false);
  assert.equal(apiKeySettingsSchema.safeParse({
    claudeTextModel: "sonnet",
    claudeTextEffort: "low",
    higgsfieldImageModel: "seedream_v5_pro",
    higgsfieldImageQuality: "1k",
  }).success, true);`]]);
````

```bash
node "$PLAN_TMP/task6a-tests.mjs"
```

- [ ] **Step 2: Run them and watch them fail**

Run: `npx tsx --test server/settings.test.ts server/settings-routes.test.ts server/security-contracts.test.ts shared/api-error-message.test.ts`
Expected: FAIL: `planSettingsUpdate` is not exported from `./settings`, `./api-error-message` cannot be found, and the settings-routes cases fail.

- [ ] **Step 3: Implement**

Replace the whole of `server/settings.ts`:

````ts
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
````

Create `shared/api-error-message.ts`:

````ts
export interface ApiErrorBody {
  error?: string;
  suggestion?: string;
  code?: string;
  category?: string;
  retryable?: boolean;
}

/** `apiRequest` throws `Error("<status>: <response body>")`. Returns the parsed JSON body when the message has that shape. */
export function readApiErrorBody(message: string): ApiErrorBody | null {
  const match = /^\d{3}:\s*(\{[\s\S]*\})\s*$/.exec(message);
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[1]);
    if (!parsed || typeof parsed !== "object") return null;
    const text = (key: string): string | undefined => (typeof parsed[key] === "string" ? parsed[key] : undefined);
    return {
      error: text("error"),
      suggestion: text("suggestion"),
      code: text("code"),
      category: text("category"),
      retryable: typeof parsed.retryable === "boolean" ? parsed.retryable : undefined,
    };
  } catch {
    return null;
  }
}

/** The most useful text for a failed API call: the server's suggestion, else its error, else the raw message. */
export function apiErrorText(error: unknown, fallback: string): string {
  const message = error instanceof Error ? error.message : String(error ?? "");
  const body = readApiErrorBody(message);
  return body?.suggestion || body?.error || message || fallback;
}
````

Save this as `$PLAN_TMP/task6a-routes.mjs`, then run it. It makes the status route async and adds `POST /api/settings/test-higgsfield`:

````js
import { applyEdits } from "./apply-edits.mjs";

applyEdits(process.argv[2], [
  [`import { generateScript, generateIdeas, generateResearchInsights, regenerateTitles, regenerateSection, regenerateParagraph, generateThumbnail, generateThumbnailSuggestions, extractNarrationText } from "./ai";`,
   `import { generateScript, generateIdeas, generateResearchInsights, regenerateTitles, regenerateSection, regenerateParagraph, generateThumbnail, generateThumbnailSuggestions, extractNarrationText } from "./ai";
import { testHiggsfieldConnection } from "./higgsfield-image";`],

  [`  app.get("/api/settings/status", (req, res) => {`, `  app.get("/api/settings/status", async (req, res) => {`],
  [`    return res.json(getApiKeyStatus());`, `    return res.json(await getApiKeyStatus());`],

  [`  app.get("/api/youtube/search", rateLimit, async (req, res) => {`,
   `  app.post("/api/settings/test-higgsfield", rateLimit, async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    if (!isLocalSettingsRequest(req)) {
      return res.status(403).json({ error: "Settings are available only from this machine." });
    }

    try {
      return res.json(await testHiggsfieldConnection());
    } catch (error: unknown) {
      const providerError = normalizeProviderError(error, "higgsfield");
      return res.status(providerError.status).json(providerErrorPayload(providerError, "Higgsfield connection test"));
    }
  });

  app.get("/api/youtube/search", rateLimit, async (req, res) => {`],
]);
````

```bash
node "$PLAN_TMP/task6a-routes.mjs" server/routes.ts
```

Replace the whole of `client/src/pages/settings.tsx`:

````tsx
import { FormEvent, useEffect, useRef, useState } from "react";
import { ExternalLink, Eye, EyeOff, KeyRound, Loader2, Plug, Save, ShieldCheck } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { apiRequest } from "@/lib/queryClient";
import { apiErrorText } from "@shared/api-error-message";

interface ModelOption {
  id: string;
  label: string;
  description: string;
}

interface ImageModelOption extends ModelOption {
  tierParam: string;
  tiers: string[];
  defaultTier: string;
}

interface SettingsStatus {
  youtube: boolean;
  claude: { installed: boolean; signedIn: boolean; authMethod?: string; version?: string };
  higgsfield: { connected: boolean | null };
  models: {
    text: string;
    textEffort: string;
    image: string;
    imageQuality: string;
    textOptions: ModelOption[];
    effortOptions: ModelOption[];
    imageOptions: ImageModelOption[];
  };
}

interface KeyFieldProps {
  id: string;
  label: string;
  description: string;
  configured: boolean;
  inputRef: React.RefObject<HTMLInputElement>;
  providerUrl: string;
  providerLabel: string;
}

const COMMUNITIES = [
  {
    id: "free",
    title: "AI Marketing Hub",
    tier: "Free community",
    url: "https://www.skool.com/ai-marketing-hub",
    colors: ["#F1B43C", "#3D8FD1", "#D64A43"],
  },
  {
    id: "pro",
    title: "AI Marketing Hub Pro",
    tier: "Pro community",
    url: "https://www.skool.com/ai-marketing-hub-pro",
    colors: ["#D64A43", "#E2A33A", "#4D9B65"],
  },
] as const;

const HIGGSFIELD_CONNECT_COMMAND = "claude mcp add --transport http higgsfield https://mcp.higgsfield.ai/mcp";

function CommunityMark({
  colors,
}: {
  colors: readonly [string, string, string];
}) {
  const heights = ["h-3", "h-5", "h-4"] as const;

  return (
    <span
      aria-hidden="true"
      className="flex h-10 w-10 shrink-0 items-end justify-center gap-1 rounded-lg border border-border bg-background px-2 pb-2"
    >
      {colors.map((color, index) => (
        <span
          className={`w-1 rounded-full ${heights[index]}`}
          key={color}
          style={{ backgroundColor: color }}
        />
      ))}
    </span>
  );
}

function KeyField({
  id,
  label,
  description,
  configured,
  inputRef,
  providerUrl,
  providerLabel,
}: KeyFieldProps) {
  const [showKey, setShowKey] = useState(false);

  return (
    <div className="space-y-3 rounded-lg border border-border bg-background/50 p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <Label htmlFor={id} className="text-base">{label}</Label>
          <p className="mt-1 text-sm text-muted-foreground">{description}</p>
        </div>
        <Badge
          variant="outline"
          className={configured
            ? "border-green-500/40 bg-green-500/10 text-green-500"
            : "text-muted-foreground"}
        >
          {configured ? "Configured" : "Not configured"}
        </Badge>
      </div>

      <div className="relative">
        <Input
          ref={inputRef}
          id={id}
          name={id}
          type={showKey ? "text" : "password"}
          autoComplete="off"
          spellCheck={false}
          placeholder={configured ? "Enter a replacement key" : "Paste API key"}
          className="pr-11 font-mono"
          data-testid={`input-${id}`}
        />
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="absolute right-0 top-0"
          onClick={() => setShowKey((visible) => !visible)}
          aria-label={showKey ? `Hide ${label}` : `Show ${label}`}
        >
          {showKey ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
        </Button>
      </div>

      <a
        href={providerUrl}
        target="_blank"
        rel="noreferrer"
        className="inline-flex items-center gap-1 text-sm text-primary hover:underline"
      >
        {providerLabel}
        <ExternalLink className="h-3.5 w-3.5" />
      </a>
    </div>
  );
}

function StatusBadge({ state, label }: { state: "ok" | "warn" | "unknown"; label: string }) {
  const className = state === "ok"
    ? "border-green-500/40 bg-green-500/10 text-green-500"
    : state === "warn"
      ? "border-amber-500/40 bg-amber-500/10 text-amber-500"
      : "text-muted-foreground";
  return <Badge variant="outline" className={className}>{label}</Badge>;
}

function OptionSelect({
  id,
  label,
  value,
  options,
  onChange,
}: {
  id: string;
  label: string;
  value: string;
  options: ModelOption[];
  onChange: (value: string) => void;
}) {
  return (
    <div className="space-y-2">
      <Label htmlFor={id}>{label}</Label>
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger id={id} data-testid={`select-${id}`}>
          <SelectValue placeholder="Choose an option" />
        </SelectTrigger>
        <SelectContent>
          {options.map((option) => (
            <SelectItem key={option.id} value={option.id}>
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <p className="text-xs text-muted-foreground">
        {options.find((option) => option.id === value)?.description}
      </p>
    </div>
  );
}

export default function SettingsPage() {
  const [status, setStatus] = useState<SettingsStatus | null>(null);
  const [claudeTextModel, setClaudeTextModel] = useState("");
  const [claudeTextEffort, setClaudeTextEffort] = useState("");
  const [higgsfieldImageModel, setHiggsfieldImageModel] = useState("");
  const [higgsfieldImageQuality, setHiggsfieldImageQuality] = useState("");
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [isTesting, setIsTesting] = useState(false);
  const [credits, setCredits] = useState<number | null>(null);
  const [testError, setTestError] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const youtubeKeyRef = useRef<HTMLInputElement>(null);
  const { toast } = useToast();

  const applyStatus = (next: SettingsStatus) => {
    setStatus(next);
    setClaudeTextModel(next.models.text);
    setClaudeTextEffort(next.models.textEffort);
    setHiggsfieldImageModel(next.models.image);
    setHiggsfieldImageQuality(next.models.imageQuality);
  };

  useEffect(() => {
    const loadStatus = async () => {
      try {
        const response = await fetch("/api/settings/status", { cache: "no-store" });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || "Unable to load settings.");
        applyStatus(data as SettingsStatus);
      } catch (error: any) {
        setLoadError(error?.message || "Unable to load settings.");
      } finally {
        setIsLoading(false);
      }
    };

    loadStatus();
  }, []);

  const selectedImageModel = status?.models.imageOptions.find((model) => model.id === higgsfieldImageModel);

  const handleImageModelChange = (modelId: string) => {
    setHiggsfieldImageModel(modelId);
    const model = status?.models.imageOptions.find((option) => option.id === modelId);
    if (model && !model.tiers.includes(higgsfieldImageQuality)) {
      setHiggsfieldImageQuality(model.defaultTier);
    }
  };

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!status) return;
    const youtubeApiKey = youtubeKeyRef.current?.value.trim() || "";
    const modelsChanged = claudeTextModel !== status.models.text
      || claudeTextEffort !== status.models.textEffort
      || higgsfieldImageModel !== status.models.image
      || higgsfieldImageQuality !== status.models.imageQuality;

    if (!youtubeApiKey && !modelsChanged) {
      toast({
        title: "No changes to save",
        description: "Enter a replacement key or choose a different option.",
      });
      return;
    }

    setIsSaving(true);
    try {
      const response = await apiRequest("PUT", "/api/settings/api-keys", {
        ...(youtubeApiKey ? { youtubeApiKey } : {}),
        claudeTextModel,
        claudeTextEffort,
        higgsfieldImageModel,
        higgsfieldImageQuality,
      }) as { success: boolean; status: SettingsStatus };

      applyStatus(response.status);
      if (youtubeKeyRef.current) youtubeKeyRef.current.value = "";
      toast({
        title: "Settings saved",
        description: "The local server is using the updated settings.",
      });
    } catch (error: unknown) {
      toast({
        title: "Could not save settings",
        description: apiErrorText(error, "Check the values and try again."),
        variant: "destructive",
      });
    } finally {
      setIsSaving(false);
    }
  };

  const handleTestConnection = async () => {
    setIsTesting(true);
    setTestError(null);
    try {
      const result = await apiRequest("POST", "/api/settings/test-higgsfield", {}) as { connected: boolean; credits: number };
      setCredits(result.credits);
      setStatus((current) => (current ? { ...current, higgsfield: { connected: true } } : current));
    } catch (error: unknown) {
      setCredits(null);
      setTestError(apiErrorText(error, "Could not reach Higgsfield."));
      setStatus((current) => (current ? { ...current, higgsfield: { connected: false } } : current));
    } finally {
      setIsTesting(false);
    }
  };

  const claude = status?.claude;
  const higgsfieldConnected = status?.higgsfield.connected ?? null;

  return (
    <div className="mx-auto w-full max-w-4xl space-y-6 p-6 md:p-8">
      <div>
        <div className="flex items-center gap-2 text-primary">
          <KeyRound className="h-5 w-5" />
          <span className="text-sm font-medium">Local connections</span>
        </div>
        <h1 className="mt-2 text-3xl font-bold">Settings</h1>
        <p className="mt-2 max-w-2xl text-muted-foreground">
          Connect YouTube research data, and check the Claude and Higgsfield connections used for AI generation.
        </p>
      </div>

      <Alert>
        <ShieldCheck className="h-4 w-4" />
        <AlertTitle>Stored locally</AlertTitle>
        <AlertDescription>
          The YouTube key and your choices are written to the server's ignored <code>.env</code> file
          with owner-only permissions. Saved keys are never returned to the browser and the input field
          is cleared after saving. Claude and Higgsfield use your local Claude Code sign-in, so no keys
          for them are stored here. Settings changes are accepted only from this machine.
        </AlertDescription>
      </Alert>

      {loadError && (
        <Alert variant="destructive">
          <AlertTitle>Settings unavailable</AlertTitle>
          <AlertDescription>{loadError}</AlertDescription>
        </Alert>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Connections</CardTitle>
          <CardDescription>
            Leave the YouTube key blank to keep its current value.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {isLoading || !status ? (
            <div className="flex min-h-48 items-center justify-center text-muted-foreground">
              <Loader2 className="mr-2 h-5 w-5 animate-spin" />
              Loading connection status
            </div>
          ) : (
            <form onSubmit={handleSubmit} className="space-y-4">
              <KeyField
                id="youtube-api-key"
                label="YouTube Data API"
                description="Required for video search and research data."
                configured={status.youtube}
                inputRef={youtubeKeyRef}
                providerUrl="https://console.cloud.google.com/apis/credentials"
                providerLabel="Open Google Cloud credentials"
              />

              <div className="space-y-3 rounded-lg border border-border bg-background/50 p-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <p className="text-base font-medium">Claude: research and writing</p>
                    <p className="mt-1 text-sm text-muted-foreground">
                      Insights, ideas, scripts, and thumbnail suggestions run through your Claude Code sign-in.
                    </p>
                  </div>
                  <StatusBadge
                    state={claude?.installed && claude.signedIn ? "ok" : "warn"}
                    label={!claude?.installed ? "Not installed" : claude.signedIn ? "Signed in" : "Not signed in"}
                  />
                </div>
                {claude && !claude.installed && (
                  <p className="text-sm text-muted-foreground">
                    Install Claude Code, or set <code>CLAUDE_BIN</code> in <code>.env</code> to the executable path.
                  </p>
                )}
                {claude?.installed && !claude.signedIn && (
                  <p className="text-sm text-muted-foreground">
                    Run <code>claude</code> in a terminal and sign in with <code>/login</code>.
                  </p>
                )}
                {claude?.installed && claude.signedIn && (
                  <p className="text-xs text-muted-foreground">
                    Claude Code {claude.version}{claude.authMethod ? ` · ${claude.authMethod}` : ""}
                  </p>
                )}
                <div className="grid gap-4 border-t border-border pt-4 md:grid-cols-2">
                  <OptionSelect
                    id="claude-text-model"
                    label="Model"
                    value={claudeTextModel}
                    options={status.models.textOptions}
                    onChange={setClaudeTextModel}
                  />
                  <OptionSelect
                    id="claude-text-effort"
                    label="Effort"
                    value={claudeTextEffort}
                    options={status.models.effortOptions}
                    onChange={setClaudeTextEffort}
                  />
                </div>
              </div>

              <div className="space-y-3 rounded-lg border border-border bg-background/50 p-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <p className="text-base font-medium">Higgsfield: thumbnail images</p>
                    <p className="mt-1 text-sm text-muted-foreground">
                      Images are generated through Higgsfield's MCP server, driven by Claude Code. Each thumbnail spends Higgsfield credits.
                    </p>
                  </div>
                  <StatusBadge
                    state={higgsfieldConnected === true ? "ok" : higgsfieldConnected === false ? "warn" : "unknown"}
                    label={higgsfieldConnected === true ? "Connected" : higgsfieldConnected === false ? "Not connected" : "Not checked"}
                  />
                </div>
                <div className="flex flex-wrap items-center gap-3">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={handleTestConnection}
                    disabled={isTesting}
                    data-testid="button-test-higgsfield"
                  >
                    {isTesting ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Plug className="mr-2 h-4 w-4" />}
                    Test connection
                  </Button>
                  <span className="text-xs text-muted-foreground">
                    Runs a read-only balance check. It spends no credits.
                  </span>
                  {credits !== null && (
                    <span className="text-sm text-green-500" data-testid="text-higgsfield-credits">
                      {credits} credits available
                    </span>
                  )}
                </div>
                {testError && <p className="text-sm text-destructive">{testError}</p>}
                {higgsfieldConnected !== true && (
                  <p className="text-xs text-muted-foreground">
                    Connect it once with <code>{HIGGSFIELD_CONNECT_COMMAND}</code>, then run <code>/mcp</code> inside <code>claude</code> to sign in.
                  </p>
                )}
                <div className="grid gap-4 border-t border-border pt-4 md:grid-cols-2">
                  <OptionSelect
                    id="higgsfield-image-model"
                    label="Image model"
                    value={higgsfieldImageModel}
                    options={status.models.imageOptions}
                    onChange={handleImageModelChange}
                  />
                  <OptionSelect
                    id="higgsfield-image-quality"
                    label={selectedImageModel?.tierParam === "resolution" ? "Resolution" : "Quality"}
                    value={higgsfieldImageQuality}
                    options={(selectedImageModel?.tiers ?? []).map((tier) => ({ id: tier, label: tier, description: "" }))}
                    onChange={setHiggsfieldImageQuality}
                  />
                </div>
              </div>

              <div className="flex justify-end pt-2">
                <Button type="submit" disabled={isSaving || Boolean(loadError)} data-testid="button-save-api-settings">
                  {isSaving ? (
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  ) : (
                    <Save className="mr-2 h-4 w-4" />
                  )}
                  Save and apply
                </Button>
              </div>
            </form>
          )}
        </CardContent>
      </Card>

      <Card aria-labelledby="community-heading">
        <CardHeader>
          <CardTitle id="community-heading" className="text-lg">
            Join the community
          </CardTitle>
          <CardDescription>
            Connect with AI marketers, share what you learn, and get support.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3 sm:grid-cols-2">
          {COMMUNITIES.map((community) => (
            <a
              key={community.url}
              href={community.url}
              target="_blank"
              rel="noopener noreferrer"
              aria-label={`Join ${community.title}, ${community.tier}`}
              className="group flex min-w-0 items-center gap-3 rounded-lg border border-border bg-background/50 p-3 transition-colors hover:border-primary/40 hover:bg-accent/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              data-testid={`link-community-${community.id}`}
            >
              <CommunityMark colors={community.colors} />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium">
                  {community.title}
                </span>
                <span className="mt-0.5 block text-xs text-muted-foreground">
                  {community.tier}
                </span>
              </span>
              <ExternalLink
                aria-hidden="true"
                className="h-4 w-4 shrink-0 text-muted-foreground transition-colors group-hover:text-primary"
              />
            </a>
          ))}
        </CardContent>
      </Card>
    </div>
  );
}
````

- [ ] **Step 4: Run them and watch them pass**

Run: `npx tsx --test server/settings.test.ts server/settings-routes.test.ts server/security-contracts.test.ts shared/api-error-message.test.ts`
Expected: PASS.

- [ ] **Step 5: Gate and commit**

Run: `npm test 2>&1 | grep -E "ℹ (tests|pass|fail)" && npm run check`
Expected: `ℹ tests 146`, `ℹ pass 146`, `ℹ fail 0`; no `tsc` errors.

```bash
git add server/settings.ts server/settings.test.ts server/settings-routes.test.ts server/routes.ts server/security-contracts.test.ts server/test-fixtures/route-harness.ts shared/api-error-message.ts shared/api-error-message.test.ts client/src/pages/settings.tsx
git commit -m "Settings for Claude and Higgsfield, with a read-only connection test"
```

---

### Task 7: Switch text and thumbnails over, and Live check #1

**Files:**
- Modify: `server/ai.ts`, `server/routes.ts`, `server/provider-models.ts`, `client/src/pages/script.tsx`, `client/src/pages/research.tsx`, `client/src/components/controller-guide.tsx`, `server/thumbnail-contract.test.ts`, `server/ai-research.test.ts`
- Create: `server/ai-routes.test.ts`

**Interfaces:**
- Consumes: `claudeText` (Task 3); `logProviderFailure`, `ProviderError` (Task 2); `generateThumbnail`, `testHiggsfieldConnection` (Task 5); `readApiErrorBody` (Task 6).
- Produces: every text operation in `ai.ts` runs through `claudeText`; `ai.ts` no longer imports `@google/genai` or exports `generateThumbnail`/`configureGemini*`; `routes.ts` returns provider payloads (with `code`, `category`, `suggestion`) from all AI routes.

- [ ] **Step 1: Write the failing test**

Create `server/ai-routes.test.ts`:

````ts
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "node:test";
import { startRouteHarness, type RouteHarness } from "./test-fixtures/route-harness";

let harness: RouteHarness;

beforeEach(async () => {
  harness = await startRouteHarness();
});

afterEach(async () => {
  await harness.stop();
});

const titlesRequest = { topic: "Camera comparison", format: "Tutorial/How-to", audience: "General Audience" };

describe("text routes over the claude adapter", () => {
  test("regenerate-titles returns titles from a JSON reply", async () => {
    process.env.FAKE_CLAUDE_MODE = "results";
    process.env.FAKE_CLAUDE_RESULTS = JSON.stringify([JSON.stringify({ titles: ["One", "Two", "Three", "Four", "Five"] })]);
    const response = await harness.post("/api/script/regenerate-titles", titlesRequest);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { titles: ["One", "Two", "Three", "Four", "Five"] });
  });

  test("thumbnail suggestions accept a fenced reply and stay strict about everything else", async () => {
    process.env.FAKE_CLAUDE_MODE = "results";
    process.env.FAKE_CLAUDE_RESULTS = JSON.stringify(['```json\n["A","B","C","D","E"]\n```']);
    const response = await harness.post("/api/thumbnail/suggestions", { topic: "Camera comparison" });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { suggestions: ["A", "B", "C", "D", "E"] });
  });

  test("a signed-out Claude reaches the client with its own code and guidance, even on the legacy routes", async () => {
    process.env.FAKE_CLAUDE_MODE = "auth";
    const response = await harness.post("/api/script/regenerate-titles", titlesRequest);
    assert.equal(response.status, 401);
    const body = await response.json();
    assert.equal(body.code, "CLAUDE_NOT_SIGNED_IN");
    assert.equal(body.category, "invalid_key");
    assert.equal(body.retryable, false);
    assert.match(body.suggestion, /\/login/);
    assert.doesNotMatch(JSON.stringify(body), /Gemini|API key/);
  });

  test("a usage limit maps to 429 on a provider-payload route", async () => {
    process.env.FAKE_CLAUDE_MODE = "limit";
    const response = await harness.post("/api/thumbnail/suggestions", { topic: "Camera comparison" });
    assert.equal(response.status, 429);
    assert.equal((await response.json()).code, "CLAUDE_USAGE_LIMIT");
  });

  test("error payloads never echo the prompt", async () => {
    process.env.FAKE_CLAUDE_MODE = "failed";
    const response = await harness.post("/api/thumbnail/suggestions", { topic: "a very distinctive topic string" });
    assert.equal(response.status, 502);
    assert.doesNotMatch(await response.text(), /distinctive topic/);
  });

  test("narration extraction returns plain text and needs no JSON fence handling", async () => {
    process.env.FAKE_CLAUDE_MODE = "results";
    process.env.FAKE_CLAUDE_RESULTS = JSON.stringify(["Hello everyone. Today we compare two cameras."]);
    const response = await harness.post("/api/script/extract-narration", { scriptContent: "[00:00] Hello everyone. Today we compare two cameras." });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { narration: "Hello everyone. Today we compare two cameras." });
  });
});
````

- [ ] **Step 2: Run it and watch it fail**

Run: `env -u GEMINI_API_KEY npx tsx --test server/ai-routes.test.ts`
Expected: FAIL: the routes still call the Gemini SDK, so with no Gemini key they answer 503 or 500, not the values asserted. (`env -u` guarantees this run cannot reach the real Gemini API.)

- [ ] **Step 3: Apply the server edits**

Save each script below into `$PLAN_TMP` under the given name. Every edit inside must match exactly once. If a script throws, it may have partly edited its target: restore the file with `git checkout -- <file>`, find why the text differs, and re-run. Do not force a mismatched edit.

`$PLAN_TMP/task7-ai.mjs` removes the Gemini client and the Gemini thumbnail call, then swaps all seven text call sites, fixes the error-flattening `catch` blocks, and neutralizes the parser messages:

````js
import { readFileSync, writeFileSync } from "node:fs";
import { applyEdits } from "./apply-edits.mjs";

const AI = process.argv[2];

// 1. Drop the Gemini client, its configuration, and the Gemini thumbnail call (Higgsfield replaces it).
{
  let text = readFileSync(AI, "utf8");
  const cut = (startMarker, endMarker) => {
    const start = text.indexOf(startMarker);
    const end = text.indexOf(endMarker);
    if (start < 0 || end < start) throw new Error(`block not found: ${startMarker}`);
    text = text.slice(0, start) + text.slice(end);
  };
  cut("let geminiApiKey =", "function getFormatGuidelines(");
  cut("export async function generateThumbnail(", "export function buildThumbnailSuggestionsPrompt(");
  writeFileSync(AI, text);
}

// 2. Imports, then every text call site.
applyEdits(AI, [
  [`import { GoogleGenAI, Modality, ThinkingLevel } from "@google/genai";\n`, ``],

  [`import { normalizeProviderError, ProviderError } from "./provider-errors";
import {
  DEFAULT_GEMINI_IMAGE_MODEL,
  DEFAULT_GEMINI_TEXT_MODEL,
  getGeminiImageModelLabel,
  isGeminiImageModel,
  isGeminiTextModel,
  type GeminiImageModel,
  type GeminiTextModel,
} from "./provider-models";`,
   `import { claudeText } from "./claude-cli";
import { logProviderFailure, normalizeProviderError, ProviderError } from "./provider-errors";`],

  // --- generateScript ---
  [`export async function generateScript(input: ScriptInput): Promise<ScriptResult> {
  if (!geminiApiKey) {
    throw new Error("Gemini API key is not configured. Please set GEMINI_API_KEY environment variable.");
  }

  const formatGuidelines`,
   `export async function generateScript(input: ScriptInput): Promise<ScriptResult> {
  const formatGuidelines`],

  [`      const response = await ai.models.generateContent({
        model: geminiTextModel,
        contents: attempt === 0
          ? prompt
          : \`\${prompt}\\n\\nYour previous response failed validation: \${validationError}. Return a corrected strict JSON object only.\`,
        config: { responseMimeType: "application/json" },
      });
      try {
        parsed = parseScriptGenerationOutput(response.text || "");`,
   `      const responseText = await claudeText(
        attempt === 0
          ? prompt
          : \`\${prompt}\\n\\nYour previous response failed validation: \${validationError}. Return a corrected strict JSON object only.\`,
        { json: true },
      );
      try {
        parsed = parseScriptGenerationOutput(responseText);`],

  [`  } catch (error: any) {
    console.error("Gemini API error:", error);
    throw new Error(error.message || "Failed to generate script");
  }`,
   `  } catch (error: unknown) {
    logProviderFailure("Script generation", error);
    if (error instanceof ProviderError) throw error;
    throw new Error(error instanceof Error && error.message ? error.message : "Failed to generate script");
  }`],

  // --- generateIdeas ---
  [`): Promise<IdeaGenerationResponse> {
  if (!geminiApiKey) {
    throw new Error("Gemini API key is not configured. Please set GEMINI_API_KEY environment variable.");
  }

  validateEvidenceSourceIds`,
   `): Promise<IdeaGenerationResponse> {
  validateEvidenceSourceIds`],

  [`      const response = await ai.models.generateContent({
        model: geminiTextModel,
        contents: attempt === 0
          ? prompt
          : \`\${prompt}\\n\\nYour previous response failed validation: \${validationError}. Return a corrected strict JSON object only.\`,
        config: { responseMimeType: "application/json" },
      });
      try {
        parsed = parseIdeaGenerationOutput(response.text || "", request);`,
   `      const responseText = await claudeText(
        attempt === 0
          ? prompt
          : \`\${prompt}\\n\\nYour previous response failed validation: \${validationError}. Return a corrected strict JSON object only.\`,
        { json: true },
      );
      try {
        parsed = parseIdeaGenerationOutput(responseText, request);`],

  [`  } catch (error: any) {
    console.error("Gemini API error:", error);
    throw new Error(error.message || "Failed to generate ideas");
  }`,
   `  } catch (error: unknown) {
    logProviderFailure("Ideas generation", error);
    if (error instanceof ProviderError) throw error;
    throw new Error(error instanceof Error && error.message ? error.message : "Failed to generate ideas");
  }`],

  // --- research insights: parser messages ---
  [`message: "Gemini returned malformed research insight JSON."`, `message: "The AI returned malformed research insight JSON."`],
  [`message: "Gemini research insights did not match the required schema."`, `message: "The AI research insights did not match the required schema."`],
  [`message: "Gemini research insights reported the wrong sample size."`, `message: "The AI research insights reported the wrong sample size."`],
  [`message: "Gemini research evidence referenced the wrong snapshot."`, `message: "The AI research evidence referenced the wrong snapshot."`],
  [`message: "Gemini research evidence referenced an unknown source video."`, `message: "The AI research evidence referenced an unknown source video."`],

  // --- generateResearchInsights ---
  [`): Promise<ResearchInsightsResponse> {
  if (!geminiApiKey) {
    throw new ProviderError({
      message: "Gemini API key is not configured.",
      category: "missing_key",
      code: "AI_MISSING_KEY",
      status: 503,
      retryable: false,
    });
  }

  const { query, videos, snapshotId } = input;`,
   `): Promise<ResearchInsightsResponse> {
  const { query, videos, snapshotId } = input;`],

  [`    const response = await ai.models.generateContent({
      model: geminiTextModel,
      contents: prompt,
      config: {
        responseMimeType: "application/json",
        ...((geminiTextModel === "gemini-3.7-flash" || geminiTextModel === "gemini-3.1-pro-preview")
          ? { thinkingConfig: { thinkingLevel: ThinkingLevel.HIGH } }
          : {}),
      },
    });

    return parseResearchInsightsResponse(
      response.text || "",`,
   `    const responseText = await claudeText(prompt, { json: true });

    return parseResearchInsightsResponse(
      responseText,`],

  [`    console.error("Gemini API error:", error);
    throw normalizeProviderError(error, "ai");`,
   `    logProviderFailure("Research insights", error);
    throw normalizeProviderError(error, "ai");`],

  // --- regenerateTitles ---
  [`): Promise<string[]> {
  if (!geminiApiKey) {
    throw new Error("Gemini API key is not configured.");
  }

  if (evidenceContext) {
    validateEvidenceSourceIds(evidenceContext.evidenceClaims, evidenceContext.sourceVideoIds);
  }

  const prompt = \`You are a YouTube packaging editor.`,
   `): Promise<string[]> {
  if (evidenceContext) {
    validateEvidenceSourceIds(evidenceContext.evidenceClaims, evidenceContext.sourceVideoIds);
  }

  const prompt = \`You are a YouTube packaging editor.`],

  [`      const response = await ai.models.generateContent({
        model: geminiTextModel,
        contents: attempt === 0
          ? prompt
          : \`\${prompt}\\n\\nYour previous response failed validation: \${validationError}. Return corrected JSON only.\`,
        config: { responseMimeType: "application/json" },
      });
      try {
        const parsed = titleRegenerationOutputSchema.parse(JSON.parse(response.text || ""));`,
   `      const responseText = await claudeText(
        attempt === 0
          ? prompt
          : \`\${prompt}\\n\\nYour previous response failed validation: \${validationError}. Return corrected JSON only.\`,
        { json: true },
      );
      try {
        const parsed = titleRegenerationOutputSchema.parse(JSON.parse(responseText));`],

  [`  } catch (error: any) {
    console.error("Title regeneration error:", error);
    throw new Error(error.message || "Failed to regenerate titles");
  }`,
   `  } catch (error: unknown) {
    logProviderFailure("Title regeneration", error);
    if (error instanceof ProviderError) throw error;
    throw new Error(error instanceof Error && error.message ? error.message : "Failed to regenerate titles");
  }`],

  // --- generateScriptRegeneration (section and paragraph) ---
  [`): Promise<ScriptRegenerationOutput> {
  if (!geminiApiKey) {
    throw new ProviderError({
      message: "Gemini API key is not configured.",
      category: "missing_key",
      code: "AI_MISSING_KEY",
      status: 503,
      retryable: false,
    });
  }

  if (evidenceContext) {`,
   `): Promise<ScriptRegenerationOutput> {
  if (evidenceContext) {`],

  [`      const response = await ai.models.generateContent({
        model: geminiTextModel,
        contents: attempt === 0
          ? prompt
          : \`\${prompt}\\n\\nYour previous response failed validation: \${validationError}. Return corrected JSON only.\`,
        config: { responseMimeType: "application/json" },
      });
      try {
        return parseScriptRegenerationOutput(response.text || "", evidenceContext);`,
   `      const responseText = await claudeText(
        attempt === 0
          ? prompt
          : \`\${prompt}\\n\\nYour previous response failed validation: \${validationError}. Return corrected JSON only.\`,
        { json: true },
      );
      try {
        return parseScriptRegenerationOutput(responseText, evidenceContext);`],

  [`message: \`Gemini returned an invalid script revision after one repair attempt: \${validationError}\``,
   `message: \`The AI returned an invalid script revision after one repair attempt: \${validationError}\``],

  // --- thumbnail suggestions ---
  [`message: "Gemini returned malformed thumbnail suggestions JSON"`, `message: "The AI returned malformed thumbnail suggestions JSON"`],
  [`message: "Gemini returned thumbnail suggestions that did not match the schema"`, `message: "The AI returned thumbnail suggestions that did not match the schema"`],

  [`): Promise<string[]> {
  if (!geminiApiKey) {
    throw new Error("Gemini API key is not configured");
  }
  const prompt = buildThumbnailSuggestionsPrompt(request);

  try {
    const response = await ai.models.generateContent({
      model: geminiTextModel,
      contents: prompt,
    });

    return parseThumbnailSuggestions(response.text || "");`,
   `): Promise<string[]> {
  const prompt = buildThumbnailSuggestionsPrompt(request);

  try {
    const responseText = await claudeText(prompt, { json: true });

    return parseThumbnailSuggestions(responseText);`],

  // --- narration extraction ---
  [`export async function extractNarrationText(scriptContent: string): Promise<string> {
  if (!geminiApiKey) {
    throw new Error("Gemini API key is not configured");
  }

  const prompt`,
   `export async function extractNarrationText(scriptContent: string): Promise<string> {
  const prompt`],

  [`    const response = await ai.models.generateContent({
      model: geminiTextModel,
      contents: [{ role: "user", parts: [{ text: prompt }] }],
    });

    let text = response.candidates?.[0]?.content?.parts?.[0]?.text || "";
    text = text.trim();
`,
   `    let text = (await claudeText(prompt, { json: false })).trim();
`],

  [`  } catch (error: any) {
    console.error("Error extracting narration text:", error);
    throw new Error("Failed to extract narration text from script");
  }`,
   `  } catch (error: unknown) {
    logProviderFailure("Narration extraction", error);
    if (error instanceof ProviderError) throw error;
    throw new Error("Failed to extract narration text from script");
  }`],
]);
````

`$PLAN_TMP/task7-routes.mjs` deletes `getUserFriendlyError`, moves the three legacy routes to provider payloads, switches to code-only logging and neutral labels, and takes thumbnails from Higgsfield:

````js
import { readFileSync, writeFileSync } from "node:fs";
import { applyEdits } from "./apply-edits.mjs";

const ROUTES = process.argv[2];

// 1. Delete the legacy getUserFriendlyError helper (its three callers are converted below).
let text = readFileSync(ROUTES, "utf8");
const start = text.indexOf("function getUserFriendlyError(");
const end = text.indexOf("export async function registerRoutes(");
if (start < 0 || end < 0 || end < start) throw new Error("getUserFriendlyError block not found");
text = text.slice(0, start) + text.slice(end);
writeFileSync(ROUTES, text);

applyEdits(ROUTES, [
  [`import { normalizeProviderError, providerErrorPayload } from "./provider-errors";`,
   `import { logProviderFailure, normalizeProviderError, providerErrorPayload } from "./provider-errors";`],

  // 2. The three legacy routes now use the shared provider payload.
  [`      console.error("Script generation error:", error);
      if (error instanceof z.ZodError) {
        return res.status(400).json({ error: "Invalid script input", details: error.errors });
      }
      const friendly = getUserFriendlyError(error, "Script generation");
      res.status(500).json({ error: friendly.message, suggestion: friendly.suggestion });`,
   `      if (error instanceof z.ZodError) {
        return res.status(400).json({ error: "Invalid script input", details: error.errors });
      }
      logProviderFailure("Script generation", error);
      const providerError = normalizeProviderError(error, "ai");
      res.status(providerError.status).json(providerErrorPayload(providerError, "Script generation"));`],

  [`      console.error("Narration extraction error:", error);
      if (error instanceof z.ZodError) {
        return res.status(400).json({ error: "Invalid narration extraction request", details: error.errors });
      }
      const friendly = getUserFriendlyError(error, "Narration extraction");
      res.status(500).json({ error: friendly.message, suggestion: friendly.suggestion });`,
   `      if (error instanceof z.ZodError) {
        return res.status(400).json({ error: "Invalid narration extraction request", details: error.errors });
      }
      logProviderFailure("Narration extraction", error);
      const providerError = normalizeProviderError(error, "ai");
      res.status(providerError.status).json(providerErrorPayload(providerError, "Narration extraction"));`],

  [`      console.error("Title regeneration error:", error);
      if (error instanceof z.ZodError) {
        return res.status(400).json({ error: "Invalid title regeneration request", details: error.errors });
      }
      const friendly = getUserFriendlyError(error, "Title regeneration");
      res.status(500).json({ error: friendly.message, suggestion: friendly.suggestion });`,
   `      if (error instanceof z.ZodError) {
        return res.status(400).json({ error: "Invalid title regeneration request", details: error.errors });
      }
      logProviderFailure("Title regeneration", error);
      const providerError = normalizeProviderError(error, "ai");
      res.status(providerError.status).json(providerErrorPayload(providerError, "Title regeneration"));`],

  // 3. Code-only logging and provider-neutral labels on the routes that already used provider payloads.
  [`      console.error("Ideas generation error:", error);
      const providerError = normalizeProviderError(error, "ai");
      res.status(providerError.status).json(providerErrorPayload(providerError, "Gemini Ideas"));`,
   `      logProviderFailure("Ideas generation", error);
      const providerError = normalizeProviderError(error, "ai");
      res.status(providerError.status).json(providerErrorPayload(providerError, "Ideas generation"));`],

  [`      console.error("Research insights error:", error);
      const providerError = normalizeProviderError(error, "ai");
      res.status(providerError.status).json(providerErrorPayload(providerError, "Gemini research"));`,
   `      logProviderFailure("Research insights", error);
      const providerError = normalizeProviderError(error, "ai");
      res.status(providerError.status).json(providerErrorPayload(providerError, "Research insights"));`],

  [`      console.error("Section regeneration error:", error);
      const providerError = normalizeProviderError(error, "ai");
      res.status(providerError.status).json(providerErrorPayload(providerError, "Gemini section regeneration"));`,
   `      logProviderFailure("Section regeneration", error);
      const providerError = normalizeProviderError(error, "ai");
      res.status(providerError.status).json(providerErrorPayload(providerError, "Section regeneration"));`],

  [`      console.error("Paragraph regeneration error:", error);
      const providerError = normalizeProviderError(error, "ai");
      res.status(providerError.status).json(providerErrorPayload(providerError, "Gemini paragraph regeneration"));`,
   `      logProviderFailure("Paragraph regeneration", error);
      const providerError = normalizeProviderError(error, "ai");
      res.status(providerError.status).json(providerErrorPayload(providerError, "Paragraph regeneration"));`],

  [`      console.error("Thumbnail generation error:", error);
      const providerError = normalizeProviderError(error, "ai");
      res.status(providerError.status).json(providerErrorPayload(providerError, "Gemini image generation"));`,
   `      logProviderFailure("Thumbnail generation", error);
      const providerError = normalizeProviderError(error, "higgsfield");
      res.status(providerError.status).json(providerErrorPayload(providerError, "Thumbnail generation"));`],

  [`      console.error("Thumbnail suggestions error:", error);
      const providerError = normalizeProviderError(error, "ai");
      res.status(providerError.status).json(providerErrorPayload(providerError, "Gemini thumbnail suggestions"));`,
   `      logProviderFailure("Thumbnail suggestions", error);
      const providerError = normalizeProviderError(error, "ai");
      res.status(providerError.status).json(providerErrorPayload(providerError, "Thumbnail suggestions"));`],
]);

// 4. Thumbnails now come from Higgsfield.
applyEdits(ROUTES, [
  [`regenerateParagraph, generateThumbnail, generateThumbnailSuggestions`, `regenerateParagraph, generateThumbnailSuggestions`],
  [`import { testHiggsfieldConnection } from "./higgsfield-image";`, `import { generateThumbnail, testHiggsfieldConnection } from "./higgsfield-image";`],
]);
````

```bash
node "$PLAN_TMP/task7-ai.mjs" server/ai.ts
node "$PLAN_TMP/task7-routes.mjs" server/routes.ts
```

Remove the now-unused Gemini section from `server/provider-models.ts`: delete **everything above** the line `export const CLAUDE_TEXT_MODELS = [`, so the file starts with that line. Verify with `head -1 server/provider-models.ts` (it must print `export const CLAUDE_TEXT_MODELS = [`).

- [ ] **Step 4: Apply the client and test-title edits**

`$PLAN_TMP/task7-client.mjs` makes the client wording provider-neutral and lets the Script page show the server's own guidance:

````js
import { applyEdits } from "./apply-edits.mjs";

applyEdits("client/src/pages/script.tsx", [
  [`import { apiRequest } from "@/lib/queryClient";`,
   `import { apiRequest } from "@/lib/queryClient";
import { readApiErrorBody } from "@shared/api-error-message";`],
  [`  const message = error instanceof Error ? error.message : String(error || "");
  const normalized = message.toLowerCase();
  if (normalized.includes("quota")`,
   `  const message = error instanceof Error ? error.message : String(error || "");
  const serverGuidance = readApiErrorBody(message)?.suggestion;
  if (serverGuidance) return serverGuidance;
  const normalized = message.toLowerCase();
  if (normalized.includes("quota")`],
  [`return "Gemini usage is temporarily limited. Wait for the provider window to reset, then retry.";`,
   `return "AI usage is temporarily limited. Wait for your usage window to reset, then retry.";`],
  [`return "Gemini could not authenticate. Check the configured key in Settings, then retry.";`,
   `return "The AI could not sign in. Check the Claude sign-in in Settings, then retry.";`],
  [`return "Gemini took too long to respond. Your current script is unchanged. Retry when ready.";`,
   `return "The AI took too long to respond. Your current script is unchanged. Retry when ready.";`],
  [`return "Gemini returned an unsafe or malformed revision. Your current script is unchanged. Retry to request a corrected response.";`,
   `return "The AI returned an unsafe or malformed revision. Your current script is unchanged. Retry to request a corrected response.";`],
]);
applyEdits("client/src/pages/research.tsx", [
  [`case "missing_key": return "Gemini API key required";`, `case "missing_key": return "AI setup required";`],
  [`case "invalid_key": return "Gemini API key was rejected";`, `case "invalid_key": return "AI sign-in needs attention";`],
  [`case "quota": return "Gemini quota is unavailable";`, `case "quota": return "AI usage limit reached";`],
  [`case "timeout": return "Gemini took too long to respond";`, `case "timeout": return "The AI took too long to respond";`],
]);
applyEdits("client/src/components/controller-guide.tsx", [
  [`description: "Connect local API keys and choose the Gemini text and image models.",`,
   `description: "Connect YouTube, check the Claude sign-in, and choose the text and image models.",`],
]);
````

`$PLAN_TMP/task7-tests.mjs` updates two existing tests that still mention Gemini:

````js
import { applyEdits } from "./apply-edits.mjs";

applyEdits("server/thumbnail-contract.test.ts", [[`      model: "gemini-3-pro-image",`, `      model: "gpt_image_2_5",`]]);
applyEdits("server/ai-research.test.ts", [[`describe("Gemini research response validation", () => {`, `describe("research response validation", () => {`]]);
````

```bash
node "$PLAN_TMP/task7-client.mjs"
node "$PLAN_TMP/task7-tests.mjs"
```

- [ ] **Step 5: Run the tests and watch them pass**

Run: `npx tsx --test server/ai-routes.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 6: Gate and commit**

Run: `npm test 2>&1 | grep -E "ℹ (tests|pass|fail)" && npm run check && npm run build 2>&1 | tail -3`
Expected: `ℹ tests 152`, `ℹ pass 152`, `ℹ fail 0`; no `tsc` errors; the build finishes (`dist/index.cjs` is written).

```bash
git add -A
git commit -m "Run text generation through claude and thumbnails through Higgsfield"
```

- [ ] **Step 7: Live check #1 (uses Claude plan usage: ask the operator before running)**

**Ask the operator for a go-ahead first.** One Research Insights call took about 55-62 s at `--effort low` when the design was verified; it counts against their Claude plan.

Run: `npm run live:claude -- text`
Expected on success: `claude: {"installed":true,"signedIn":true,...}`, then `Research Insights returned valid output in NN.N s (budget 120 s)` with `claims=9 questions=6 actions=3`, and exit code 0.

Show the printed summary to the operator. The fixture is synthetic, so this proves structure and latency, **not** insight quality: say so, and suggest they judge quality on a real Research run in the app.

If it fails: `CLAUDE_NOT_SIGNED_IN` means run `claude` and `/login`; `CLAUDE_TIMEOUT` or a time over 120 s means report the timing and try `CLAUDE_TEXT_EFFORT=low` explicitly before concluding anything.

---

### Task 8: Remove the remaining Gemini pieces and update the docs

**Files:**
- Modify: `package.json`, `package-lock.json`, `.env.example`, `README.md`, `CONTRIBUTING.md`, `PORTING.md`, `SECURITY.md`, `HANDOFF.md`

- [ ] **Step 1: Remove the dependency**

Run: `npm uninstall @google/genai`
Expected: `package.json` and `package-lock.json` no longer mention `@google/genai`.

Run: `grep -c "google/genai" package.json; grep -c "node_modules/@google/genai" package-lock.json`
Expected: `0` and `0`.

- [ ] **Step 2: Replace `.env.example`**

````bash
# Required for YouTube search (Research page).
# Google Cloud Console: enable "YouTube Data API v3", create an API key.
YOUTUBE_API_KEY=

# AI features run through your local Claude Code sign-in: run `claude` and use /login.
# No Claude API key is used, and ANTHROPIC_API_KEY is removed from the claude child process.
# Optional overrides, also editable in Settings (defaults shown):
CLAUDE_TEXT_MODEL=sonnet
CLAUDE_TEXT_EFFORT=low
# CLAUDE_BIN=/path/to/claude
# CLAUDE_MAX_CONCURRENCY=3

# Thumbnail images are generated through Higgsfield's MCP server, driven by Claude Code.
# Connect it once, then run /mcp inside `claude` to sign in:
#   claude mcp add --transport http higgsfield https://mcp.higgsfield.ai/mcp
HIGGSFIELD_IMAGE_MODEL=gpt_image_2_5
HIGGSFIELD_IMAGE_QUALITY=medium

# Optional: HTTP port, defaults to 5000.
PORT=5000

# Optional: bind address, defaults to loopback. Do not set 0.0.0.0 without a
# trusted authentication and rate-limiting gateway. Local Settings is not a
# public secret-management endpoint.
HOST=127.0.0.1
````

- [ ] **Step 3: Update the documentation**

`$PLAN_TMP/task8-docs.mjs` edits `README.md`, `CONTRIBUTING.md`, `PORTING.md`, `SECURITY.md` and `HANDOFF.md`, and adds the README note that old `GEMINI_*` variables are ignored. Save it and run it from the repo root:

````js
import { applyEdits } from "./apply-edits.mjs";

applyEdits("README.md", [
  ["It combines public YouTube Data API v3 records with Gemini analysis while keeping API keys on the server.",
   "It combines public YouTube Data API v3 records with Claude analysis, run through your local Claude Code sign-in, while keeping keys on the server."],

  ["2. **AI Insights**: Gemini analyzes the exact active research snapshot.",
   "2. **AI Insights**: Claude analyzes the exact active research snapshot."],

  ["- A Gemini API key for Insights, Ideas, scripts, and thumbnails.",
   "- Claude Code, signed in (run `claude`, then `/login`), for Insights, Ideas, scripts, and thumbnail suggestions. No Claude API key is used.\n"
   + "- Higgsfield connected to Claude Code for thumbnail images: `claude mcp add --transport http higgsfield https://mcp.higgsfield.ai/mcp`, then `/mcp` inside `claude` to sign in. Each thumbnail spends Higgsfield credits."],

  ["| `GEMINI_API_KEY` | Gemini text and image generation | Required for AI features |\n"
   + "| `GEMINI_TEXT_MODEL` | Research, Ideas, Script, and regeneration model | `gemini-3.7-flash` |\n"
   + "| `GEMINI_IMAGE_MODEL` | Thumbnail generation model | `gemini-3.1-flash-image` |",
   "| `CLAUDE_TEXT_MODEL` | Research, Ideas, Script, and regeneration model (`sonnet` or `opus`) | `sonnet` |\n"
   + "| `CLAUDE_TEXT_EFFORT` | Claude effort level (`low`, `medium`, `high`) | `low` |\n"
   + "| `HIGGSFIELD_IMAGE_MODEL` | Thumbnail image model | `gpt_image_2_5` |\n"
   + "| `HIGGSFIELD_IMAGE_QUALITY` | Quality tier, or resolution for `seedream_v5_pro` | `medium` |\n"
   + "| `CLAUDE_BIN` | Path to the `claude` executable | `claude` |\n"
   + "| `CLAUDE_MAX_CONCURRENCY` | Maximum simultaneous `claude` processes (1-16) | `3` |"],

  ["- Billable YouTube and Gemini routes: 10 requests",
   "- Billable YouTube and AI routes: 10 requests"],

  ["Gemini image outputs include Google's invisible SynthID provenance. The application does not add a visible watermark and does not claim SynthID can be disabled.",
   "Thumbnail images come from the selected Higgsfield model, so any provenance metadata depends on that model. The application adds no visible watermark."],

  ["- Google Gemini through `@google/genai`",
   "- Claude Code (`claude -p`) for text and Higgsfield's MCP server for thumbnail images"],

  ["Gemini limits and pricing vary by model and account. Check the current official documentation before changing models or making the server remotely accessible:",
   "Claude usage counts against your Claude plan, and Higgsfield generations spend Higgsfield credits (a 16:9 medium-quality `gpt_image_2_5` image was 1 credit when this was written). Check the current official documentation before changing models or making the server remotely accessible:"],

  ["- [Gemini pricing](https://ai.google.dev/pricing)\n- [Gemini image generation and SynthID](https://ai.google.dev/gemini-api/docs/image-generation)\n",
   ""],
]);

applyEdits("CONTRIBUTING.md", [
  ["The automated suite uses fixtures and mocks. It must not spend YouTube or Gemini quota.",
   "The automated suite uses fixtures and a fake `claude` executable. It must not spend YouTube quota, Claude usage, or Higgsfield credits. Live checks are opt-in: `npm run live:claude -- text`, and `npm run live:claude -- image --spend` (about 1-2 Higgsfield credits per image)."],
]);

applyEdits("PORTING.md", [
  ["- Evidence and AI backend: `server/ai.ts`, `shared/evidence-contracts.ts`, and `server/script-regeneration-contract.ts`.",
   "- Evidence and AI backend: `server/ai.ts`, `server/claude-cli.ts`, `shared/evidence-contracts.ts`, and `server/script-regeneration-contract.ts`."],

  ["- Thumbnail backend: `server/thumbnail-contract.ts`, `server/provider-models.ts`, and the Thumbnail routes in `server/routes.ts`.",
   "- Thumbnail backend: `server/thumbnail-contract.ts`, `server/higgsfield-image.ts`, `server/media-guard.ts`, `server/provider-models.ts`, and the Thumbnail routes in `server/routes.ts`."],

  ["- Keep Google credentials on the server.",
   "- Keep credentials out of the repository and the browser. Claude and Higgsfield authenticate through the local Claude Code sign-in, so the server depends on a local `claude` login and must not be deployed remotely without replacing that transport. The YouTube key stays in the server environment."],

  ["- `PUT /api/settings/api-keys`\n",
   "- `PUT /api/settings/api-keys`\n- `POST /api/settings/test-higgsfield`\n"],
]);

applyEdits("SECURITY.md", [
  ["- YouTube and Gemini keys remain in the server environment.",
   "- The YouTube key remains in the server environment. Claude and Higgsfield use the local Claude Code sign-in, and the server removes `ANTHROPIC_API_KEY` from the `claude` child environment."],
]);

applyEdits("HANDOFF.md", [
  ["- `server/ai.ts`: active Gemini text and image operations.",
   "- `server/ai.ts`: text operations (prompts, parsers, repair loops) that call `server/claude-cli.ts`.\n"
   + "- `server/claude-cli.ts`: the only place that spawns `claude` (isolated text profile, Higgsfield MCP profile, error classification).\n"
   + "- `server/higgsfield-image.ts` and `server/media-guard.ts`: thumbnail generation through Higgsfield, plus the guarded media download and upload."],
]);

applyEdits("README.md", [
  ["The Settings page exposes the server allowlist and its current descriptions.",
   "Upgrading from the Gemini version: `GEMINI_*` variables in an existing `.env` are no longer used. They are ignored, not deleted, so you can remove them.\n\nThe Settings page exposes the server allowlist and its current descriptions."],
]);
````

```bash
node "$PLAN_TMP/task8-docs.mjs"
```

- [ ] **Step 4: The final gate**

Run: `grep -rn -i "gemini\|genai" server client shared | grep -v -E "security-contracts.test.ts|provider-models.test.ts|ai-routes.test.ts|settings-routes.test.ts" || echo "(none)"`
Expected: `(none)`. The four excluded files hold intentional regression assertions (an old `geminiTextModel` key is rejected; an old Gemini model id is ignored; error payloads never say Gemini; the status has no `gemini` field).

Run: `npm test 2>&1 | grep -E "ℹ (tests|pass|fail)" && npm run check && npm run build 2>&1 | tail -3`
Expected: `ℹ tests 152`, `ℹ pass 152`, `ℹ fail 0`; no `tsc` errors; the build finishes.

Run: `git status --short && git log --oneline main..HEAD`
Expected: a clean tree; the commits of Tasks 1-8 on top of the spec commit.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "Remove @google/genai and update the docs for Claude and Higgsfield"
```

- [ ] **Step 6: Report to the operator**

Summarize: the eight commits, the test count, both live-check results (or that they were declined), any hosts added to the guard allowlist, and the deferred denylist. Remind them that `docs/launch-video/*` and the two Gemini reference links in `docs/YOUTUBE_RESEARCH_PLAYBOOK.md` were left alone on purpose, and that nothing was pushed.
