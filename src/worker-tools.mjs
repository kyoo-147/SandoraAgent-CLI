import { readdir, readFile, stat, realpath } from "node:fs/promises";
import { resolve, relative, sep } from "node:path";
import { Type } from "typebox";

function inside(root, value) {
  const candidate = resolve(root, value || ".");
  const distance = relative(root, candidate);
  if (distance.startsWith(`..${sep}`) || distance === ".." || distance.includes(`${sep}..${sep}`)) {
    throw new Error("Path must remain inside the worker workspace");
  }
  return candidate;
}

async function checkedPath(root, value) {
  const candidate = inside(root, value);
  const actual = await realpath(candidate);
  const actualRoot = await realpath(root);
  if (actual !== actualRoot && !actual.startsWith(`${actualRoot}${sep}`)) throw new Error("Symlink escapes worker workspace");
  return actual;
}

async function walk(root, current, output, limit = 500) {
  if (output.length >= limit) return;
  for (const entry of await readdir(current, { withFileTypes: true })) {
    if ([".git", "node_modules", ".pi"].includes(entry.name)) continue;
    const next = resolve(current, entry.name);
    if (entry.isDirectory()) await walk(root, next, output, limit);
    else {
      try {
        const safe = await checkedPath(root, next);
        const safeInfo = await stat(safe);
        if (safeInfo.isFile()) output.push(relative(root, safe));
      } catch { /* skip symlinks and paths outside the workspace */ }
    }
    if (output.length >= limit) return;
  }
}

function result(text, details = {}) {
  return { content: [{ type: "text", text }], details };
}

export default function workerTools(pi) {
  pi.registerTool({
    name: "workspace_read",
    label: "Workspace read",
    description: "Read a text file inside the selected workspace. Paths cannot escape the workspace.",
    parameters: Type.Object({ path: Type.String(), offset: Type.Optional(Type.Integer({ minimum: 1 })), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 2000 })) }),
    async execute(_id, params, _signal, _update, ctx) {
      const file = await checkedPath(ctx.cwd, params.path);
      const fileInfo = await stat(file);
      if (!fileInfo.isFile() || fileInfo.size > 2_000_000) throw new Error("File is missing, not regular, or larger than 2 MB");
      const text = await readFile(file, "utf8");
      const rows = text.split(/\r?\n/);
      const start = Math.max(1, params.offset || 1);
      const end = Math.min(rows.length, start + (params.limit || 200) - 1);
      return result(rows.slice(start - 1, end).map((row, i) => `${start + i}: ${row}`).join("\n"), { path: params.path, start, end });
    },
  });
  pi.registerTool({
    name: "workspace_search",
    label: "Workspace search",
    description: "Search text across workspace files, excluding .git, node_modules, and .pi.",
    parameters: Type.Object({ pattern: Type.String(), path: Type.Optional(Type.String()) }),
    async execute(_id, params, signal, _update, ctx) {
      const root = await realpath(ctx.cwd);
      const base = await checkedPath(root, params.path || ".");
      const files = [];
      const info = await stat(base);
      if (info.isFile()) files.push(base); else await walk(root, base, files);
      const needle = params.pattern.toLocaleLowerCase();
      const matches = [];
      for (const file of files) {
        if (signal?.aborted) throw new Error("Workspace search aborted");
        try {
          if ((await stat(file)).size > 2_000_000) continue;
          const rows = (await readFile(file, "utf8")).split(/\r?\n/);
          rows.forEach((line, i) => { if (line.toLocaleLowerCase().includes(needle) && matches.length < 200) matches.push(`${relative(root, file)}:${i + 1}: ${line}`); });
        } catch { /* binary/unreadable files are skipped */ }
      }
      return result(matches.join("\n") || "No matches.", { matchCount: matches.length });
    },
  });
  pi.registerTool({
    name: "workspace_list",
    label: "Workspace list",
    description: "List files inside the selected workspace.",
    parameters: Type.Object({ path: Type.Optional(Type.String()) }),
    async execute(_id, params, _signal, _update, ctx) {
      const root = await realpath(ctx.cwd);
      const base = await checkedPath(root, params.path || ".");
      const files = [];
      await walk(root, base, files);
      return result(files.join("\n") || "No files.", { count: files.length });
    },
  });
}
