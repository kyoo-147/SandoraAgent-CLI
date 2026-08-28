import { Type } from "typebox";
import { defineTool, toolText } from "../tools/registry.mjs";
import { runBounded, workspaceRelativePath } from "../tools/coding-tools.mjs";

const branchSchema = Type.String({ minLength: 1, maxLength: 128 });
const remoteSchema = Type.Optional(Type.String({ minLength: 1, maxLength: 64, default: "origin" }));

function validRemote(remote) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(remote)) throw new Error("Invalid Git remote name");
  return remote;
}

async function checked(command, args, options) {
  const result = await runBounded(command, args, options);
  if (result.details?.code !== 0) throw new Error(toolText(result));
  return result;
}
function commandOutput(result) {
  const value = toolText(result);
  return value.includes("\n") ? value.slice(value.indexOf("\n") + 1).trim() : "";
}

async function currentBranch(options) {
  const result = await checked("git", ["branch", "--show-current"], options);
  const branch = commandOutput(result);
  if (!branch) throw new Error("Git operation requires a named branch");
  return branch;
}

function assertUnprotectedBranch(branch) {
  if (["main", "master"].includes(branch.toLowerCase())) throw new Error(`Refusing mutation on protected branch: ${branch}`);
  return branch;
}

function parseGhJson(result) {
  const output = commandOutput(result);
  try { return JSON.parse(output); } catch { throw new Error("GitHub CLI returned invalid JSON"); }
}

function assertMergeChecks(pr, allowUnchecked) {
  if (pr.state !== "OPEN") throw new Error(`Refusing to merge a pull request that is not open: ${pr.state || "unknown"}`);
  if (pr.isDraft) throw new Error("Refusing to merge a draft pull request");
  if (pr.mergeable !== "MERGEABLE") throw new Error(`Pull request is not safely mergeable: ${pr.mergeable || "unknown"}`);
  if (pr.reviewDecision === "CHANGES_REQUESTED") throw new Error("Pull request has requested changes");
  const checks = Array.isArray(pr.statusCheckRollup) ? pr.statusCheckRollup : [];
  if (!checks.length && !allowUnchecked) throw new Error("Pull request has no completed checks; set SANDORA_ALLOW_UNCHECKED_PR_MERGE=1 only with explicit authority");
  const failed = checks.filter(check => !["SUCCESS", "SKIPPED", "NEUTRAL"].includes(check.conclusion || check.state));
  if (failed.length) throw new Error(`Pull request checks are not successful: ${failed.map(check => check.name || check.context || "check").join(", ")}`);
}

async function validBranch(branch, options) {
  if (typeof branch !== "string" || !branch || branch.includes("..") || branch.includes("@{") || branch.startsWith("-") || branch.endsWith("/") || branch.endsWith(".")) throw new Error("Invalid Git branch name");
  await checked("git", ["check-ref-format", "--branch", branch], options);
  return branch;
}

