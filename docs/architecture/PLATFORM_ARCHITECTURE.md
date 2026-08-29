# Sandora Platform Architecture

Status: target architecture, migration in progress
Last updated: 2026-08-29

## 1. Product boundary

Sandora is a local-first autonomous agent platform. It owns the agent loop, provider runtime, tool execution, context, sessions, checkpoints, memory, workspaces, Git/GitHub, browser/computer use, workers, orchestration, scheduling, plugins, MCP, protocol, policy, durability, observability, CLI/TUI, headless API, SDK, evals, packaging, and release process.

Pi, Codex, Gemini CLI, Kimi Code/Kimi CLI, DeepSeek Harness, and Grok Build are reference implementations only. No foreign agent runtime may become Sandora's source of truth. The final Pi-removal gate is a clean install and complete autonomous coding flow with all Pi packages absent.

## 2. Architectural principles

1. **One native core.** CLI, TUI, headless, SDK, and workers use the same Sandora runtime.
2. **Durable facts before live projections.** Side-effect intent and terminal outcomes are appended before UI publication. Live deltas are not canonical facts.
3. **Context is derived.** Every model-visible input is reconstructable from durable state and provenance.
4. **Policy and enforcement are different facts.** Approval permits an attempt; a sandbox or capability backend enforces it.
5. **No invisible retries across effects.** Unknown effect boundaries become `RECONCILE_REQUIRED`, never implicit retry.
6. **Children attenuate authority.** A worker receives equal or narrower capabilities and budgets than its parent.
7. **One writer per mutable workspace.** Writable workers use owned branches and worktrees; integration is serialized and reviewed.
8. **Protocols precede transports.** In-process, JSONL, RPC, ACP, and SDK adapters map one versioned domain protocol.
9. **Plugins cannot redefine kernel invariants.** Third-party code is admitted, scoped, supervised, and preferably process-isolated.
10. **Package boundaries are earned.** Create a package only with real responsibility, implementation, public contract, owner, and tests. Never add empty facade folders.
11. **Honest evidence.** Fixture, integration, live-provider, native-process, browser, and manual evidence are labeled separately.
12. **Windows and Linux are release platforms.** Platform behavior is explicit and tested; macOS follows where backends exist.

## 3. Target repository

Names may evolve, but ownership and dependency direction are normative.

```text
apps/
  cli/                    interactive application and composition root
  headless/               JSONL/RPC server composition root

packages/
  protocol/               versioned commands, events, results, errors, schemas
  kernel/                 lifecycle, capability broker, service/plugin supervision
  agent-core/             agent/run/turn/step domain contracts and reducers
  agent-runtime/          native loop, retries, cancellation, recovery coordination
  model-runtime/          provider-neutral requests, streams, registry, routing
  model-providers/        OpenAI-compatible and later vendor adapters
  context-engine/         context projection, budgets, compaction, provenance
  session-store/          append-only sessions, checkpoints, migrations, indexes
  memory/                 explicit persistent/user/workspace memory contracts
  tool-runtime/           schemas, registry, policy pipeline, receipts, execution
  workspace-runtime/      filesystem, shell, process ownership, workspace identity
  git-runtime/            Git/GitHub operations, worktrees, integration custody
  browser-runtime/        structured browser sessions, refs, transfers, evidence
  computer-runtime/       later accessibility-first OS adapters
  task-runtime/           durable task DAG, leases, attempts, artifacts, scheduler
  worker-runtime/         child process protocol, workers, subagents, swarm facade
  policy/                 capabilities, approvals, sandbox contracts, audit policy
  plugin-runtime/         manifests, graph admission, activation and disposal
  mcp/                    MCP client/server adaptation behind Sandora policy
  telemetry/              logging, metrics, traces, redaction and local exporters
  tui/                    renderer/input/read-model client
  sdk/                    stable programmatic client and embedded API

adapters/
  pi/                     temporary migration-only adapter; deleted at Pi-removal gate

evals/                    quality/safety tasks with evidence labels
benchmarks/               latency, memory, context, scheduler and process metrics
examples/                 executable SDK/plugin/headless examples
fixtures/                 disposable repositories, providers, browser sites, MCP servers
scripts/                  build, QA, migration, release and conformance tooling
docs/
  architecture/ protocols/ tools/ agents/ security/ development/ project/
.github/workflows/         Windows/Linux CI, security, release and package smoke
```

