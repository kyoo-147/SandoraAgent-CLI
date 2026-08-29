# Sandora Durable Project State

Last updated: 2026-08-29
Branch: `feat/core-agent-mvp`
Remote: `https://github.com/kyoo-147/SandoraAgent-CLI.git`

Read this file first on a new run, then `docs/architecture/MASTER_PLAN.md`, `PLATFORM_ARCHITECTURE.md`, and `MIGRATION_PLAN.md`.

## Vision and constraints

Sandora is becoming an independent production-grade autonomous agent platform with modular subsystems and a Sandora-owned core. Reference repositories are study material only. Final operation cannot require Pi or another coding-agent runtime. Do not use the harness goal system for this project. Do not overwrite unrelated user work. Do not create empty packages.

## Repository custody

- Latest pushed commit: `da531e6 feat(tools): enforce schema and policy decisions`.
- Earlier native milestones: `d4a09fa`, `4109865`, `ec8e639`, `bc74fb2`.
- Open PR previously observed: #11; CI jobs had failed with zero steps due an account lock, not test execution.
- Unrelated untracked content to preserve: `.commandcode/`, `company-site/`.
- Runtime-generated `.sandora/` is ignored and is not durable project documentation.

## Current uncommitted implementation WIP

Native process-worker slice (pre-dates architecture rewrite):

- modified `src/agents/manager.mjs`
- modified `src/agents/subagents.mjs`
- modified `src/runtime/native-agent-session.mjs`
- new `scripts/native-worker.mjs`
- new `src/agents/native-worker-runner.mjs`
- new `test/fixtures/native-worker-adapter.mjs`
- new `test/unit/native-worker-runner.test.mjs`

Implemented in this WIP:

- opt-in child-process worker mode with explicit trusted local adapter;
- one-request/one-result JSONL protocol;
- bounded stdout/stderr and filtered environment;
- read-only worker registry;
- timeout/cancellation of the direct child;
- manager dispatch/process evidence hooks and durable snapshots;
- truthful `childExitVerified` and `processTreeCleanupVerified:false`.

Do not discard or accidentally omit the four untracked WIP files. Do not claim adapter code is sandboxed.

## Audit findings and next defects

1. `package.json` and `scripts/qa.mjs` omit native worker production entrypoints from syntax gates.
2. No integration test creates a native session in process-worker mode and executes `delegate_subagents` through restart identity/persistence.
3. Worker adapter identity currently hashes configured path text, not resolved adapter bytes.
4. Descendant process cleanup is not verified; direct-child exit only.
5. Pi remains the default core and a startup dependency, including worker-model availability.
6. Real Pi tests (4) and real CDP tests (5) are configured but skipped without environment/credentials.
7. The repository has no package/workspace boundaries yet; several modules mix multiple target responsibilities.
8. Current tests are strong local mechanics evidence, not final product completion.

## Test status

Most recent parent validation after WIP:

- `npm run check`: PASS.
- `npm test`: PASS, 180 total / 171 pass / 0 fail / 9 skip.
- `npm run qa`: one Windows `EBUSY` cleanup failure in `CLI Ctrl+C aborts...` while `npm test` and `npm run qa` were run concurrently. This was an invalid concurrent validation pattern for shared OS resources.
- isolated rerun `node --test test/e2e/cli-prompt-e2e.test.mjs`: PASS 4/4.

Required next validation: after fixes, run focused tests, `npm run check`, `npm test`, and `npm run qa` **sequentially**. Record real-provider/browser skips honestly.

## Architecture work completed in current run

- Audited all current tracked source/tests/scripts/workflows and WIP.
- Read all 31 files in the internal architecture corpus. The corpus is internal and is not copied into this repository; the new docs are an independent publishable plan.
- Audited pinned Codex, Gemini CLI, Kimi Code, Kimi CLI, DeepSeek Harness, Grok Build and Pi repository structures/contracts/tests/licenses.
- Persisted target architecture, master plan, migration plan, reference audit and this durable state.

## Immediate next work

1. Review and commit architecture/state docs without staging unrelated/WIP files.
2. Complete native process-worker slice:
   - authoritative QA discovery;
   - session-level process-mode E2E/restart test;
   - resolved adapter content identity;
   - process evidence restore assertions.
3. Run focused/full/QA sequentially and review the complete WIP diff.
4. Commit/push the native worker milestone separately.
5. Establish npm workspace/package foundation and migrate protocol/session/agent vertical slice with compatibility re-exports.
6. Make native core default, quarantine Pi under a migration adapter, then prove a clean install without Pi.

## Blockers

- No technical blocker to local implementation.
- Live provider/CDP/GitHub acceptance depends on credentials, browser availability and authorized disposable targets.
- CI account-lock failure is external and does not replace local validation.

## State update template

After each milestone update:

- branch and latest pushed/local commits;
- changed/created packages and public contracts;
- completed flows and exact commands;
- failures repaired and regressions added;
- skipped/unverified real integrations;
- unrelated work preserved;
- remaining highest-priority acceptance gap;
- next implementation slice.
