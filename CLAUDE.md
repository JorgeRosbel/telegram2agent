# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

`@ariaskit/telegram2agent` is a TypeScript library that bridges Telegram to AI coding agent CLIs (Claude Code and OpenCode). `createBot(config)` spawns a grammY Telegram bot that forwards chat messages to a local `claude` or `opencode` CLI subprocess, streams the response back into Telegram (editing the message in place), and handles permission approvals, background tasks, and file delivery. Package manager is **pnpm** (pinned via `packageManager` in package.json — don't use npm/yarn).

## Commands

```sh
pnpm install
pnpm run verify          # lint + typecheck + test:run + build — run before considering work done
pnpm test                # vitest watch mode
pnpm run test:run        # vitest run once (CI mode)
pnpm vitest run test/claude.test.ts   # run a single test file
pnpm run typecheck        # tsc --noEmit
pnpm run lint             # eslint .
pnpm run format            # prettier --write
pnpm run build             # tsdown -> dist/ (esm + .d.mts)
pnpm run watch              # tsdown --watch
pnpm run example            # build then run examples/quickstart.ts
pnpm run example:dev         # build then run examples/dev-assistant.ts
pnpm run gen:models           # regenerate src/agents/opencode-models.generated.ts from `opencode models`
```

`prepublishOnly` runs `verify`. Husky + lint-staged run eslint/prettier on staged files at commit time.

## Architecture

### Request flow

`src/index.ts` (`createBot`) wires together the pieces below into a grammY `Bot`:

1. `src/bot/telegram.ts` (`createTelegramBot`) registers all commands/handlers (`/model`, `/agent`, `/mode`, `/effort`, `/config`, `/tasks`, `/status`, `/cancel`, `/file`, plain text, photos/documents, `!shell` commands, and callback-query buttons). It is the largest file and the place to look first for behavior questions.
2. Every update is filtered by an allowlist middleware (`bot.use`) against `config.allow` (chat IDs or `@username`) — anything outside it is dropped **before** reaching any handler. This is the primary security boundary.
3. A plain-text message resolves the active `AgentAdapter` (`ClaudeAdapter` or `OpencodeAdapter`, keyed by `AgentName` in `src/agents/types.ts`) and calls `adapter.run(options)`, which spawns the underlying CLI (`claude -p --output-format stream-json …` or `opencode run --format json …`) via `src/agents/spawn.ts#spawnProcess`.
4. Each adapter parses the CLI's NDJSON stdout into a common shape (`ParsedClaudeEvent` / equivalent for OpenCode) and streams partial text/thinking back through `options.onText` / `options.onThinking`, which `src/bot/streaming.ts` (`StreamEditor`) throttles into Telegram `editMessageText` calls.
5. Sensitive tool use (bash, file writes) triggers a `PermissionRequest`; `src/tasks/approvals.ts` (`ApprovalBridge`) turns this into an inline-keyboard message with ✅/❌ buttons and resolves (or auto-denies after `approvalTimeoutMs`, default 120s) back into the adapter's stdin control-response protocol.
6. Long-running/background work goes through `src/tasks/registry.ts` (`TaskRegistry`) — tracked via `/tasks`, `/status <id>`, `/cancel <id>`, and notifies the originating chat on completion. The programmatic API (`bot.run()`/`bot.runStep()` in `src/index.ts`) shares this same path (`launchTask`) so background tasks get session continuity and completion notifications identically to interactive chat; `runStep` just wraps `launchTask` in a promise so steps can be `await`-chained.
7. Persistent per-chat defaults (active agent, model, mode, effort, session IDs for `--resume`) live in `src/state/store.ts` (`StateStore`), backed by a JSON file at `dbPath` (default `<cwd>/.telegram2agent.json`). All three entry points (`ask`, `run`/`runStep`, interactive chat) read _and_ write `store.sessionFor/setSession(chatId, agent)` — that's what keeps them on the same conversation thread.

### Agent adapters (`src/agents/`)

Both `ClaudeAdapter` (`claude.ts`) and `OpencodeAdapter` (`opencode.ts`) implement the common `AgentAdapter` interface (`types.ts`): `listModels()` and `run(options): RunHandle` where `RunHandle` exposes `result(): Promise<RunResult>` and `cancel()`. Internally each:

- Builds CLI args from `RunOptions` via a pure, exported function (`buildClaudeArgs`, analogous for opencode) — these are unit-tested directly without spawning a process.
- Spawns the CLI with `spawnProcess`, writes the prompt as an initial stdin line (stream-json protocol), and parses stdout line-by-line into a common event shape via another pure exported function (`parseClaudeEvent`).
- Enforces its own timeout (`AdapterOptions.timeoutMs`, default 30 min) and kills the process tree on cancel/timeout.
- `mode: "plan"` maps to read-only permission mode; `mode: "edit"` (default) allows changes, either with human-in-the-loop approval (`onPermission` callback wired to `ApprovalBridge`) or `acceptEdits`/`--auto` if no approver is connected. `autoMode: true` (config-level, threaded through `createBot`) skips the approval bridge entirely and forces `bypassPermissions`/`autoApprove` instead.
- `ClaudeAdapter.run()` retries automatically (indefinitely, every `usageLimitRetryMs`, default 10 min) when the CLI's own text signals the Claude _plan's_ usage limit was hit (`isUsageLimitError`, matches the literal `"usage limit reached"` phrase from the CLI — confirmed against the compiled binary, not from public docs). Any other failure (auth, timeout, agent bug) fails immediately as before; the wait is cancellable via the same `RunHandle.cancel()`/`task.cancel()` path. `onUsageLimitWait` fires once per wait so callers (interactive chat, `launchTask`) can notify the chat without spamming it every retry.

Keep the "pure function builds CLI args/parses events" + "thin class spawns the process" split when touching either adapter — it's what makes them testable without invoking real binaries.

### File delivery protocol

Agents can't send Telegram messages/attachments directly. `FILE_PROTOCOL_INSTRUCTION` (in `claude.ts`, mirrored for opencode) is appended to every prompt telling the agent to end its response with `FILE: /absolute/path` lines. `src/agents/spawn.ts#extractFileRefs` parses these out, and `src/bot/media.ts` resolves/validates the path (must stay within `cwd`, guarding against `../` traversal) before sending via `sendPhoto`/`sendDocument`.

### Shell passthrough

Messages starting with `!` are treated as raw shell commands (`src/bot/shell.ts`), executed in `cwd` with the same trust level as an agent in edit mode. Gated by `shellEnabled` (default true) and `shellTimeoutMs` (default 5 min); output truncated to ~3500 chars; tracked in the task registry like any other task.

### Output formatting

`src/bot/format.ts` converts agent markdown into Telegram-safe HTML (`toTelegramHtml`/`sanitizeForTelegram`) and defines `TELEGRAM_FORMAT_INSTRUCTION`, appended as a system prompt so agents produce Telegram-compatible formatting without the user needing to ask for it.

### Generated code

`src/agents/opencode-models.generated.ts` is generated by `scripts/gen-opencode-models.mjs` from the real `opencode models` CLI output — regenerate with `pnpm gen:models` rather than hand-editing.

## Testing conventions

Tests live in `test/*.test.ts` (vitest) and mirror `src/` file names. The adapters are tested by calling their exported pure functions (`buildClaudeArgs`, `parseClaudeEvent`, `parseOpencodeModels`, etc.) directly with fixture strings rather than spawning real CLIs — follow this pattern for new adapter logic.
