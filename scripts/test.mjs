import { readdir } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

// Pass explicit filenames so Node 20 on Windows does not depend on cmd.exe
// expanding globs or accidentally discovering the preload fixture as a test.
const root = fileURLToPath(new URL("../", import.meta.url));
const files = (await readdir(path.join(root, "test"))).filter(name => name.endsWith(".test.mjs")).sort();
if (!files.length) throw new Error("No top-level regression test files found.");
const args = process.argv.slice(2);
if (args[0] === "--") args.shift();
const result = spawnSync(process.execPath, ["--test", "--test-concurrency=1", ...args, ...files.map(name => path.join(root, "test", name))], {
  cwd: root, stdio: "inherit", env: process.env,
});
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
