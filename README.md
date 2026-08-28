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

`src/plugins/host.mjs` provides an independent, local plugin host. It discovers one
`sandora.plugin.json` (or `plugin.json`) per immediate child directory, validates
API version 1 manifests, and safely skips malformed entries. Enabled plugins may
register `tools`, `providers`, `agents`, `commands`, `services`, and `hooks` via
`PluginHost`; activation is transactional and `disable()` disposes registrations.
Contribution names collide fail-closed with built-in and already-active names.

## How it works

Pinned `@earendil-works/pi-coding-agent@0.84.3` provides the default model loop and append-only session engine. Sandora confines it behind `src/runtime/pi-agent-session.mjs`, disables Pi's unrestricted built-in mutation/shell tools, and supplies workspace-scoped coding, Git, browser, and delegation tools. Pi sessions persist under `.sandora/pi-sessions`.

Set `SANDORA_AGENT_CORE=native` to use Sandora's independent fallback runtime and `.sandora/session.jsonl` store. A session never mixes the two runtime formats.

The parent agent remains responsible for planning, synthesis, integration, testing, review, and Git delivery. Read-only delegation is bounded to four concurrent tasks. Writable workers receive separate Git worktrees under `.sandora/worktrees`; dirty or unintegrated work is preserved, and integration is disabled unless `SANDORA_ALLOW_WORKER_INTEGRATION=1` grants explicit runtime authority.

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

## Safety

Sandora is designed to work autonomously inside the selected workspace. Workspace tools enforce path and symlink checks, child processes receive a filtered environment, destructive shell patterns fail closed, commits require a feature branch and explicit paths, and force pushes are not exposed.

Local merge and pull-request merge capabilities are disabled by default. Grant them explicitly with `SANDORA_ALLOW_LOCAL_MERGE=1` or `SANDORA_ALLOW_PR_MERGE=1`. PR merge also requires a non-draft mergeable PR with successful checks; allowing a PR with no checks additionally requires `SANDORA_ALLOW_UNCHECKED_PR_MERGE=1`.

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

- Direct computer-use control requires a future Windows adapter; browser tools can launch Chromium or connect via `SANDORA_CDP_URL`
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
