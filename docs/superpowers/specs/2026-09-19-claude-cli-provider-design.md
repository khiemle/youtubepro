# Design: Replace Gemini with `claude -p` (text) and Higgsfield MCP (thumbnails)

- **Date:** 2026-09-19
- **Status:** Draft for review (design sections 1-3 were approved in conversation)
- **Branch:** `claude-cli-provider` (local only; nothing is pushed)
- **Applies to:** this repository, a local clone of `AgriciDaniel/youtubepro` (Apache-2.0)

## 1. Goal and scope

Run every AI feature of YouTube Pro through the operator's existing local Claude Code login instead of a Gemini API key.

- **Text** (Research Insights, Ideas, Script, title/section/paragraph regeneration, thumbnail suggestions, narration extraction) goes through `claude -p`.
- **Thumbnail images** go through Higgsfield's MCP server, driven by a locked-down `claude -p` session. Reference-image uploads are kept.
- Gemini is removed entirely (no fallback provider, `@google/genai` dropped).

**Non-goals**

- Remote or multi-user deployment. The Claude login and Higgsfield account are per-operator; Settings stays local-only.
- Cancelling `claude` children when the browser disconnects (children finish or hit their timeout).
- Higgsfield's unlimited allowance: `use_unlim` is always `false`.
- API-key-billed Claude usage: `ANTHROPIC_API_KEY` is scrubbed from the child environment (4.3), so the operator must be signed in to Claude Code.
- Nano Banana or any Gemini fallback. Google Search grounding (the current code never used it).
- A direct MCP client inside the app (rejected alternative, see 3).
- Persisting generated image URLs across requests.
- Editing `docs/launch-video/*` (upstream promotional material).

## 2. Evidence

Measured on 2026-09-19 with Claude Code 2.1.278 on macOS. Throwaway probe code lived outside the repo.

| Question | Result |
|---|---|
| Can `claude -p` be the transport for the real code path? | The repo's unmodified `generateResearchInsights` ran with only the network boundary swapped. Its own validation (9 claims, 6 questions, 3 actions, sample size, snapshot id, source video ids) passed 6/6 on Sonnet. Fixture: synthetic 12-video snapshot, so output *quality* was not evaluated. |
| Latency | Sonnet, default effort: 138.0 / 186.5 / 138.1 / 158.0 s, 13.5-18.4k output tokens. Sonnet, `--effort low`: 55.4 / 62.4 s, about 5.9k tokens. |
| JSON hygiene | Sonnet output parsed as raw JSON 6/6. One Haiku run (at `xhigh`, unintended) was valid but wrapped in markdown fences and took 210 s; one Haiku run at default effort exceeded the 240 s probe cap. Haiku is not offered. |
| Local-setup leak | A plain `claude -p` "reply OK" consumed about 26.3k input tokens (hooks, plugins, skills, MCP). With the isolation flags in 4.2 it consumed 427. |
| Auth | The claude.ai subscription login works with the isolation flags. `--bare` does not (it never reads OAuth or the keychain). |
| Higgsfield reachability | `higgsfield` is registered in `~/.claude.json` only as a project-scoped http server for other checkouts, so it is invisible from this repo. Passing it inline (`--mcp-config` plus `--strict-mcp-config`) from this repo returned the account balance, reusing the stored login. |
| MCP session overhead | About 51.6k tokens of tool schemas per session (allowlisting does not hide tools); a 2-turn Haiku call took 5.2 s and cost $0.11 API-equivalent. |
| Higgsfield image model | `gpt_image_2_5` supports 16:9, reference images (role `image_references`), quality `low`..`max`. Medium quality, 1k, 16:9 preflights at 1 credit. `gpt_image_2` and `seedream_v5_pro` also support 16:9 and references. A search for "Nano Banana" returned nothing. |
| Headless spend rule | Without an explicit `use_unlim`, the tool may return `unlim_choice` and submit nothing. Runs must always pass `use_unlim: false`. |

