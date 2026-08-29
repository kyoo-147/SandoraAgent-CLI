# Sandora Durable Project State

Last updated: 2026-08-29
Branch: `feat/core-agent-mvp`
Remote: `https://github.com/kyoo-147/SandoraAgent-CLI.git`

Read this file first on a new run, then `docs/architecture/MASTER_PLAN.md`, `PLATFORM_ARCHITECTURE.md`, and `MIGRATION_PLAN.md`.

## Vision and constraints

Sandora is becoming an independent production-grade autonomous agent platform with modular subsystems and a Sandora-owned core. Reference repositories are study material only. Final operation cannot require Pi or another coding-agent runtime. Do not use the harness goal system for this project. Do not overwrite unrelated user work. Do not create empty packages.

## Repository custody

- Latest pushed commit: `da531e6 feat(tools): enforce schema and policy decisions`.
- Latest local commit: `8474339 docs(architecture): define modular platform migration`.
- Earlier native milestones: `d4a09fa`, `4109865`, `ec8e639`, `bc74fb2`.
- Open PR previously observed: #11; CI jobs had failed with zero steps due an account lock, not test execution.
- Unrelated untracked content to preserve: `.commandcode/`, `company-site/`.
- Runtime-generated `.sandora/` is ignored and is not durable project documentation.

## Current implementation milestone awaiting commit

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

The milestone now also uses automatic syntax discovery, binds sessions to canonical adapter path and exact bytes, executes the verified adapter bytes from an in-memory data URL, blocks adapter drift during an active session, preserves spawn errors as durable failed tasks, validates protocol output caps, and tests process-mode session/restart behavior. Do not discard or accidentally omit the untracked milestone files. Do not claim adapter code is sandboxed or descendant cleanup is proven.

## Audit findings and next defects

1. Descendant process cleanup is not verified; direct-child exit only. Windows Job Object/POSIX process-group backends remain future work.
2. Process adapters are trusted, self-contained modules; process separation is not a hostile-code sandbox.
3. Pi remains the default core and a startup dependency, including worker-model availability.
4. Real Pi tests (4) and real CDP tests (5) are configured but skipped without environment/credentials.
5. The repository has no package/workspace boundaries yet; several modules mix multiple target responsibilities.
6. Current tests are strong local mechanics evidence, not final product completion.

## Test status

Most recent parent validation after review fixes:

- `npm run check`: PASS, automatic discovery checked 34 production/script files.
- focused native worker/session tests after review fixes: PASS 25/25.
- `npm test`: PASS, 183 total / 174 pass / 0 fail / 9 environment-gated skips.
- `npm run qa`: PASS with the same 183-test result plus CLI smoke and fixture cleanup.
- `npm run qa:deps`: PASS, 0 vulnerabilities.
- `git diff --check`: PASS (only expected Git line-ending conversion warnings).
- Windows temp cleanup now uses bounded `fs.rm` retries after a reproducible full-suite-only `EBUSY`; the isolated test and full suite both pass. Do not run shared OS E2E suites concurrently.

Required next validation: after fixes, run focused tests, `npm run check`, `npm test`, and `npm run qa` **sequentially**. Record real-provider/browser skips honestly.

## Architecture work completed in current run

- Audited all current tracked source/tests/scripts/workflows and WIP.
- Read all 31 files in the internal architecture corpus. The corpus is internal and is not copied into this repository; the new docs are an independent publishable plan.
- Audited pinned Codex, Gemini CLI, Kimi Code, Kimi CLI, DeepSeek Harness, Grok Build and Pi repository structures/contracts/tests/licenses.
- Persisted target architecture, master plan, migration plan, reference audit and this durable state.

## Immediate next work

1. Review the complete diff, commit and push the native worker milestone separately.
2. Establish npm workspace/package foundation and migrate protocol/session/agent vertical slice with compatibility re-exports.
3. Make native core default, quarantine Pi under a migration adapter, then prove a clean install without Pi.

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
