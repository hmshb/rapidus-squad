# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A Slack bot ("Casey", on the "Rapidus Squad") that routes Slack messages into long-lived `claude` CLI subprocesses. Each Slack thread is bound to one persistent process so conversation context stays warm across turns. Casey's identity and guardrails are injected via `--append-system-prompt` from `src/casey-prompt.ts`.

This is **not** a wrapper around `@anthropic-ai/claude-code` (the SDK). The SDK was deliberately ripped out — we spawn `claude.exe` / `claude` directly with `--input-format stream-json --output-format stream-json` and shuttle JSON lines over stdio. See commit `b5c7044` for context.

## Commands

```bash
npm run dev      # tsx watch — hot reload, dev loop
npm run start    # tsx — run once without watch
npm run build    # tsc → dist/
npm run prod     # node dist/index.js
```

There is no test suite, no linter, and no formatter configured. Don't fabricate one.

Postgres is **required** at startup — `src/db.ts` throws if `DATABASE_URL` is unset. `migrate()` runs on every boot and is idempotent (`CREATE TABLE IF NOT EXISTS`).

## Architecture

### Process model

```
Slack event ──► SlackHandler ──► ClaudeHandler ──► ClaudeProcess (long-lived child)
                                       │                  ▲
                                       └──► WarmPool ─────┘  (pre-spawned, bound on demand)
```

- **`ClaudeProcess`** (`src/claude-process.ts`) wraps one `claude` subprocess. It stays alive across turns. `streamTurn(content)` writes one user message to stdin and yields stream-JSON messages until a `result` event terminates the turn. One turn at a time per process (`busy` flag).
- **`WarmPool`** (`src/process-pool.ts`) keeps N (default 2, `CASEY_WARM_POOL_SIZE`) idle processes pre-spawned against `config.defaultWorkingDirectory`, to skip the ~5–8s Windows cold start. Acquire is cwd-matched: a warm process is only handed out if its cwd matches the requested cwd. After acquisition, the pool refills in the background.
- **`ClaudeHandler.acquireProcess`** picks in priority order: existing bound process for the session → warm pool (only if no `resumeSessionId`) → cold spawn. An idle bound process is reaped after 30 min (`BOUND_IDLE_MAX_MS`).
- Env vars **stripped before spawn** (`ENV_VARS_TO_STRIP`): `CLAUDECODE`, `CLAUDE_CODE_*`, `ANTHROPIC_API_KEY`. The first set prevents Claude Code from recursing into itself when this process is itself launched under Claude Code; the API key is stripped so the child falls back to `~/.claude` OAuth credentials (subscription auth) instead of a possibly-stale env key.

### Session identity

A "session" is keyed by `${userId}-${channelId}-${threadTs || 'direct'}`. Two layers:

1. **Our session row** (`sessions` table) — maps the session key to a `claude` `session_id` returned in the `system/init` stream event. Used to resume after a process crash or restart.
2. **The bound process** (`bound: Map<sessionKey, ClaudeProcess>`) — in-memory only. A bound process is the live channel for that thread; if it dies, the next message cold-spawns and `--resume`s using the persisted `session_id`.

When `SlackHandler.handleMessage` runs in a new thread, `threadTs` is falsy on the root message, so it uses `ts` instead. Re-read `slack-handler.ts:198` if you change session keying — it's load-bearing.

### Persistence

Two tables, created in `src/db.ts`:

- **`sessions`** — session_key, user/channel/thread, last known claude `session_id`, last_activity.
- **`working_directories`** — `config_key` is `channelId` (channel default), `channelId-threadTs` (thread override), or `channelId-userId` for DMs. Lookup priority in `WorkingDirectoryManager.getWorkingDirectory`: thread > channel/DM > `DEFAULT_WORKING_DIRECTORY` env fallback.

On startup, `SlackHandler.hydrate()` re-loads both into memory in parallel. After that, writes are fire-and-forget (`pool.query(...).catch(log)`) — we don't await DB writes on the hot path.

### Slack streaming UX