Reference implementation: the operator's `book-video-studio` project already drives Higgsfield through isolated `claude -p` sessions (`backend/engine/steps/hf_mcp.py`, `backend/engine/claude_step.py`). Its patterns are ported here, not imported. It never passes reference images through the MCP, so that part is new.

## 3. Key decisions

1. **Both text and images use the `claude` CLI.** A direct MCP client in Node was rejected: it needs a second OAuth login and token storage, while the studio project proves the CLI pattern.
2. **Gemini is removed, not kept as a fallback.**
3. **Reference images are kept.** They need `media_upload`, a byte PUT, and `media_confirm`; see 5.3.
4. **Text default is `sonnet` at `--effort low`**; `opus` is selectable.
5. **No automatic re-ask on invalid JSON for text.** It surfaces as `invalid_response` with the existing retry button.
6. **Error categories and the response shape are unchanged** (`{error, code, category, retryable, suggestion}`); only `code` and `suggestion` vary.
7. **Fences are stripped in the transport**, never in the parsers, so the strict parsers and their tests are untouched.

## 4. Architecture

### 4.1 Modules

| File | Change | Responsibility |
|---|---|---|
| `server/claude-cli.ts` | new | The only place that spawns `claude`. Two profiles (4.2), env scrubbing, concurrency cap, timeouts, envelope parsing, error classification. |
| `server/ai.ts` | renamed from `gemini.ts` | The text operations (7 call sites) and their prompt builders/parsers. Calls `claudeText()` instead of the Gemini SDK. |
| `server/higgsfield-image.ts` | new | `generateThumbnail()` with the same signature and `data:` URL return as today, plus the guarded download/upload helpers. |
| `server/provider-models.ts` | renamed from `gemini-models.ts` | Claude text models and efforts; static Higgsfield image-model table (id, label, description, quality tiers). |
| `server/provider-errors.ts` | modified | Contexts `youtube \| claude \| higgsfield`; optional `suggestion` on `ProviderError`. |
| `server/settings.ts`, `server/routes.ts` | modified | See 8. |
| `script/live-claude-check.ts` | new | Opt-in live acceptance (11). Not part of `npm test`. |

Text calls: `json: true` for the 5 calls that set `responseMimeType` today plus thumbnail suggestions (its parser expects a JSON array); `json: false` for narration extraction.

### 4.2 Invocation profiles

Always explicit `--model` and `--effort`; prompt on **stdin**, never argv; child `cwd` is a dedicated empty temp directory so no project files or `CLAUDE.md` are discovered.

**Text profile** (fully isolated):

```
claude -p --model <sonnet|opus> --effort <low|medium|high> --output-format json
  --tools "" --setting-sources "" --disable-slash-commands --strict-mcp-config
  --no-session-persistence --system-prompt "<neutral>"
```

**MCP profile** (Higgsfield runs, least privilege per run):

```
claude -p --model sonnet --effort low --output-format json --max-turns 12
  --mcp-config '{"mcpServers":{"higgsfield":{"type":"http","url":"https://mcp.higgsfield.ai/mcp"}}}'
  --strict-mcp-config --allowedTools "<tools for this run>" --permission-mode dontAsk
  --tools "" --setting-sources "" --disable-slash-commands --system-prompt "<neutral>"
```

The server name `higgsfield` and its URL are constants: that pair is what worked with the operator's stored login. The connection test overrides the model with `--model haiku`. MCP runs keep session persistence so one `--resume` re-ask ("out of turns, answer now" or "reply again with only the required JSON") can rescue a job whose credits are already spent. Per-run tool allowlists: connection test `balance`; upload `media_upload`; generate `media_confirm`, `generate_image_batch`, `jobs_wait` (no-reference thumbnails omit `media_confirm`). A denylist of the other Higgsfield tools is applied if live check #2 shows it shrinks the ~51.6k-token overhead without breaking calls.

### 4.3 Process rules

