# Sandora Product-Grade Master Plan

Status: active
Last updated: 2026-08-29

## Mission

Evolve Sandora Agent CLI from a compact Pi-backed MVP into an independent, production-grade autonomous agent platform. Preserve working behavior while replacing foreign runtime ownership, splitting real responsibilities into maintained packages, and proving behavior through restart-safe real workflows.

This plan is continuous: **inspect -> plan -> implement -> test -> run real flows -> review -> repair -> integrate -> commit -> push -> repeat**. A passing current suite or PR is a milestone, not completion.

## Non-negotiable completion flow

Sandora must independently:

1. understand a repository and build a durable plan;
2. call a Sandora-owned model/provider runtime;
3. inspect/search/read code;
4. spawn parallel Sandora workers;
5. edit files and execute commands;
6. run tests, inspect failures and repair them;
7. use browser/computer tools when required;
8. manage context, sessions, checkpoints and memory;
9. survive interruption and reconcile uncertain operations;
10. review changes and use Git/GitHub;
11. commit, push, create a PR and integrate safely;
12. report evidence and limitations;
13. do all of the above with Pi packages removed.

## Delivery rules

- Never overwrite unrelated user work (`.commandcode/` and `company-site/` are currently unrelated/untracked).
- Freeze and test a contract before moving its implementation.
- Migrate vertical slices; keep the CLI and headless flow runnable after every stable milestone.
- Use compatibility re-exports temporarily, with owner and deletion phase documented.
- Do not create empty packages or speculative framework layers.
- One writer per working tree. Parallel writers use isolated worktrees and integrate through reviewed commits.
- Land stable milestones separately: architecture/state, package foundation, migrated subsystem, behavioral change.
- Real-provider/browser/Git/GitHub tests are distinct from fixtures and may be skipped only with an explicit reason.
- Security claims must identify the actual enforcement layer.
- Every phase updates `docs/project/STATE.md` with commits, tests, skips, blockers, next work and decisions.

## Workstreams

### A. Contracts and repository foundation

- Establish npm workspaces and package export boundaries.
- Define/import-check dependency rules and package conformance.
- Move protocol/event types first, then pure domain contracts.
- Add public API tests and forbid deep imports.
- Make root scripts discover packages rather than duplicate hard-coded file lists.

### B. Native agent and model runtime

- Make native core the default and remove Pi startup coupling.
- Split provider transport from turn/step orchestration and session facade.
- Add provider descriptors/capabilities, credential handles, routing and normalized errors.
- Implement a second real provider adapter path without core changes.
- Add malformed stream, cancellation, retry, usage and routing conformance.

### C. Context, sessions, checkpoints and memory

- Extract canonical event/store contracts and deterministic projection.
- Introduce explicit turn/step/request records and schema migrations.
- Add content-addressed checkpoints and forced-crash recovery tests.
- Keep compaction lineage and full history.
- Define persistent memory admission, provenance, retention and user control before automatic writes.

### D. Tool, workspace, policy and sandbox runtime

- Split schema registry, receipts, approvals, filesystem, shell and process ownership.
- Define capability/effect contracts and exact approval identity.
- Add process-tree backends and truthful cleanup facts on Windows/Linux.
- Add sandbox SPI and at least one probed backend; fail closed when required enforcement is absent.
- Add adversarial path, environment, output, cancellation and race tests.

### E. Tasks, workers, swarm and scheduler

- Land the native process-worker WIP with session-level integration and adapter content identity.
- Replace in-process-only subagents with Sandora child-run protocol.
- Unify task DAG, run store, leases, attempts, process evidence, budgets and artifacts.
- Add writable Sandora workers using worktrees; remove Pi worker implementations.
- Test lost acknowledgement, stale lease, restart, cancellation, late result, fan-out and budget exhaustion.

### F. Git and GitHub

- Extract Git observation/mutation and worktree custody.
- Add safe commit/push/PR workflows behind exact approvals and credential handles.
- Add conflict, dirty/ignored preservation, base movement and post-integration validation tests.
- Dogfood PR creation and integration only after repository state is clean and checks are trustworthy.

### G. Kernel, plugins and MCP

- Extract current plugin host into kernel admission/lifecycle plus plugin runtime.
- Add service/capability ownership, transactional activation and supervised process mode.
- Add MCP transports/adapters behind Sandora policy and tool receipts.
- Add contract tests for malformed servers, stdout contamination, timeout, capability collision and disposal.

### H. Browser and computer use

- Split CDP transport, lifecycle, observation/ref policy, actions and transfer evidence.
- Add structured accessibility snapshots as the default observation.
- Run real Chromium E2E for navigation, forms, tabs, redirects, stale refs, upload/download and teardown.
- Add prompt-injection and changed-target approval tests.
- Add desktop computer-use only after browser gates pass; begin with one accessibility-first Windows adapter and fixture app.

