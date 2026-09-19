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

  test("an empty allowlist still produces a deny-everything profile", () => {
    const args = buildMcpArgs({ model: "sonnet", effort: "low", allowedTools: [], maxTurns: 3, resume: "s" });
    assert.equal(args[args.indexOf("--permission-mode") + 1], "dontAsk");
    assert.equal(args[args.indexOf("--tools") + 1], "");
    assert.equal(args[args.indexOf("--allowedTools") + 1], "");
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
