# Modular Migration Plan

Status: active
Last updated: 2026-08-29

## Migration strategy

Use a strangler migration with tested compatibility re-exports. Move coherent vertical slices, not directory names. The product remains runnable after each milestone. No package is created before its implementation and tests move with it.

## Current source ownership map

| Current file | Target owner | Migration notes |
|---|---|---|
| `start.mjs` | `apps/cli` | thin launcher after composition moves out |
| `src/cli/terminal-app.mjs` | `packages/tui` + `apps/cli` | split renderer/input/read model from startup/session composition |
| `src/cli/headless-jsonl.mjs` | `apps/headless` + `packages/protocol` | transport validates versioned commands; runtime stays shared |
| `src/runtime/agent-session.mjs` | `packages/agent-core` | public session port/read model |
| `src/runtime/events.mjs` | `packages/protocol` | canonical event schema/redaction/migrations |
| `src/runtime/event-reducer.mjs` | `packages/agent-core` | pure UI/session projection |
| `src/runtime/context-budget.mjs` | `packages/context-engine` | deterministic projection/compaction |
| `src/runtime/turn-runtime.mjs` | `packages/model-runtime`, `packages/agent-runtime`, `packages/session-store` | split SSE adapter, loop, event bus and JSONL store |
| `src/runtime/native-agent-session.mjs` | `packages/agent-runtime` | composition/recovery facade; shrink after extraction |
| `src/runtime/create-session.mjs` | application composition root | native default; Pi adapter loaded only by explicit migration mode |
| `src/runtime/pi-agent-session.mjs` | `adapters/pi` | temporary; delete at final gate |
| `src/tools/registry.mjs` | `packages/tool-runtime` | schema admission and public tool contract |
| `src/tools/receipts.mjs` | `packages/tool-runtime` + `packages/policy` | canonical execution receipt and policy facts |
| `src/tools/approvals.mjs` | `packages/policy` | exact durable approval store |
| `src/tools/coding-tools.mjs` | `packages/workspace-runtime` | split filesystem, search, shell/process and policy bindings |
| `src/browser/tools.mjs` | `packages/browser-runtime` | split CDP, session lifecycle, refs/actions/transfers |
| `src/git/tools.mjs` | `packages/git-runtime` | split Git and GitHub adapters from policy |
| `src/git/worktrees.mjs` | `packages/git-runtime` | worktree custody/recovery/integration |
| `src/agents/manager.mjs` | `packages/task-runtime` | scheduler/admission/attempt state |
| `src/agents/run-store.mjs` | `packages/task-runtime` | durable task/attempt store |
| `src/agents/leases.mjs` | `packages/task-runtime` | fenced ownership |
| `src/agents/subagents.mjs` | `packages/worker-runtime` | native read-only child-run facade |
| `src/agents/native-worker-runner.mjs` | `packages/worker-runtime` | process protocol/lifecycle |
| `scripts/native-worker.mjs` | worker application entrypoint | later `apps/worker`; never imports Pi |
| `src/agents/worker-tools.mjs` | `packages/worker-runtime` + workspace tool profiles | capability-scoped worker surface |
| `src/agents/pi-subagents.mjs` | `adapters/pi` | delete after native worker parity |
| `src/agents/pi-writable-workers.mjs` | `adapters/pi` | delete after native writable workers |
| `src/plugins/host.mjs` | `packages/kernel` + `packages/plugin-runtime` | manifest/graph admission versus activation lifecycle |
| `src/plugins/runtime.mjs` | `packages/plugin-runtime` | composition/config bridge |

Tests move with subsystem ownership while product-level flows remain under top-level `test/e2e` until `fixtures/` and app harnesses are established.

## Dependency migration sequence

### Stage 0 — baseline and WIP custody

- Persist architecture and state docs.
- Record current baseline: 180 tests, 171 pass, 9 configured skips; a parallel QA invocation exposed a Windows `EBUSY` cleanup race, while isolated rerun passed.
- Preserve native process-worker WIP and unrelated untracked directories.

### Stage 1 — native process-worker completion

