# Reference Architecture Audit

Status: current pinned audit
Audited: 2026-08-29

Sandora studies architecture and tests, not product identity or source to copy. Recommendations are clean-room design guidance unless a future provenance record explicitly approves reuse. Root licenses do not settle nested dependencies, assets, service terms, models, datasets or trademarks.

## Pinned sources

| Reference | Commit audited | Root license observed | Primary lessons |
|---|---|---|---|
| OpenAI Codex | `0ae94fdd49b05ee7faa4d984d06a68492cb32b54` | Apache-2.0; NOTICE present | protocol/app-server seam, provider capabilities, tool/policy/sandbox split, durable threads, worker control plane, SDK/headless/TUI sharing one core |
| Gemini CLI | `3c311beac2e78336816dd4a123db39743f9fbf85` | Apache-2.0 | workspace packages, scheduler/policy/sandbox/context services, subagent profiles, MCP, headless JSONL, SDK/evals/perf/integration matrices |
| Kimi Code | `9d2304c23ca30c781b1a39540971dcaef085a500` | MIT | versioned resumable event protocol, transcript fold/gap signaling, permission chain, tool access scheduling, worker handshakes, bounded UI replay |
| Kimi CLI | `cbc15c076d17f70fec9f89c90c0502e68657f505` | Apache-2.0; NOTICE present | Python workspace with provider library (`kosong`), execution abstraction (`kaos`), ACP/MCP, agents/subagents/background runtime, SDK and broad tests |
| DeepSeek Harness | `cd5ef8148158c3a752a658978873241fdf8e2bbc` | MIT; third-party notices | explicit turn/step event loop, event-sourced model context, layered tool pipeline, capability sandbox SPI, plugin-composed profiles, replay fixtures |
| Grok Build | `bc7f02eddd3d84085849dc19ed216f11c23b0571` | Apache-2.0; third-party notices | fine-grained Rust crates for agent lifecycle, protocol/tools, workspace, shell, sandbox, sessions, memory, hooks/plugins, MCP, ACP, worktrees and telemetry |
| Pi | `853a80d26c90a14c1886f0ebb8ffaae133ca2185` | MIT | provider/agent/product/TUI package separation, small generic loop, stream events, session/extension ergonomics; also the coupling Sandora must eliminate |

The Gemini checkout's working tree was inconsistent after cache refresh (tracked files appeared deleted/untracked); audit evidence used the exact Git object via `git show HEAD:<path>` and `git ls-tree`, not the dirty worktree projection.

## Cross-reference findings

### Stable protocol and application boundaries

Codex uses an app-server/protocol seam and thin SDK clients. Gemini and Grok expose headless/ACP surfaces beside interactive clients. Kimi Code separates durable and volatile events with cursor/epoch semantics. Pi exposes SDK/RPC/TUI over shared loop concepts.

**Sandora decision:** one versioned protocol and durable event model feeds in-process SDK, headless JSONL/RPC, TUI and future ACP. MCP remains a tool/resource adapter.

### Agent loop

DeepSeek Harness makes turn and step explicit and reconstructs model requests from a session log. Codex coordinates context, sampling and tools in a mature but high-touch core turn module. Pi's generic loop is compact but leaves persistence/product policy to the coding-agent layer. Kimi/Gemini show scheduler and specialized-agent composition.

**Sandora decision:** own a small explicit run/turn/step state machine. Split context, provider, tools, persistence and task scheduling behind contracts. Do not recreate a monolithic `core` package.

### Providers

Codex models provider capability upper bounds and scoped auth. Kimi CLI's `kosong` and `llm.py` expose Kimi, OpenAI legacy/responses, Anthropic and Google adapters. Gemini's provider/core coupling demonstrates the cost of placing many product services in one package. Pi's provider breadth is useful but its auth/catalog/filesystem conventions are not Sandora contracts.

**Sandora decision:** provider-neutral request/stream/error/usage contracts, explicit capability negotiation, opaque credential handles, namespaced raw metadata and conformance fixtures. Routing/fallback is a separate policy; providers cannot silently retry/fallback across semantic acceptance.

### Tools, policy and sandbox

Codex and DeepSeek separate tool registration, policy/approval and OS sandbox execution. DeepSeek's tool pipeline distinguishes canonical output, model rendering and UI presentation. Gemini has dedicated policy, safety, sandbox and scheduler trees. Kimi Code's permission chain falls back to ask and tool accesses define concurrency conflicts.

