import { readdir } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";
import { pathToFileURL } from "node:url";

export async function discoverBuilderTests(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const tests = [];
  for (const entry of entries) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) tests.push(...await discoverBuilderTests(file));
    else if (entry.isFile() && /\.test\.(ts|mjs)$/u.test(entry.name)) tests.push(file);
  }
  return tests.sort();
}

export async function runBuilderTests(root, args = [], { stdio = "inherit" } = {}) {
  const tests = await discoverBuilderTests(path.join(root, "test"));
  if (tests.length === 0) throw new Error("No Builder tests found.");
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const child = spawn(process.execPath, ["--experimental-strip-types", "--test", "--test-concurrency=1", ...args, ...tests],
    { cwd: root, stdio, env, shell: false, windowsHide: true });
  const result = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  if (result.signal || result.code === null) throw new Error("Builder test process ended without a result.");
  return result.code;
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  process.exitCode = await runBuilderTests(path.resolve(import.meta.dirname, ".."), process.argv.slice(2));
}
