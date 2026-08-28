# Sandora Agent CLI

![Sandora Agent CLI](assets/sandora-agent-cli.png)

**Sandora Agent CLI** is a terminal-first autonomous coding and research agent. The MVP uses pinned Pi 0.84.3 behind Sandora-owned session, event, tool, and TUI contracts; a native runtime remains available as a controlled fallback.

> **Status:** Active MVP development. The public CLI is usable for local coding and research workflows; browser tools use optional Chromium/CDP, while direct computer-use tools fail closed when no Windows adapter is available.

## What it can do

- Read, search, create, edit, and delete files in the current workspace
- Run PowerShell commands, builds, tests, and development tools
- Inspect errors, repair failures, and test again
- Review Git status, diffs, history, and branches
- Commit, push, and assist with pull-request workflows when requested
- Delegate up to four parallel read-only exploration or review tasks
- Run explicitly named writable workers in isolated, recoverable Git worktrees
- Preserve session context through Sandora's JSONL session store
- Show live activity such as `THINKING`, `READING`, `SEARCHING`, `EDITING`, `TESTING`, `SUBAGENTS`, `COMMITTING`, `PUSHING`, `ABORTING`, and `COMPLETE`

## Private Sandora model preview

**Sandora 2.5 9B Computer Use** is currently being evaluated privately and is not publicly available.