**Sandora decision:** one typed tool pipeline and separate enforcement receipt. Application path checks are not called a sandbox. Exact effects and accesses drive approval, concurrency, retry and evidence.

### Sessions, context and memory

DeepSeek's durable log is the model-context authority; compaction records start/end and does not split tool pairs. Codex has context fragments/provenance and thread reconstruction. Kimi Code uses idempotent transcript folding, gap detection and replay-aware UI. Grok separates chat state, compaction transcript, session events/search and memory crates.

**Sandora decision:** append-only events plus disposable projections/content-addressed checkpoints. Model-visible content is reconstructable and full history remains. Memory is explicit, provenance-bearing and user controllable.

### Workers and orchestration

Codex workers are persisted child episodes with root control, graph edges, budgets and status. DeepSeek profiles/scopes and Kimi/Gemini subagents show isolated context/tool profiles. Kimi Code's worker hosts add version handshake, deadline, crash backoff, resource limits and lock cleanup. Grok has agent lifecycle, prompt queue, workflow and subagent-resolution crates.

**Sandora decision:** workers use Sandora runtime directly, not another CLI. Durable tasks/attempts, grants, budgets, process/worktree identities, artifacts and reconciliation form a control plane. No advertised fixed swarm size without measured capacity.

### Plugins and MCP

DeepSeek's service/plugin composition is powerful but very large. Pi's extension activation UX is ergonomic but in-process and highly product-aware. Gemini has extensive hooks, resources and MCP transports. Grok separates hooks, plugin marketplace types, MCP and config. Kimi CLI integrates FastMCP and ACP.

**Sandora decision:** small kernel invariants plus versioned plugin runtime. Admission and transactional disposal come first; marketplace and hot replacement are deferred. MCP calls are external-principal tool calls under Sandora policy.

### Interfaces and developer experience

Codex, Gemini, Grok and Kimi invest in multiple clients, generated schemas, package-specific tests, fixtures, integration suites and release tooling. Grok explicitly targets per-crate validation because the workspace is large. Gemini has eval inventory/reporting, memory and performance suites. Codex has platform release/signing workflows.

**Sandora decision:** package-local tests plus product E2E, deterministic fixtures plus explicitly labeled live flows, import-boundary checks, schema generation, clean-tree gates, Windows/Linux release smoke and provenance/license outputs.

## Reference anti-patterns to avoid

- A god core/turn module with context, tools, provider, persistence and UI concerns.
- Package count that exceeds real product responsibility.
- Dual build systems before a measured hermeticity need.
- Global route/schema validation bypasses enforced only by convention.
- Dangerous unauthenticated/host-check override modes without hard local-development fencing.
- Silently dropped malformed IPC/JSON frames.
- Worker payload casts without runtime validation.
- PID-only ownership without process-instance identity/fencing.
- Cooperative timeout described as hard termination.
- Partial/unavailable sandbox described as full enforcement.
- Pi coding-agent package/session/config/tool types leaking into Sandora APIs.
- Disabled Windows gates while claiming cross-platform parity.
- Replay or mock success presented as model quality or real integration proof.

## Licensing/reuse posture

Default: study and independently implement Sandora contracts. Any copied/ported unit requires a provenance record with source URL, exact commit/path, license, notices, modifications, destination, dependency implications and owner review. Apache-2.0 material may carry NOTICE and modification obligations; MIT material requires preservation of exact notices. This audit copies no upstream implementation.

## Current Sandora audit summary

At `da531e6`, Sandora has 70 tracked files and approximately 3,900 source lines. It already owns useful native primitives: canonical events, JSONL session recovery, OpenAI-compatible streaming, context compaction, tools/receipts/approvals, filesystem/shell policy, Git/worktrees, browser CDP, plugin activation, task leases/run store, CLI and headless JSONL. It remains structurally compact and Pi-backed by default.

Largest mixed-responsibility modules are `src/cli/terminal-app.mjs`, `src/runtime/turn-runtime.mjs`, `src/runtime/native-agent-session.mjs`, `src/browser/tools.mjs`, `src/tools/coding-tools.mjs`, and `src/git/worktrees.mjs`. Current Pi imports live in runtime/subagent/writable-worker adapters and Pi tests; the dependency is direct in `package.json`.

Current native process-worker WIP is useful but incomplete at the session integration and authoritative QA layers. See `docs/project/STATE.md` and `docs/architecture/MIGRATION_PLAN.md`.