Packages can initially remain JavaScript ESM. TypeScript adoption is allowed package-by-package only with a stable build/test/release story. Rust is reserved for measured OS-enforcement or performance needs; it is not a prerequisite for modularity.

## 4. Layers and forbidden edges

```text
apps / sdk / tui
        |
agent-runtime / task-runtime / worker-runtime
        |
agent-core / model-runtime / context-engine / tool-runtime
        |
protocol / policy / session-store / kernel
        |
adapters and concrete filesystem, process, Git, browser, provider implementations
```

Rules:

- `protocol` imports no runtime package and has no I/O.
- `agent-core` imports only protocol-level contracts and pure utilities.
- `model-runtime` never executes tools, persists sessions, or renders UI.
- `tool-runtime` never calls a model or mutates conversation history directly.
- `session-store` persists versioned records but does not choose agent behavior.
- `policy` returns decisions and enforcement requirements; it does not execute tools.
- `task-runtime` owns task state, leases, budgets, attempts, and artifacts—not worker implementation details.
- `worker-runtime` uses `agent-runtime`; it never launches Pi or another agent CLI.
- `tui`, `apps/*`, and `sdk` depend on public contracts, not concrete providers or stores.
- `adapters/pi` is one-way: it may depend on Sandora contracts and Pi, but no native package may depend on it.
- Cross-package deep imports are forbidden. Public exports and contract tests are required.
- A generic `shared` dumping ground is prohibited. Pure code belongs to the smallest owning package.

## 5. Canonical execution model

A run contains turns; a turn contains one or more model steps. A step is one model request followed by zero or more tool calls and their authoritative results.

```text
accept command
 -> append command/turn intent
 -> derive context from durable facts
 -> persist context/request identity
 -> stream through selected provider
 -> normalize and persist assistant/tool intent
 -> validate schema and capabilities
 -> persist policy + approval decisions
 -> execute in owned enforcement boundary
 -> persist bounded receipt and tool result
 -> continue step or settle turn
 -> emit one terminal run/turn outcome
```

Provider retries are permitted only before semantic response acceptance and only under an explicit adapter policy. Tool effects are never automatically retried after `started` without an idempotency contract and reconciliation.

## 6. Protocol and durability

### 6.1 Event envelope

`sandora.event/v1` remains the canonical event envelope during migration. It carries unique event/stream IDs, contiguous sequence, timestamp, actor, correlation and causation, type, bounded redacted payload, and schema version.

Durable records cover:

- session/run/turn/step lifecycle;
- model request identity, accepted stream boundaries, usage, errors;
- assistant message lifecycle;
- context projection and compaction lineage;
- tool intent, policy, approval, start and terminal receipt;
- task, lease, attempt, process, artifact and worktree transitions;
- cancellation intent, propagation, forced termination and cleanup evidence.

A crash between intent and terminal outcome is explicitly unknown. Startup validates framing, stream identity, sequences, schema compatibility, configuration identity, and unresolved operations. Only an incomplete final frame may be quarantined/truncated; accepted history is not rewritten.

### 6.2 Version policy

- Protocol major changes require explicit compatibility adapters or migration.
- Persisted schema versions are independent of transport and package versions.
- Additive optional fields are compatible; changed required semantics are not.
- Migrations are deterministic, tested against fixtures, and never mutate the only copy.
- Pi sessions remain separate until export/migration is deliberately implemented.

### 6.3 Checkpoints

A checkpoint is a content-addressed projection with source event range, config/tool/provider hashes, unresolved effects, and compatibility metadata. It accelerates recovery; it never replaces the event log or claims rollback of external effects.

## 7. Runtime subsystems

### Model runtime

Owns provider descriptors, model capabilities, auth/credential handles, request normalization, stream normalization, usage/errors, routing, fallback policy, and adapter conformance. Effective capability is provider capability intersected with user policy and run grants. Provider-specific metadata is namespaced and cannot become required domain state.

### Context engine