Interested in early access? [Open a Private Model Access request](https://github.com/kyoo-147/SandoraAgent-CLI/issues/new?title=Private%20Model%20Access) and briefly describe your intended use case.

The displayed model name is currently a product label. The public MVP uses an OpenAI-compatible provider.

## Quick start

Requirements: Node.js 22.19.0 or newer and npm.

```bash
git clone https://github.com/kyoo-147/SandoraAgent-CLI.git
cd SandoraAgent-CLI
npm ci
npm start
```

The default Pi core reads model credentials and model configuration from `~/.pi/agent/auth.json` and `~/.pi/agent/models.json`. Use Pi's normal login/configuration flow before starting Sandora. The default delegated-worker model is `openai-codex/gpt-5.6-luna` at medium thinking; override it with `SANDORA_WORKER_PROVIDER` and `SANDORA_WORKER_MODEL` only when required.

The independent native fallback remains selectable for fixture testing or controlled migration work:

```powershell
$env:SANDORA_AGENT_CORE="native"
$env:OPENAI_API_KEY="..."
$env:OPENAI_BASE_URL="https://api.openai.com/v1"
$env:OPENAI_MODEL="gpt-4o-mini"
npm start
```

## Multi-provider support

Sandora is not locked to a single model vendor. Any OpenAI-compatible chat-completions endpoint can be configured with `OPENAI_BASE_URL`, `OPENAI_MODEL`, and `OPENAI_API_KEY`.

Credentials remain on the user's machine and are not stored in this repository.

### Local plugins

Place explicitly trusted plugins under `.sandora/plugins/<id>` and enable them with a comma-separated `SANDORA_PLUGINS=id-one,id-two`. Sandora discovers one `sandora.plugin.json` (or `plugin.json`) per immediate child, validates API version 1 declarations, activates enabled plugins transactionally, injects declared tool contributions into both runtimes, and disposes active plugins with their session. Undeclared or colliding contributions fail closed. A manifest may pin its entry file with `integrity: { "algorithm": "sha256", "digest": "…" }`; Sandora verifies that entry before import. This optional entry checksum does not cover transitive imports or turn trusted plugins into sandboxed code.

The native runtime can select an enabled provider contribution with `SANDORA_PROVIDER_PLUGIN=<provider-name>`; provider factories must return Sandora's streaming provider contract. Pi providers continue to use Pi `ModelRuntime` and reject plugin-provider injection. Plugins execute as trusted local code with the user's permissions—they are an extension boundary, not a sandbox.

## How it works

Pinned `@earendil-works/pi-coding-agent@0.84.3` provides the default model loop and append-only session engine. Sandora confines it behind `src/runtime/pi-agent-session.mjs`, disables Pi's unrestricted built-in mutation/shell tools, and supplies workspace-scoped coding, Git, browser, and delegation tools. Pi sessions persist under `.sandora/pi-sessions`.

Set `SANDORA_AGENT_CORE=native` to use Sandora's independent fallback runtime and `.sandora/session.jsonl` store. A session never mixes the two runtime formats. If restart recovery finds an assistant tool call without a durably recorded result, native recovery appends a synthetic ambiguous-failure tool result rather than resuming an invalid transcript or claiming the external effect did not occur.

New native records use the canonical `sandora.event/v1` envelope with schema version, unique event and stream identities, strict sequence ordering, structured actor, correlation, canonical event type, and bounded redacted payload. Replay accepts legacy native records without rewriting them, maps legacy event names in memory, rejects foreign streams or duplicate identities, and serializes cross-process appends through a fail-closed file lock. Each appended record is file-fsynced before publication; directory-entry power-loss guarantees remain platform-dependent. Native restart also rejects a different model or system-prompt hash rather than silently changing model context. Pi sessions remain in their separate pinned-Pi format.

Native turns additionally persist correlated per-request lifecycle, deduplicated usage, assistant start and UTF-8-safe 4 KiB delta batches, and tool intent before execution. Restart classifies unmatched model, assistant, and started-tool boundaries as `UNKNOWN_AFTER_RESTART` without replaying them. Explicit `session.close()` waits for active cancellation to settle before recording one intentional `session.closed`; crashes never fabricate that closure.

Optional native byte budgets (`maxContextBytes` plus reserved response headroom) compact the model-visible projection before every provider request using deterministic `native-context/v1` whole-turn selection. System instructions and the newest complete turn remain pinned, tool-call/result groups are never split, and a bounded `context.compacted` event records source range, retained event IDs, counts, algorithm, and context hash before activation. Restart validates that provenance and reconstructs the same projection while preserving the full append-only history for audit and display. Token counts remain explicit UTF-8 byte-based estimates, not provider-tokenizer claims.

The parent agent remains responsible for planning, synthesis, integration, testing, review, and Git delivery. Read-only delegation is bounded to four concurrent tasks. Writable workers receive separate Git worktrees under `.sandora/worktrees`; dirty or unintegrated work is preserved, and integration is disabled unless `SANDORA_ALLOW_WORKER_INTEGRATION=1` grants explicit runtime authority.

The generic `SandoraAgentManager` accepts an optional shared `leaseRoot` for file-based task fencing. It atomically assigns one owner/fence token, serializes same-owner transitions with an exclusive lock, writes fsync-backed dispatch/terminal records, rejects concurrent or expired owners, and reports ambiguous ownership as `RECONCILE_REQUIRED` instead of replaying work. Explicit reconciliation installs a new fence and terminal resolution; it never automatically takes over side effects. This coordinates manager ownership only; external side effects still require their own idempotency.

Read-only native and Pi delegation also persist a normalized run manifest and fsync-backed task transitions under `.sandora/tasks/runs`, paired with leases under `.sandora/tasks/leases`. Completed results and cancellation state can be restored without replay; a task found `running` after restart becomes `RECONCILE_REQUIRED` and is not executed automatically. This is local crash recovery, not distributed scheduling, artifact-integrity proof, or exactly-once execution.

## Commands

Type `/` in the CLI to open command completion.

```text
/help       Show help
/tools      Show enabled capabilities
/status     Show agent and model status
/session    Show session and workspace information
/clear      Clear the current view
/quit       Exit Sandora
```

Additional commands support explanation, comparison, evidence review, research briefs, critique, summarization, and translation.

## Headless JSONL transport

`npm run jsonl` exposes the same Sandora session and normalized events over newline-delimited JSON for automation. Standard output contains protocol envelopes only; diagnostics use standard error.

```json
{"id":"run-1","type":"prompt","text":"Inspect this repository"}
{"id":"status-1","type":"status"}
{"id":"history-1","type":"history"}
{"id":"abort-1","type":"abort"}
{"id":"shutdown-1","type":"shutdown"}
```

Every output envelope includes `protocol: "sandora-jsonl"`, `version: 1`, a monotonic sequence, a correlated request ID, and a `ready`, `accepted`, `event`, `response`, or `fatal` kind. Only one prompt may be active; duplicate IDs and overlapping runs fail closed.

## Safety

Sandora is designed to work autonomously inside the selected workspace. Workspace tools enforce path and symlink checks, child processes receive a filtered environment, and `workspace_shell` runs one allowlisted development command directly without shell composition, expansion, redirection, absolute paths, or parent traversal. Commits require a feature branch and explicit paths, and force pushes are not exposed.

Package installation/execution commands such as `npm exec`, `pnpm dlx`, and package mutation are unavailable. Running repository-defined package scripts (`npm test`, `npm run …`, and equivalents) requires explicit `SANDORA_ALLOW_PACKAGE_SCRIPTS=1` authority because package manifests regain arbitrary project-code execution.

Sandora writes one provider-neutral, fsync-backed tool-control record per call under `.sandora/receipts/<session-id>/`. Exclusive creation atomically claims a call identity across store instances and processes; sealed records preserve canonical input hashes, authority/enforcement status, bounded result or error hashes, and terminal outcome without raw arguments or outputs. Duplicate, colliding, malformed, or previously-started ambiguous identities fail closed rather than automatically replaying possible side effects. These are application-level audit receipts, not OS-sandbox, hostile-filesystem integrity, power-loss-proof directory transactions, or exactly-once external-side-effect proof.

Local merge and pull-request merge capabilities are disabled by default. Grant them explicitly with `SANDORA_ALLOW_LOCAL_MERGE=1` or `SANDORA_ALLOW_PR_MERGE=1`. PR merge also requires a non-draft mergeable PR with successful checks; allowing a PR with no checks additionally requires `SANDORA_ALLOW_UNCHECKED_PR_MERGE=1`.

When `SANDORA_REQUIRE_APPROVALS=1` is set, consequential authority operations additionally require a matching, explicit approval decision stored under `.sandora/approvals/`. Decisions bind the exact tool input hash and authority variable, expire, and consume atomically with bounded uses; malformed, stale, denied, or replayed decisions fail closed. Headless clients may send `approval_create` and `approval_list` JSONL requests. This is application-level approval bookkeeping, not prompt enforcement, an OS sandbox, or an exactly-once guarantee.

Browser navigation pins the requested origin and refuses cross-origin redirects, links, observations, and tab switches by default. Grant an intentional cross-origin transition with `SANDORA_ALLOW_BROWSER_CROSS_ORIGIN=1`; consequential submit/send/delete/pay actions separately require `SANDORA_ALLOW_BROWSER_SUBMIT=1`.

Launching without an endpoint creates and reports an `anonymous-ephemeral` browser profile owned by the Sandora session. Connecting to `SANDORA_CDP_URL` or an explicit CDP endpoint is treated as an existing, potentially signed-in profile and requires separate `SANDORA_ALLOW_EXISTING_BROWSER_PROFILE=1` authority; it is reported as `authorized-existing` and Sandora closes only its CDP connection rather than killing the external browser. Session disposal cleans all browser connections and verifies removal of profiles it launched.

File upload requires a fresh observed `input[type=file]` ref, a bounded regular file physically contained in the workspace, and `SANDORA_ALLOW_BROWSER_UPLOAD=1`. Sandora hashes and stages the selected bytes in a session-owned temporary snapshot so later workspace replacement cannot alter the browser's selected file. Anonymous owned sessions keep downloads in an isolated temporary directory and consume completed CDP download events in start order; retaining a completed download uses exclusive workspace artifact creation and separately requires `SANDORA_ALLOW_BROWSER_DOWNLOAD_RETAIN=1`. Session disposal removes owned upload snapshots and temporary downloads. Sandora does not claim automatic content redaction for uploaded or downloaded files.

The parent process runs with the permissions of the current user. Use a container or OS sandbox when stronger isolation is required. Worker restrictions in this MVP are application-level, not a security boundary.

## Development

```bash
npm run check
npm test
npm run qa
npm run qa:deps
```

`npm run qa` is the deterministic local QA harness. It runs syntax checks, fixture
streaming/tool/error and session-recovery E2E tests, bounded plugin/swarm checks,
and a child-process cleanup smoke test. Optional real Pi/provider tests run with `SANDORA_PI_E2E=1`; real browser coverage requires `SANDORA_BROWSER_PATH` or `SANDORA_CDP_URL`. CI performs a clean `npm ci` first and
runs the high-severity production dependency scan.

## Current limitations

- Direct computer-use control requires a future Windows adapter; browser tools can launch Chromium or connect to an authorized CDP endpoint, use short-lived observed element refs, reject stale refs, and gate consequential clicks
- The Sandora model remains in private evaluation
- Read-only subagents are limited to four concurrent tasks; writable workers require isolated Git worktrees and explicit integration authority
- Provider credentials are not required for the fixture-based QA harness
- Shell and browser confinement are application-level; use an OS sandbox for hostile repositories

## Acknowledgements

The broader terminal-agent ecosystem provides useful design references:

- [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)
- [OpenAI Codex CLI](https://github.com/openai/codex)
- [Google Gemini CLI](https://github.com/google-gemini/gemini-cli)
- [Grok Build](https://github.com/xai-org/grok-build)
- [Kimi Code CLI](https://github.com/MoonshotAI/kimi-code)
- [Kimi CLI](https://github.com/MoonshotAI/kimi-cli)

Sandora-specific branding, interface, launcher, and integrations are maintained in this repository.

Pi is used as an attributed, pinned runtime dependency for the MVP: [Pi coding agent](https://github.com/earendil-works/pi).

### Sandora plugin manifest V1

Target manifests use `schemaVersion: 1`, `id`, `version`, `engine.sandora`, `entry`, `provides`, `requires`, `permissions`, `configurationSchema`, and optional `integrity`. The current engine is `0.1.0`; exact, wildcard, `^`, `~`, comparison, AND, and OR ranges are checked before the entry is imported. Legacy `api: 1` manifests remain supported unchanged.

Manifest permissions are authorization upper bounds, not grants. Applications pass explicit per-plugin grants through `pluginPermissionGrants`; terminal/headless launches may use strict JSON such as `SANDORA_PLUGIN_PERMISSION_GRANTS='{"my-plugin":["tools.register"]}'`. A target plugin requesting an ungranted or unknown permission is rejected before import. Target activation receives an additive context (`pluginId`, immutable `services`, `events`, `config`, capability query/list snapshots, and `register(disposable)`) alongside the legacy contribution registration methods. Context views are read-only and contribution cleanup is reverse-order and idempotent. Plugin code remains trusted local code with the user's OS permissions; these declarations restrict Sandora-provided APIs but are not a sandbox. Process isolation, marketplace support, and service supervision are intentionally out of scope.
