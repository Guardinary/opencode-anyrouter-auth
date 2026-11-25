import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cp, lstat, mkdir, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// Run only against this trusted source or its own generated package. Importing
// arbitrary third-party code is not a sandbox. No installer or network is used.
const sourceRoot = fileURLToPath(new URL("../", import.meta.url));
const args = process.argv.slice(2);
let targetRoot = sourceRoot, reportPath, smoke = false, skipImport = false;
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--root" && args[i + 1]) targetRoot = path.resolve(args[++i]);
  else if (args[i] === "--report" && args[i + 1]) reportPath = path.resolve(args[++i]);
  else if (args[i] === "--smoke") smoke = true;
  else if (args[i] === "--no-import") skipImport = true;
  else throw new Error(`Unknown package-check option: ${args[i]}`);
}
const documents = ["CHANGELOG.md", "content-filter.example.json", "DESIGN.md", "icon.png", "index.mjs", "LICENSE", "package.json", "README.md", "SECURITY.md", "UPSTREAM.md"];
const posix = name => name.split(path.sep).join("/").replace(/^\.\//, "");
const inside = (root, name) => {
  const file = path.resolve(root, name), relative = path.relative(root, file);
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error("Package file escaped its root.");
  return file;
};
async function regular(root, name) {
  const file = inside(root, name);
  assert.equal((await lstat(file)).isFile(), true, `Expected a regular package file: ${name}`);
  return file;
}
async function inspect(root) {
  const pkg = JSON.parse(await readFile(await regular(root, "package.json"), "utf8"));
  assert.equal(pkg.name, "opencode-anyrouter-auth");
  assert.match(pkg.version, /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/);
  assert.equal(pkg.type, "module");
  assert.equal(pkg.main, "./index.mjs");
  assert.equal(pkg.exports?.["."], "./index.mjs");
  assert.equal(pkg.exports?.["./server"], "./index.mjs");
  assert.equal(pkg.engines?.node, ">=20.3.0");
  assert.equal(pkg.magpie?.name, "AnyRouter");
  assert.ok(pkg.magpie?.summary?.zh && pkg.magpie?.summary?.en && pkg.magpie?.icon);
  assert.ok(Number.isSafeInteger(pkg.magpie.maxConcurrency) && pkg.magpie.maxConcurrency > 0);
  assert.deepEqual(Object.keys(pkg.dependencies ?? {}), ["tough-cookie"]);
  assert.match(pkg.dependencies["tough-cookie"], /^\^6\./);
  for (const name of ["preinstall", "install", "postinstall", "prepare", "prepack", "postpack", "prepublish", "prepublishOnly"]) {
    assert.equal(pkg.scripts?.[name], undefined, "The package must not require lifecycle execution.");
  }
  assert.ok(pkg.files?.includes("lib/*.mjs"), "Runtime whitelist must exclude private JSON files.");
  assert.equal(pkg.files?.includes("lib/"), false);
  for (const name of documents) await regular(root, name);
  const seen = new Set(), queue = ["index.mjs"];
  while (queue.length) {
    const name = posix(path.normalize(queue.shift()));
    if (seen.has(name)) continue;
    seen.add(name);
    const file = await regular(root, name), text = await readFile(file, "utf8");
    const result = spawnSync(process.execPath, ["--check", file], { stdio: "inherit" });
    if (result.error) throw result.error;
    assert.equal(result.status, 0, `Syntax check failed: ${name}`);
    for (const match of text.matchAll(/(?:from\s+|import\s*\(?\s*)["'](\.\.?\/[^"']+)["']/g)) {
      const relative = posix(path.join(path.dirname(name), match[1]));
      inside(root, relative);
      assert.ok(relative.endsWith(".mjs"), "Every relative runtime import must be a shipped module.");
      queue.push(relative);
    }
  }
  const allowed = new Set([...documents, ...seen]);
  if (reportPath) {
    const value = JSON.parse(await readFile(reportPath, "utf8"));
    const report = Array.isArray(value) ? value[0] : value;
    assert.equal(report.name, pkg.name); assert.equal(report.version, pkg.version);
    assert.ok(Array.isArray(report.files) && report.files.length);
    const actual = new Set(report.files.map(item => typeof item === "string" ? item : item.path));
    for (const name of actual) assert.ok(allowed.has(name), `Unexpected published file: ${name}`);
    for (const name of allowed) assert.ok(actual.has(name), `Missing published file: ${name}`);
  }
  return { pkg, seen, allowed };
}
async function importCheck(root) {
  const old = globalThis.fetch;
  globalThis.fetch = () => { throw new Error("Network refused during package import smoke check."); };
  try {
    const entry = await import(pathToFileURL(path.join(root, "index.mjs")).href);
    assert.equal(entry.default.id, "opencode-anyrouter-auth");
    assert.equal(typeof entry.default.server, "function");
    const hooks = await entry.default.server({}, {}), cfg = {};
    assert.equal(hooks.auth.provider, "anyrouter");
    assert.equal(hooks.auth.methods.length, 6);
    await hooks.config(cfg);
    assert.equal(cfg.provider.anyrouter.models["gpt-6.1-sol"].provider.npm, "@ai-sdk/openai");
    assert.equal(cfg.provider.anyrouter.models["claude-opus-4-6"].provider.npm, "@ai-sdk/anthropic");
  } finally { globalThis.fetch = old; }
}
async function dependencyRoot(name, from) {
  const require = createRequire(path.join(from, "package.json"));
  let directory = path.dirname(require.resolve(name));
  for (let depth = 0; depth < 8; depth++) {
    try {
      const pkg = JSON.parse(await readFile(path.join(directory, "package.json"), "utf8"));
      if (pkg.name === name) return { directory: await realpath(directory), pkg };
    } catch {}
    const parent = path.dirname(directory); if (parent === directory) break;
    directory = parent;
  }
  throw new Error(`Installed dependency root not found: ${name}`);
}
async function copyDependencies(name, from, destination, seen) {
  const { directory, pkg } = await dependencyRoot(name, from);
  if (seen.has(name)) { assert.equal(seen.get(name), pkg.version, "Conflicting dependency versions cannot be flattened in this smoke fixture."); return; }
  seen.set(name, pkg.version);
  await cp(directory, path.join(destination, "node_modules", name), { recursive: true, dereference: true,
    filter: file => !path.relative(directory, file).split(path.sep).includes("node_modules") });
  for (const child of Object.keys(pkg.dependencies ?? {})) await copyDependencies(child, directory, destination, seen);
}

const result = await inspect(targetRoot);
if (smoke) {
  const parent = await realpath(tmpdir());
  const temporary = await mkdtemp(path.join(parent, "anyrouter-package-import-"));
  try {
    const root = path.join(temporary, "package"); await mkdir(root);
    for (const name of result.allowed) {
      const target = inside(root, name); await mkdir(path.dirname(target), { recursive: true });
      await cp(await regular(targetRoot, name), target);
    }
    const dependencies = new Map();
    await copyDependencies("tough-cookie", sourceRoot, root, dependencies);
    await importCheck(root);
    console.log(JSON.stringify({ package: result.pkg.name, version: result.pkg.version, runtimeModules: result.seen.size,
      publishedFiles: result.allowed.size, isolatedImport: true, borrowedInstalledDependencies: Object.fromEntries(dependencies) }));
  } finally {
    const resolved = await realpath(temporary);
    assert.equal(path.dirname(resolved).toLowerCase(), parent.toLowerCase());
    assert.match(path.basename(resolved), /^anyrouter-package-import-/);
    await rm(resolved, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
} else {
  if (!skipImport) await importCheck(targetRoot);
  console.log(JSON.stringify({ package: result.pkg.name, version: result.pkg.version, runtimeModules: result.seen.size,
    publishedFiles: result.allowed.size, import: !skipImport, reportChecked: Boolean(reportPath) }));
}