`SlackHandler.handleMessage` does three concurrent things that all target the same Slack thread:

1. **A status message** (`🤔 Thinking` → `⚙️ Working` → `✅ Task completed`), edited via `chat.update`. `animateThinking` animates the dots until the first stream event arrives.
2. **A growing text message** built from `content_block_delta` events (only when `--include-partial-messages` is on, default unless `CASEY_DISABLE_STREAMING=true`). Throttled to ~1.4 updates/sec (`scheduleStreamFlush`). Finalized on `content_block_stop`, then a fresh message starts on the next text block. `streamedTexts` set deduplicates against the full `assistant` message that arrives later.
3. **Tool-use messages** posted as separate messages with custom formatters per tool (`formatEditTool`, `formatBashTool`, etc.). `TodoWrite` is special-cased — its output is suppressed and routed through `TodoManager` into a single edited "task list" message.

A reaction emoji on the user's original message tracks overall state: `thinking_face` → `gear` → progress emoji (from todos) → `white_check_mark` / `x` / `black_square_for_stop`. `updateMessageReaction` removes the previous one before adding the new one.

`activeControllers` lets a new message in the same thread abort an in-flight turn (`AbortController.abort()` → `proc.kill()` → bound process is dropped).

### Casey system prompt

`src/casey-prompt.ts` exports `CASEY_SYSTEM_PROMPT` and is appended to claude's built-in system prompt on every spawn. **Every token in there is paid every turn** — keep it tight. It defines Casey's identity, scope (currently the "persona module"), and hard guardrails (no touching `backend/app/auth/`, migrations, Stripe, workflows, `.env*`, `main`).

### Permission MCP

`src/permission-mcp-server.ts` (referenced by `slack-handler.ts:9`) backs `approve_tool` / `deny_tool` Slack action buttons. If you're wiring up tool permission prompts, the resolve path is `permissionServer.resolveApproval(approvalId, allow)`.

## Environment

Required: `SLACK_BOT_TOKEN`, `SLACK_APP_TOKEN`, `SLACK_SIGNING_SECRET`, `DATABASE_URL`.

Casey-specific knobs:

- `CASEY_MODEL` — default `claude-sonnet-4-5`. Passed to `--model`.
- `CASEY_WARM_POOL_SIZE` — default 2. Set 0 to disable warm pool.
- `CASEY_DISALLOWED_TOOLS` — default `NotebookEdit,NotebookRead,WebSearch`. Comma-separated, passed to `--disallowedTools`.
- `CASEY_DISABLE_STREAMING=true` — drops `--include-partial-messages`, falls back to whole-message posting.
- `CLAUDE_BIN` — override path to the `claude` binary. Otherwise resolved by walking `PATH` (`claude.exe` / `claude.cmd` / `claude` on Windows).
- `BASE_DIRECTORY` — lets users say `cwd project-name` instead of an absolute path.
- `DEFAULT_WORKING_DIRECTORY` — used by the warm pool, and as a final fallback when no channel/thread has a cwd set.

## Platform notes

- **Windows**: the dev environment is Windows 11 + PowerShell. `claudeBin` resolution prefers `claude.exe` then `claude.cmd`. When the resolved binary is `.cmd` or `.bat`, `ClaudeProcess` sets `shell: true` so cmd-script wrappers (like npm-installed shims) work — this is the only path that uses a shell, and matters for argv quoting.
- The repo path is `D:\Workspace\ai-employee`. Paths in Slack `cwd` commands are normalized through `path.resolve`.

## Things not to do

- Don't reintroduce the `@anthropic-ai/claude-code` SDK — `claude` CLI is the integration surface now.
- Don't `await` DB writes on the message hot path. `persistSession` / `persist` are intentionally fire-and-forget.
- Don't change session keying without grepping for `getSessionKey` — `bound`, `activeControllers`, `todoMessages`, `originalMessages`, `currentReactions`, `activeAnimations` all key off the same string.
- Don't add `--permission-mode` casually; Casey runs without one and the permission MCP server is how approvals flow back through Slack.