### I. Interfaces and SDK

- Move current TUI into `apps/cli` plus `packages/tui` without runtime imports.
- Move JSONL into `apps/headless`; publish protocol schemas and backpressure rules.
- Add an embedded SDK and executable examples using the same runtime.
- Add package/API compatibility and stdout/stderr/exit-code conformance.

### J. Observability, evals, CI and release

- Add structured local logs, redaction and trace correlation.
- Create eval tasks for coding correctness, recovery, tool policy and context behavior; never label fixtures as model quality.
- Add performance benchmarks for startup, memory, event replay, context projection, scheduler and process cleanup.
- Build Windows and Linux CI matrices: install, static checks, unit, integration, E2E, security/dependency/license, package smoke.
- Add signed/provenance-aware release artifacts, SBOM/license notices and clean-install smoke.

## Acceptance matrix

A capability is `complete` only when its real flow and negative/recovery cases pass.

| Area | Required proof |
|---|---|
| Native core | Start and complete a multi-step tool turn with Pi physically absent |
| Providers | Real OpenAI-compatible endpoint plus second adapter; cancellation, usage, malformed stream and failure classification |
| Coding | Real disposable repository inspect -> edit -> fail -> repair -> retest -> diff |
| Sessions | Forced kill at model/tool boundaries, restart, deterministic context, unknown-effect reconciliation |
| Context | Budget/compaction provenance, tool adjacency and restart equivalence |
| Tools/security | Traversal/link/reparse denial; exact approval; environment isolation; bounded output; process-tree evidence |
| Plugins | Load/disable real local plugin; dependency failure rollback; process failure containment |
| MCP | Real fixture server discovery/call/resource; malformed/timeout/permission negative paths |
| Workers | Parallel native child runs with isolated sessions, status, cancellation, artifacts and restart |
| Writable swarm | Separate worktrees/branches, independent tests, conflict detection, reviewed integration and safe cleanup |
| Browser | Real browser structured observe -> navigate -> click/type/scroll -> state -> screenshot; transfer/profile/redirect negatives |
| Computer use | Supported OS fixture app accessibility observe/action workflow and denial cases |
| Git/GitHub | Real local/remote push and PR flow in an authorized disposable repository |
| Interfaces | Same runtime through TUI, JSONL and SDK; bounded backpressure and stable exit behavior |
| Packaging | Clean Windows/Linux install and executable smoke from release artifact |
| Pi removal | Dependency/import/process/config scan clean; full autonomous flow passes |

## Near-term ordered milestones

### M0 — architecture and custody baseline

- Persist architecture, reference audit, migration plan and project state.
- Record current WIP and test baseline without touching unrelated work.
- Exit: docs reviewed, tracked, and sufficiently self-contained for a fresh run.

### M1 — finish native worker process slice

- Add WIP files to authoritative QA discovery.
- Test `createAgentSession(processMode)` through actual `delegate_subagents`.
- Hash resolved adapter content, not just the configured path.
- Persist/restore process evidence and assert truthful descendant cleanup status.
- Exit: focused, full and QA suites pass sequentially; WIP committed separately.

### M2 — workspace/package foundation plus protocol vertical slice

- Configure workspaces.
- Create only `packages/protocol`, `packages/agent-core`, `packages/model-runtime`, `packages/session-store`, and `apps/headless` when code moves into each.
- Keep compatibility re-exports in `src/` and prove old imports still work.
- Add package-boundary/import tests.
- Exit: native JSONL flow and restart tests pass from new package owners.

### M3 — native default and Pi quarantine

- Make native runtime default.
- Move all Pi code to `adapters/pi`; make Pi dependency optional migration-only.
- Remove Pi model requirement from normal startup and worker availability.
- Exit: clean install without optional Pi dependency passes native CLI/headless/coding flow.

### M4 — native writable worker and task unification

- Implement writable Sandora child runs in owned worktrees.
- Unify manager/run-store/lease/process/artifact schemas.
- Remove Pi writable worker and Pi subagent paths.
- Exit: two-worker interrupted workflow recovers and integrates safely.

### M5+ — continue through plugin/MCP, browser, policy backends, SDK, CI/release and final acceptance

Do not pause at an intermediate green suite. Select the highest-priority unmet acceptance gate, update state, implement the smallest complete vertical slice, and repeat.

## Review cadence

After each milestone:

1. inspect complete diff and dependency graph;
2. run targeted tests, then full tests and QA sequentially;
3. run at least one real user flow relevant to the change;
4. force one interruption/failure path;
5. perform independent read-only review;
6. repair findings and rerun;
7. update durable state;
8. commit and push only stable, scoped changes;
9. choose the next unmet acceptance gate.