1. Add authoritative syntax discovery for every production and worker entrypoint.
2. Integrate session-level process mode and restart identity tests.
3. Resolve and hash adapter bytes plus stable path identity.
4. Persist dispatch intent before spawn and child evidence after spawn/exit.
5. Keep `processTreeCleanupVerified:false` until a real backend proves descendants are gone.
6. Run focused worker tests, full suite, QA sequentially and a real child process flow.

### Stage 2 — workspace foundation

1. Add npm workspaces for existing, populated packages only.
2. Add package metadata, exports and Node engine consistently.
3. Add a package-boundary test that rejects forbidden/deep imports and Pi imports outside `adapters/pi`.
4. Replace root hard-coded syntax lists with deterministic file/package discovery.
5. Keep root commands (`start`, `jsonl`, `test`, `qa`) stable.

### Stage 3 — protocol/session/agent vertical slice

Move in order:

1. event schemas/redaction/migration -> `packages/protocol`;
2. pure reducers/session contracts -> `packages/agent-core`;
3. JSONL append/replay/locking -> `packages/session-store`;
4. OpenAI-compatible stream adapter -> `packages/model-runtime`;
5. turn loop and recovery facade -> `packages/agent-runtime`;
6. JSONL application -> `apps/headless`.

Old `src/` files become temporary re-exports with deletion issue/phase. Validate replay compatibility against existing native event fixtures after each move.

### Stage 4 — tool/workspace/policy vertical slice

- Extract schema registry and execution pipeline.
- Split filesystem and process services from tool declarations.
- Normalize capability/effect declarations and approval identity.
- Move receipts and approval stores without changing existing on-disk semantics.
- Add platform-specific path/process conformance.

### Stage 5 — native-first composition and Pi quarantine

- Change default core from Pi to native.
- Move Pi imports and tests to `adapters/pi`.
- Make Pi packages optional and excluded from native install/package profile.
- Add clean-install test that blocks any `@earendil-works/pi*` resolution while running CLI, headless, workers and native E2E.
- Keep one explicit `--legacy-pi`/migration mode only while needed; never mix session formats.

### Stage 6 — task/worker/Git vertical slice

- Unify task records, attempts, leases, budgets, process evidence and artifacts.
- Implement native writable workers with Sandora model/tool/session runtime.
- Attach worktree ownership and integration gates to durable attempts.
- Delete Pi subagent and Pi writable-worker implementations after parity/recovery tests.

### Stage 7 — kernel/plugin/MCP

- Extract kernel admission and service/capability broker.
- Keep current trusted local plugins working via compatibility manifest handling.
- Add process-isolated service mode and MCP adapters.
- Ensure MCP tools cannot bypass Sandora policy or receipts.

### Stage 8 — browser/computer

- Extract browser runtime and add structured accessibility observation.
- Add real browser CI profile where executable availability permits.
- Implement one accessibility-first desktop backend only after browser safety gates pass.

### Stage 9 — applications, SDK, evals, release

- Complete `apps/cli`, `apps/headless`, `packages/tui`, `packages/sdk` separation.
- Add executable examples, fixtures, evals and benchmarks.
- Add Windows/Linux package and release smoke, SBOM/license/security checks.

### Stage 10 — final Pi removal

- Remove Pi adapter, dependency, lock entries, env/config paths and Pi-specific tests/docs.
- Scan imports, processes, package tree and configuration.
- Run complete clean-install acceptance workflow with no Pi package available.
- Publish session migration/export or explicit incompatibility guidance.

## Compatibility and rollback

- Existing native `sandora.event/v1` logs remain readable; migrations write a new copy or derived checkpoint.
- Pi and native sessions never mix.
- Compatibility re-exports have tests and are deleted on a named stage, not retained indefinitely.
- A failed package migration reverts imports, not accepted session history.
- Dirty worktrees and unresolved attempts are preserved through migration.

## Exit criteria for every extraction

- package has real implementation and tests;
- public exports are documented and deep imports blocked;
- on-disk/protocol compatibility is tested;
- root CLI/headless flows remain runnable;
- targeted and full suites pass sequentially;
- no new circular/forbidden dependency;
- docs/project state updated;
- diff reviewed before commit/push.