- **Env scrub:** the child environment drops `ANTHROPIC_API_KEY` (a stray key would silently move billing off the subscription), `CLAUDE_EFFORT`, `CLAUDECODE`, `CLAUDE_PID`, and the parent-session variables `CLAUDE_CODE_ENTRYPOINT`, `CLAUDE_CODE_EXECPATH`, `CLAUDE_CODE_SESSION_ID`, `CLAUDE_CODE_SESSION_ATTENDED`, `CLAUDE_CODE_CHILD_SESSION`, `CLAUDE_CODE_MESSAGING_SOCKET`, `CLAUDE_CODE_MESSAGING_TOKEN` (all observed leaking from a parent Claude Code session). Other variables pass through, including `PATH`, `HOME` and any other `CLAUDE_CODE_*` such as an OAuth token used for authentication.
- **Concurrency:** at most `CLAUDE_MAX_CONCURRENCY` (default 3) children; FIFO queue; a request waits at most 30 s, then fails with `CLAUDE_BUSY`.
- **Timeouts:** text 180 s, each image run 300 s. On timeout: SIGTERM, then SIGKILL after 5 s.
- **Fence stripping:** for `json: true` calls, one wrapping ```` ```json ```` fence is removed before parsing. Never applied to plain-text calls.
- **Logging:** codes only, never envelopes, prompts or result bodies.

## 5. Data flow

### 5.1 Text
Route -> `ai.ts` builds the existing prompt -> `claudeText(prompt, {json, model, effort})` -> text profile -> envelope `result` -> fence strip (if `json`) -> the existing parser and Zod schemas -> the existing response.

### 5.2 Thumbnail without references
Route -> `generateThumbnail()` -> MCP run with `generate_image_batch` (one job: model params, prompt, `aspect_ratio: "16:9"`, `use_unlim: false`, `count: 1`) and `jobs_wait` polling -> structured reply `{"status":"ok","url":...}` -> URL guard (6) -> download -> `data:` URL in the existing response.

### 5.3 Thumbnail with references
1. **Run U** (`media_upload`): asks for upload URLs for the decoded references. The server validates each upload URL with the guard, then PUTs the bytes itself. Nothing has been submitted or spent yet.
2. **Run G** (`media_confirm`, `generate_image_batch`, `jobs_wait`): confirms the uploads, generates with `medias: [{value, role: "image_references"}]`, polls, replies with the URL.
3. Guard, download, `data:` URL as in 5.2.

References stay in memory only: never written to disk, never placed in prompts, never logged. Existing input limits (PNG/JPEG data URLs, 12 MB decoded total) are unchanged.

Job shape follows the `generate_image` parameters as used by the studio's `hf_mcp.py`. Whether batch jobs accept `medias`, and the exact `media_upload`/`media_confirm` response fields, are verified in live check #2 (11); the adapter's parsing of them is written from captured fixtures.

## 6. Error handling and security

Classification reads the CLI result envelope (`is_error`, `api_error_status`, `terminal_reason`) and, for MCP runs, a structured reply (`{"status":"error","reason":"UNAVAILABLE|NO_CREDITS|BLOCKED|OTHER"}`). The existing message-text classifier is only a safety net.

| Situation | category | code | status | retryable |
|---|---|---|---|---|
| CLI not found (ENOENT) | `missing_key` | `CLAUDE_NOT_INSTALLED` | 503 | no |
| Signed out / auth error | `invalid_key` | `CLAUDE_NOT_SIGNED_IN` | 401 | no |
| Usage/spend/rate limit, overloaded | `quota` | `CLAUDE_USAGE_LIMIT` | 429 | yes |
| Queue wait exceeded | `quota` | `CLAUDE_BUSY` | 429 | yes |
| Our timeout | `timeout` | `CLAUDE_TIMEOUT` | 504 | yes |
| Other non-zero exit / envelope error | `provider_server` | `CLAUDE_FAILED` | 502 | yes |
| Text output fails parser/schema | `invalid_response` | `AI_<OPERATION>_INVALID_*` (existing parser codes, renamed) | 502 | no |
| Higgsfield tools missing / auth needed | `missing_key` | `HIGGSFIELD_NOT_CONNECTED` | 503 | no |
| Insufficient credits | `quota` | `HIGGSFIELD_NO_CREDITS` | 402 | no |
| Blocked or no image produced | `invalid_response` | `HIGGSFIELD_NO_IMAGE` | 502 | no |
| Structured reply `reason: OTHER` | `provider_server` | `HIGGSFIELD_FAILED` | 502 | yes |
| Upload or download HTTP failure (after 3 in-request tries for download) | `network` | `HIGGSFIELD_UPLOAD_FAILED` / `HIGGSFIELD_DOWNLOAD_FAILED` | 502 | yes |
| URL rejected by guard, wrong type, too large | `invalid_response` | `HIGGSFIELD_BAD_MEDIA` | 502 | no |
| No usable reply after the one re-ask (out of turns or unparseable) | `timeout` | `HIGGSFIELD_INCOMPLETE` | 504 | no (credits may be spent; suggestion says to check Higgsfield generations) |

`ProviderError` gains an optional `suggestion`, which `providerErrorPayload` prefers over the per-category default, so each code carries exact guidance (for example `CLAUDE_NOT_SIGNED_IN`: run `claude` in a terminal, then `/login`). The client keeps its "Open Settings" button for `missing_key` and `invalid_key`.

**URL guard** (applies to result URLs and upload URLs, which come from model text): `https:` only; hostname must match `HIGGSFIELD_MEDIA_HOST_SUFFIXES` (initially `.higgsfield.ai`; live check #2 records the real hosts and the constant is extended before the check passes); no IP literals or private/loopback resolution; downloads capped at 25 MB with a PNG/JPEG/WebP magic-byte check.

**Prompt-injection posture:** prompts contain operator-typed and YouTube-derived text. Text runs have no tools at all. MCP runs run under `dontAsk` with a per-run allowlist, so a manipulated session can at worst call that run's Higgsfield tools, bounded by `--max-turns`.

## 7. Client copy and docs

- Hard-coded "Gemini" strings become provider-neutral, because the server's `suggestion` carries specifics: `research.tsx` (4 headlines), `script.tsx` (4 messages), `controller-guide.tsx` (1 line).
- README, HANDOFF, PORTING (including the new route), SECURITY, CONTRIBUTING and `.env.example` are updated. Old `GEMINI_*` lines in an existing `.env` are ignored, not deleted.

## 8. Settings and status contract

`PUT /api/settings/api-keys` keeps its URL, local-only guard, strict Zod and owner-only `.env` writes. New payload:

```
{ youtubeApiKey?, claudeTextModel?, claudeTextEffort?, higgsfieldImageModel?, higgsfieldImageQuality? }
```

- **Text models:** `sonnet` (default), `opus`. **Effort:** `low` (default), `medium`, `high`.
- **Image models** (static table): `gpt_image_2_5` (default), `gpt_image_2`, `seedream_v5_pro`. Each entry names its tier parameter and allowed tiers; `higgsfieldImageQuality` must be one of the selected model's tiers. `gpt_image_2_5` and `gpt_image_2` use `quality` (`low`, `medium`, `high`; default `medium`); `seedream_v5_pro` uses `resolution` (`1k`, `1.5k`, `2k`; default `2k`). Unknown model ids or tiers are rejected.
- **Env keys:** `YOUTUBE_API_KEY`, `CLAUDE_TEXT_MODEL`, `CLAUDE_TEXT_EFFORT`, `HIGGSFIELD_IMAGE_MODEL`, `HIGGSFIELD_IMAGE_QUALITY`. Env-only: `CLAUDE_BIN` (default `claude`), `CLAUDE_MAX_CONCURRENCY`.

`GET /api/settings/status` keeps `models.image` and `models.imageOptions` in the same shape (the Thumbnail page reads them unchanged). `gemini: boolean` becomes `claude: {installed, signedIn, authMethod, version?}` from `claude --version` and `claude auth status` (no model call, cached about 30 s). Higgsfield reports `not checked` until **Test connection**.

New route `POST /api/settings/test-higgsfield` (local-only, rate-limited): one Haiku run calling `balance`; returns `{connected, credits}`; spends no credits. The last successful result or thumbnail marks Higgsfield `connected` in memory.

The Settings page's Gemini block becomes a Claude row (sign-in status, model, effort) and a Higgsfield row (Test connection with balance, model, quality), with one-time connect instructions (`claude mcp add higgsfield https://mcp.higgsfield.ai/mcp`, then authenticate).

