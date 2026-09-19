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