export function createGitTools({
  allowLocalMerge = process.env.SANDORA_ALLOW_LOCAL_MERGE === "1",
  allowPrMerge = process.env.SANDORA_ALLOW_PR_MERGE === "1",
  allowUncheckedPrMerge = process.env.SANDORA_ALLOW_UNCHECKED_PR_MERGE === "1",
  runGitHub = (args, options) => checked("gh", args, options),
} = {}) {
  return [
    defineTool({ name: "git_status", label: "Git status", description: "Show machine-readable repository status and current branch.", parameters: Type.Object({}), execute: (_id, _p, signal, _update, ctx) => checked("git", ["status", "--short", "--branch"], { cwd: ctx.cwd, signal }) }),
    defineTool({ name: "git_diff", label: "Git diff", description: "Show the current unstaged or staged Git diff, optionally restricted to paths.", parameters: Type.Object({ staged: Type.Optional(Type.Boolean()), paths: Type.Optional(Type.Array(Type.String(), { maxItems: 100 })) }), execute: async (_id, p, signal, _update, ctx) => { const paths = await Promise.all((p.paths || []).map(path => workspaceRelativePath(ctx.cwd, path))); return checked("git", ["diff", "--no-ext-diff", ...(p.staged ? ["--cached"] : []), "--", ...paths], { cwd: ctx.cwd, signal }); } }),
    defineTool({ name: "git_history", label: "Git history", description: "Show recent commit history.", parameters: Type.Object({ limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })) }), execute: (_id, p, signal, _update, ctx) => checked("git", ["log", `-${p.limit || 20}`, "--oneline", "--decorate"], { cwd: ctx.cwd, signal }) }),
    defineTool({ name: "git_branch_create", label: "Create Git branch", description: "Create and switch to a validated feature branch inside the repository.", parameters: Type.Object({ branch: branchSchema }), execute: async (_id, p, signal, _update, ctx) => checked("git", ["switch", "-c", await validBranch(p.branch, { cwd: ctx.cwd, signal })], { cwd: ctx.cwd, signal }) }),
    defineTool({ name: "git_commit", label: "Git commit", description: "On a feature branch, stage only explicitly listed workspace paths, verify the staged diff, and create a commit.", parameters: Type.Object({ message: Type.String({ minLength: 1, maxLength: 200 }), paths: Type.Array(Type.String({ minLength: 1 }), { minItems: 1, maxItems: 100 }) }), execute: async (_id, p, signal, _update, ctx) => { assertUnprotectedBranch(await currentBranch({ cwd: ctx.cwd, signal })); const paths = await Promise.all(p.paths.map(path => workspaceRelativePath(ctx.cwd, path))); await checked("git", ["add", "-A", "--", ...paths], { cwd: ctx.cwd, signal }); await checked("git", ["diff", "--cached", "--check"], { cwd: ctx.cwd, signal }); return checked("git", ["commit", "-m", p.message], { cwd: ctx.cwd, signal }); } }),
    defineTool({ name: "git_push", label: "Git push", description: "Push one validated non-protected branch to a named Git remote without force.", parameters: Type.Object({ branch: branchSchema, remote: remoteSchema }), execute: async (_id, p, signal, _update, ctx) => { const branch = assertUnprotectedBranch(await validBranch(p.branch, { cwd: ctx.cwd, signal })); return checked("git", ["push", "--set-upstream", validRemote(p.remote || "origin"), branch], { cwd: ctx.cwd, signal, timeoutMs: 30_000 }); } }),
    defineTool({ name: "git_merge", label: "Git merge", description: "Merge a validated branch into a non-protected current branch without force or history rewriting only when SANDORA_ALLOW_LOCAL_MERGE=1 grants runtime authority.", parameters: Type.Object({ branch: branchSchema }), execute: async (_id, p, signal, _update, ctx) => { if (!allowLocalMerge) throw new Error("Local merge capability is disabled; set SANDORA_ALLOW_LOCAL_MERGE=1 with explicit authority"); assertUnprotectedBranch(await currentBranch({ cwd: ctx.cwd, signal })); const branch = await validBranch(p.branch, { cwd: ctx.cwd, signal }); return checked("git", ["merge", "--no-ff", branch, "-m", `Merge ${branch}`], { cwd: ctx.cwd, signal }); } }),
    defineTool({ name: "github_pr_view", label: "View GitHub PR", description: "Inspect a pull request, its diff, or checks through the authenticated gh CLI.", parameters: Type.Object({ number: Type.Integer({ minimum: 1 }), view: Type.Optional(Type.Union([Type.Literal("summary"), Type.Literal("diff"), Type.Literal("checks")])) }), execute: (_id, p, signal, _update, ctx) => { const args = p.view === "diff" ? ["pr", "diff", String(p.number)] : p.view === "checks" ? ["pr", "checks", String(p.number)] : ["pr", "view", String(p.number), "--json", "number,title,state,headRefName,baseRefName,url,mergeable,statusCheckRollup"]; return runGitHub(args, { cwd: ctx.cwd, signal }); } }),
    defineTool({ name: "github_pr_create", label: "Create GitHub PR", description: "Create a pull request from a pushed feature branch after tests and self-review.", parameters: Type.Object({ head: branchSchema, base: Type.Optional(branchSchema), title: Type.String({ minLength: 1, maxLength: 200 }), body: Type.String({ maxLength: 20_000 }) }), execute: async (_id, p, signal, _update, ctx) => runGitHub(["pr", "create", "--head", await validBranch(p.head, { cwd: ctx.cwd, signal }), "--base", p.base ? await validBranch(p.base, { cwd: ctx.cwd, signal }) : "main", "--title", p.title, "--body", p.body], { cwd: ctx.cwd, signal }) }),
    defineTool({ name: "github_pr_merge", label: "Merge GitHub PR", description: "Merge an open, non-draft, mergeable pull request only when runtime authority is enabled and checks pass. Never force-push.", parameters: Type.Object({ number: Type.Integer({ minimum: 1 }), deleteBranch: Type.Optional(Type.Boolean()) }), execute: async (_id, p, signal, _update, ctx) => { if (!allowPrMerge) throw new Error("Pull-request merge capability is disabled; set SANDORA_ALLOW_PR_MERGE=1 with explicit authority"); const state = parseGhJson(await runGitHub(["pr", "view", String(p.number), "--json", "state,isDraft,mergeable,reviewDecision,statusCheckRollup"], { cwd: ctx.cwd, signal })); assertMergeChecks(state, allowUncheckedPrMerge); return runGitHub(["pr", "merge", String(p.number), "--merge", ...(p.deleteBranch === false ? [] : ["--delete-branch"])], { cwd: ctx.cwd, signal }); } }),
  ];
}

export default function registerGitTools(registry) { registry.registerAll(createGitTools()); return registry; }