## 9. Testing

The `node:test` runner is unchanged, and no automated test makes a live provider call (HANDOFF rule).

- **Unit:** envelope parsing and error classification from canned envelopes; fence-stripping table (raw, fenced, fenced with trailing text, prose plus JSON rejected); exact argv snapshots for both profiles; env scrubbing; the parsers still reject markdown-wrapped input.
- **Fake `claude` script** (`server/test-fixtures/fake-claude.mjs`, selected with `CLAUDE_BIN`): success, non-zero exit with envelope, garbage output, hang (process is killed), ENOENT, concurrency cap and queue timeout.
- **Higgsfield flow** against the fake plus a local HTTP server: PNG round-trip into the `data:` URL contract; bad host, type or size rejected; download retry; each structured error maps to its code; uploaded bytes exactly equal the decoded references; no generate run after a failed upload.
- **Contract:** error payload shape unchanged; no prompt text or env values in payloads or logs; the settings schema stays strict, bounded and allowlisted; fixtures that hard-code Gemini model strings are updated.

## 10. Rollout and acceptance

Each step ends green on `npm test`, `npm run check` and `npm run build`.

1. Pure rename `gemini*` to neutral names, and error codes `GEMINI_*` to `AI_*`; still Gemini-backed.
2. Add `claude-cli.ts` and its fake-CLI tests; no callers yet.
3. Swap the 7 text calls and the text half of Settings. **Live check #1.**
4. Add `higgsfield-image.ts`, swap `generateThumbnail`, image half of Settings, Test connection. **Live check #2.**
5. Remove `@google/genai` and Gemini env; update client copy and docs.