Builds model-visible projections from durable messages, workspace instructions, memory, artifacts, tool schemas, and policy notices. Budgets reserve output/tool headroom. Compaction preserves tool adjacency, unresolved operations, approvals, user corrections, source IDs, and full audit history.

### Tool runtime

Pipeline: schema admission -> canonical input identity -> capability check -> policy -> approval -> enforcement selection -> timeout/cancellation -> implementation -> bounded/redacted outcome -> receipt. Effects declare read/write/process/network/credential/browser/Git scope and retry safety.

### Workspace runtime

Owns immutable workspace identity, path containment, atomic file mutation, shell/process launch, environment filtering, output limits, process-tree ownership, cancellation, sandbox facts, and platform adapters. Application checks are not described as an OS sandbox.

### Task and worker runtime

A task is durable. The scheduler validates DAGs, dependencies, grants, budgets, leases and attempts. Workers are Sandora child runs over a versioned process protocol, with structured outputs and artifact manifests. Process absence is not semantic completion. Dispatch uncertainty is reconciled before replacement.

### Git runtime

Owns safe observation/mutation, remote/GitHub operations, branch/worktree allocation, ownership, validation, commit/patch handoff, serialized integration, conflict states, and non-destructive cleanup. Dirty, ignored, ambiguous, or unintegrated work is preserved.

### Browser and computer runtime

Browser observation order is metadata -> accessibility/structured DOM -> focused diagnostics -> screenshot -> vision fallback. Element refs are short-lived and revision-bound. Profiles are anonymous-owned, dedicated persistent, or explicitly authorized existing. Upload, download retention, signed-in use, cross-origin movement, and consequential submit actions have distinct grants. Desktop adapters are deferred until browser contracts and evidence pass E2E.

## 8. Kernel and plugins

The kernel owns service identities, capability grants, plugin graph admission, transactional activation, reverse-order disposal, bounded live events, health/supervision, and configuration generations. It does not own provider messages, Git behavior, browser actions, or TUI rendering.

Plugin manifests declare engine range, entry, capabilities, requirements, permissions, config schema, integrity, isolation, and lifecycle. Manifest permissions are upper bounds, never grants. Built-in/audited plugins may run in-process; third-party or long-lived services default to process isolation when available. In-process unload means registration disposal, not a hard code-unload guarantee.

MCP is an external-principal adapter. MCP descriptions and results are untrusted input; calls pass through the same Sandora tool/policy/receipt pipeline. MCP is not the canonical session or task protocol.

## 9. Interfaces

- The embedded SDK is the primary in-process API.
- Headless JSONL keeps stdout protocol-only and stderr diagnostic-only.
- RPC adds correlation, cancellation, replay and backpressure over a named transport.
- TUI consumes the same event/read-model contract.
- ACP may be added as a client adapter.
- Critical durable facts are never dropped; coalescible presentation deltas may be bounded.

## 10. Security boundaries

Threats include hostile repository text/build scripts, malicious model output, plugin/MCP compromise, path races, ambient credentials, process descendants, network exfiltration, browser prompt injection, approval spoofing, and dependency compromise.

Required invariants:

- default-deny capabilities and exact, expiring approvals;
- child grant attenuation;
- filesystem-aware containment with Windows junction/reparse tests and Linux symlink/mount tests;
- filtered process environments and opaque credential handles;
- process-tree cleanup evidence, with UNKNOWN when unproven;
- network and sandbox backends report `full|partial|unavailable`; requirements fail closed;
- page/repository content cannot grant authority;
- audit and telemetry are redacted separately; telemetry is local/off by default;
- no claim of exactly-once external effects.

## 11. Observability

Sandora event IDs are authoritative. Logs, OpenTelemetry-compatible traces, and metrics correlate app -> session -> turn -> model request -> tool call -> process/task/worktree. Export is opt-in, bounded, redacted, and cannot block durable completion. Release and E2E reports record evidence tier, platform, source commit, toolchain, skipped gates and residual risk.

## 12. Definition of architectural completion

Architecture is complete only when the dependency graph enforces these boundaries, each created package has real implementation and tests, compatibility shims are scheduled for deletion, and the complete acceptance workflow passes without Pi installed. A large directory tree, passing unit suite, open PR, or one provider fixture is not completion.
