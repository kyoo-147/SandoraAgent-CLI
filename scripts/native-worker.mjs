import { createHash } from "node:crypto";
import { readFile, realpath, stat } from "node:fs/promises";
import { resolve, relative, isAbsolute } from "node:path";
import registerWorkerTools from "../src/agents/worker-tools.mjs";
import { NativeToolRegistry } from "../src/tools/registry.mjs";

const MAX_REQUEST_BYTES = 64 * 1024;
const MAX_RESULT_BYTES = 256 * 1024;
const idPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const fail = (message) => { process.stderr.write(`native-worker: ${message}\n`.slice(0, 16 * 1024)); process.exitCode = 1; };
const validId = (v) => typeof v === "string" && idPattern.test(v);
const bounded = (value, max) => Buffer.byteLength(String(value), "utf8") <= max;
const validDigest = value => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const sha256 = value => createHash("sha256").update(value).digest("hex");

let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", chunk => { input += chunk; if (Buffer.byteLength(input) > MAX_REQUEST_BYTES + 1) { fail("request exceeds byte cap"); process.exit(1); } });
process.stdin.on("end", async () => {
  try {
    const lines = input.split("\n").filter(Boolean);
    if (lines.length !== 1) throw new Error("exactly one request line is required");
    const request = JSON.parse(lines[0]);
    if (!request || request.protocol !== "sandora-worker" || request.version !== 1 || request.kind !== "request") throw new Error("invalid protocol envelope");
    for (const key of ["runId", "taskId", "attemptId"]) if (!validId(request[key])) throw new Error(`invalid ${key}`);
    if (typeof request.prompt !== "string" || !request.prompt || typeof request.workspaceRoot !== "string" || !isAbsolute(request.workspaceRoot)) throw new Error("invalid request fields");
    const workspaceRoot = await realpath(resolve(request.workspaceRoot));
    const registry = registerWorkerTools(new NativeToolRegistry());
    let result;
    if (request.providerMode === "trusted-adapter" && request.adapterModule) {
      const modulePath = await realpath(resolve(workspaceRoot, request.adapterModule));
      const relation = relative(workspaceRoot, modulePath);
      if (relation.startsWith("..") || isAbsolute(relation) || !(await stat(modulePath)).isFile()) throw new Error("adapter must be a regular file inside workspace");
      if (!validDigest(request.adapterContentSha256) || !validDigest(request.adapterPathSha256)) throw new Error("adapter identity is required");
      const adapterBytes = await readFile(modulePath);
      if (sha256(modulePath) !== request.adapterPathSha256 || sha256(adapterBytes) !== request.adapterContentSha256) throw new Error("adapter identity mismatch");
      // Execute the exact verified bytes. Trusted adapters are intentionally
      // self-contained modules; relative imports from this data URL are unsupported.
      const adapter = await import(`data:text/javascript;base64,${adapterBytes.toString("base64")}`);
      const run = adapter.run ?? adapter.default;
      if (typeof run !== "function") throw new Error("adapter must export run(request, context)");
      result = await run(Object.freeze({ ...request, workspaceRoot }), { registry, workspaceRoot });
    } else throw new Error("no explicit worker provider configured");
    result = typeof result === "object" && result !== null ? result.result : result;
    if (!bounded(result ?? "", MAX_RESULT_BYTES)) throw new Error("result exceeds byte cap");
    const envelope = { protocol: "sandora-worker", version: 1, kind: "result", runId: request.runId, taskId: request.taskId, attemptId: request.attemptId, status: "succeeded", result: String(result ?? "") };
    const line = JSON.stringify(envelope);
    if (!bounded(line, MAX_RESULT_BYTES)) throw new Error("result envelope exceeds byte cap");
    process.stdout.write(`${line}\n`);
  } catch (error) { fail(error instanceof Error ? error.message : String(error)); }
});
process.on("SIGTERM", () => process.exit(143));
process.on("SIGINT", () => process.exit(130));
