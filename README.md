# Sandora Agent CLI

![Sandora Agent CLI](assets/sandora-agent-cli.png)

**Sandora Agent CLI** is a terminal-first autonomous coding and research agent built on Sandora's native runtime. It can inspect a repository, edit files, run commands and tests, recover from failures, use Git, and delegate focused work to parallel subagents.

> **Status:** Active MVP development. The public CLI is usable for local coding and research workflows; browser tools use optional Chromium/CDP, while direct computer-use tools fail closed when no Windows adapter is available.

## What it can do

- Read, search, create, edit, and delete files in the current workspace
- Run PowerShell commands, builds, tests, and development tools
- Inspect errors, repair failures, and test again
- Review Git status, diffs, history, and branches
- Commit, push, and assist with pull-request workflows when requested
- Delegate up to four parallel read-only exploration or review tasks
- Preserve session context through Sandora's JSONL session store
- Show live activity such as `THINKING`, `RUNNING`, `TYPING`, and `COMPLETE`

## Private Sandora model preview

**Sandora 2.5 9B Computer Use** is currently being evaluated privately and is not publicly available.

Interested in early access? [Open a Private Model Access request](https://github.com/kyoo-147/SandoraAgent-CLI/issues/new?title=Private%20Model%20Access) and briefly describe your intended use case.

The displayed model name is currently a product label. The public MVP uses an OpenAI-compatible provider.

## Quick start

Requirements: Node.js and npm.

```bash
git clone https://github.com/kyoo-147/SandoraAgent-CLI.git
cd SandoraAgent-CLI
npm install
npm start
```

Configure an OpenAI-compatible provider with environment variables (credentials are optional for offline startup).

```powershell
$env:OPENAI_API_KEY="..."
$env:OPENAI_BASE_URL="https://api.openai.com/v1"
$env:OPENAI_MODEL="gpt-4o-mini"
npm start
```

## Multi-provider support

Sandora is not locked to a single model vendor. Any OpenAI-compatible chat-completions endpoint can be configured with `OPENAI_BASE_URL`, `OPENAI_MODEL`, and `OPENAI_API_KEY`.

Credentials remain on the user's machine and are not stored in this repository.

### Local plugins

`src/plugin-host.mjs` provides an independent, local plugin host. It discovers one
`sandora.plugin.json` (or `plugin.json`) per immediate child directory, validates
API version 1 manifests, and safely skips malformed entries. Enabled plugins may
register `tools`, `providers`, `agents`, `commands`, `services`, and `hooks` via
`PluginHost`; activation is transactional and `disable()` disposes registrations.
Contribution names collide fail-closed with built-in and already-active names.

## How it works

Sandora's native runtime provides the agent loop, JSONL sessions, streaming events, provider integration, and core coding tools.

The parent agent remains responsible for planning, edits, integration, testing, review, and Git delivery. Delegated workers are intentionally read-only in the MVP.

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

Sandora is designed to work autonomously inside the selected workspace. It is instructed to preserve unrelated changes, avoid credential exposure, review diffs, and run tests before Git delivery.

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
and a child-process cleanup smoke test. CI performs a clean `npm ci` first and
runs the high-severity production dependency scan.

## Current limitations

- Direct computer-use control requires a future Windows adapter; browser tools can launch Chromium or connect via `SANDORA_CDP_URL`
- The Sandora model remains in private evaluation
- Subagents are read-only and limited to four concurrent tasks
- Provider credentials are not required for the fixture-based QA harness

## Acknowledgements

The broader terminal-agent ecosystem provides useful design references:

- [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)
- [OpenAI Codex CLI](https://github.com/openai/codex)
- [Google Gemini CLI](https://github.com/google-gemini/gemini-cli)
- [Grok Build](https://github.com/xai-org/grok-build)
- [Kimi Code CLI](https://github.com/MoonshotAI/kimi-code)
- [Kimi CLI](https://github.com/MoonshotAI/kimi-cli)

Sandora-specific branding, interface, launcher, and integrations are maintained in this repository.
