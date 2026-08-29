import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ApprovalStore } from "../../src/tools/approvals.mjs";
import { canonicalInputSha256, ToolReceiptStore } from "../../src/tools/receipts.mjs";

const future = () => new Date(Date.now() + 60_000).toISOString();

test("approval decisions are durable, exact-scope, bounded-use, and restart-readable", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "sandora-approvals-"));
  const old = process.env.SANDORA_REQUIRE_APPROVALS;
  process.env.SANDORA_REQUIRE_APPROVALS = "1";
  try {
    const store = new ApprovalStore({ cwd });
    const args = { number: 7 };
    const record = await store.create({ toolName: "git_merge", args, authorityVariable: "SANDORA_ALLOW_LOCAL_MERGE", decision: "ALLOW", expiresAt: future(), maxUses: 2 });
    assert.match(record.reference, /^[a-f0-9]{64}$/);
    assert.equal((await new ApprovalStore({ cwd }).consume({ toolName: "git_merge", inputSha256: canonicalInputSha256(args), authorityVariable: "SANDORA_ALLOW_LOCAL_MERGE" })).status, "APPROVED");
    assert.equal((await new ApprovalStore({ cwd }).consume({ toolName: "git_merge", inputSha256: canonicalInputSha256(args), authorityVariable: "SANDORA_ALLOW_LOCAL_MERGE" })).status, "APPROVED");
    assert.equal((await new ApprovalStore({ cwd }).consume({ toolName: "git_merge", inputSha256: canonicalInputSha256(args), authorityVariable: "SANDORA_ALLOW_LOCAL_MERGE" })).status, "REPLAYED");
    assert.equal((await store.consume({ toolName: "git_merge", inputSha256: canonicalInputSha256({ number: 8 }), authorityVariable: "SANDORA_ALLOW_LOCAL_MERGE" })).status, "MISSING");
    await assert.rejects(() => store.create({ toolName: "git_merge", args, authorityVariable: "SANDORA_ALLOW_LOCAL_MERGE", decision: "ALLOW", expiresAt: future(), scope: { toolName: "browser_click" } }), /reserved fields/);
    await assert.rejects(() => store.create({ toolName: "git_merge", args, inputSha256: canonicalInputSha256({ number: 99 }), authorityVariable: "SANDORA_ALLOW_LOCAL_MERGE", decision: "ALLOW", expiresAt: future() }), /does not match/);
    await assert.rejects(() => store.create({ toolName: "git_merge", args, authorityVariable: "SANDORA_ALLOW_LOCAL_MERGE", decision: "DENY", expiresAt: future() }), /active approval decision/);
  } finally { if (old === undefined) delete process.env.SANDORA_REQUIRE_APPROVALS; else process.env.SANDORA_REQUIRE_APPROVALS = old; await rm(cwd, { recursive: true, force: true }); }
});

test("concurrent approval consumption never exceeds its bounded use count", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "sandora-approval-race-")); const old = process.env.SANDORA_REQUIRE_APPROVALS; process.env.SANDORA_REQUIRE_APPROVALS = "1";
  try {
    const store = new ApprovalStore({ cwd }); const args = { branch: "feature" };
    await store.create({ toolName: "git_merge", args, authorityVariable: "SANDORA_ALLOW_LOCAL_MERGE", decision: "ALLOW", expiresAt: future(), maxUses: 3 });
    const outcomes = await Promise.all(Array.from({ length: 12 }, () => new ApprovalStore({ cwd }).consume({ toolName: "git_merge", inputSha256: canonicalInputSha256(args), authorityVariable: "SANDORA_ALLOW_LOCAL_MERGE" })));
    assert.equal(outcomes.filter(item => item.status === "APPROVED").length, 3);
    assert.equal(outcomes.filter(item => item.status === "REPLAYED").length, 9);
  } finally { if (old === undefined) delete process.env.SANDORA_REQUIRE_APPROVALS; else process.env.SANDORA_REQUIRE_APPROVALS = old; await rm(cwd, { recursive: true, force: true }); }
});

test("approval-required receipt blocks without matching approval and seals status", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "sandora-approval-receipt-"));
  const oldMode = process.env.SANDORA_REQUIRE_APPROVALS, oldAuth = process.env.SANDORA_ALLOW_LOCAL_MERGE;
  process.env.SANDORA_REQUIRE_APPROVALS = "1"; process.env.SANDORA_ALLOW_LOCAL_MERGE = "1";
  try {
    const receipts = new ToolReceiptStore({ cwd, sessionId: "approval", runtime: "native" });
    await assert.rejects(() => receipts.execute({ toolCallId: "one", toolName: "git_merge", args: { branch: "feature" }, invoke: async () => "must not run" }), /approval missing/i);
  } finally { if (oldMode === undefined) delete process.env.SANDORA_REQUIRE_APPROVALS; else process.env.SANDORA_REQUIRE_APPROVALS = oldMode; if (oldAuth === undefined) delete process.env.SANDORA_ALLOW_LOCAL_MERGE; else process.env.SANDORA_ALLOW_LOCAL_MERGE = oldAuth; await rm(cwd, { recursive: true, force: true }); }
});

test("duplicate receipt contenders do not consume approval before execution ownership", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "sandora-approval-owner-"));
  const oldMode = process.env.SANDORA_REQUIRE_APPROVALS, oldAuth = process.env.SANDORA_ALLOW_LOCAL_MERGE;
  process.env.SANDORA_REQUIRE_APPROVALS = "1"; process.env.SANDORA_ALLOW_LOCAL_MERGE = "1";
  try {
    const args = { branch: "feature" }; const approvals = new ApprovalStore({ cwd });
    await approvals.create({ toolName: "git_merge", args, authorityVariable: "SANDORA_ALLOW_LOCAL_MERGE", decision: "ALLOW", expiresAt: future(), maxUses: 2 });
    let effects = 0; const stores = [1, 2].map(() => new ToolReceiptStore({ cwd, sessionId: "claim-order", runtime: "native" }));
    const outcomes = await Promise.allSettled(stores.map(store => store.execute({ toolCallId: "same-call", toolName: "git_merge", args, invoke: async () => { effects += 1; return "done"; } })));
    assert.equal(effects, 1); assert.equal(outcomes.filter(item => item.status === "fulfilled").length, 1);
    assert.equal((await approvals.consume({ toolName: "git_merge", inputSha256: canonicalInputSha256(args), authorityVariable: "SANDORA_ALLOW_LOCAL_MERGE" })).status, "APPROVED");
  } finally { if (oldMode === undefined) delete process.env.SANDORA_REQUIRE_APPROVALS; else process.env.SANDORA_REQUIRE_APPROVALS = oldMode; if (oldAuth === undefined) delete process.env.SANDORA_ALLOW_LOCAL_MERGE; else process.env.SANDORA_ALLOW_LOCAL_MERGE = oldAuth; await rm(cwd, { recursive: true, force: true }); }
});
