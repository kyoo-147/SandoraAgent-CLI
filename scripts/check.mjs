import { spawn } from "node:child_process";
import { readdir } from "node:fs/promises";
import { dirname, extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const roots = ["src", "scripts", "apps", "packages"];

async function collect(directory) {
  let entries;
  try { entries = await readdir(resolve(root, directory), { withFileTypes: true }); }
  catch (error) { if (error.code === "ENOENT") return []; throw error; }
  const files = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const path = `${directory}/${entry.name}`;
    if (entry.isDirectory()) files.push(...await collect(path));
    else if (entry.isFile() && [".js", ".mjs", ".cjs"].includes(extname(entry.name))) files.push(path);
  }
  return files;
}

const files = ["start.mjs", ...(await Promise.all(roots.map(collect))).flat()].sort();
for (const file of files) {
  const result = await new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, ["--check", file], { cwd: root, stdio: "inherit", shell: false });
    child.once("error", reject);
    child.once("close", (code, signal) => resolvePromise({ code, signal }));
  });
  if (result.code !== 0) process.exit(result.code || 1);
}
console.log(`Syntax check passed (${files.length} files)`);