**Done when:** all automated checks pass; `@google/genai` is gone from `package.json` and the lockfile; no `Gemini` strings remain in `server/`, `client/` or `shared/` outside the README migration note; live checks #1 and #2 pass.

## 11. Live checks (opt-in, run only with the operator's go-ahead)

- **#1 (Claude only):** `script/live-claude-check.ts` runs Research Insights on a fixture. Pass: valid on first try, wall time under 120 s at `--effort low`.
- **#2 (spends credits, about 1-2 per image):** one thumbnail without references and one with a reference. Pass: both return a valid image `data:` URL; Test connection reports the balance. Also records: the real result and upload hosts (guard constant), the `media_upload`/`media_confirm` response shapes (fixtures), whether batch jobs accept `medias`, and the session overhead with and without the denylist.

**Fallbacks if #2 fails.** If the two-run upload proves unworkable, stop and ask the operator before dropping reference images. If model transcription of long signed URLs proves unreliable, switch image runs to `--output-format stream-json --verbose` and read URLs from tool results instead of the final reply.

## 12. Risks

- **CLI flag drift.** Flags are confined to `claude-cli.ts` and tested against 2.1.278; the status endpoint shows the installed version.
- **Plan usage.** Each Research Insights call was about $0.06-0.08 API-equivalent at `low`; on a subscription this counts against plan limits, not a bill. Image sessions carry about 51.6k tokens of tool schemas each unless the denylist helps.
- **Latency.** Research Insights takes about 1 minute at `low`; `medium`/`high` are slower and untested.
- **Quality.** Output quality was not evaluated (synthetic fixture); it needs a look on real data during live check #1.
- **Unverified table entries.** Live check #2 exercises only the default image model; `gpt_image_2` and `seedream_v5_pro` are selectable but unverified until first use.
