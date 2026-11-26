import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = fileURLToPath(new URL("../", import.meta.url));
const checker = path.join(root, "scripts", "check-package.mjs");
// This checks the Node dev command even when the outer suite runs in Bun.
const node = process.versions.bun ? process.env.NODE_BINARY || "node" : process.execPath;
function run(...args) {
  const result = spawnSync(node, [checker, ...args], { cwd: root, encoding: "utf8", timeout: 10000 });
  if (result.error) throw result.error;
  return result;
}
test("package gate validates source metadata, runtime graph and no-network import", () => {
  const result = run();
  assert.equal(result.status, 0);
  const value = JSON.parse(result.stdout);
  assert.equal(value.package, "opencode-anyrouter-auth");
  assert.equal(value.import, true);
  assert.equal(value.runtimeModules, 20);
  assert.equal(value.publishedFiles, 29);
});

test("archive fixture reports bounded, redacted child failures rather than hiding the root cause", async () => {
  const parent = await realpath(tmpdir()), directory = await mkdtemp(path.join(parent, "anyrouter-packer-error-"));
  try {
    const packer = path.join(directory, "packer.cjs");
    await writeFile(packer, 'console.error("ERR_SYNTHETIC_PACK_FAILURE sk-synthetic-echoed-secret"); process.exit(2);');
    const result = spawnSync(node, [path.join(root, "scripts", "pack-fixture.mjs")], {
      cwd: root, encoding: "utf8", timeout: 10000, env: { ...process.env, ANYROUTER_TEST_PNPM: packer },
    });
    if (result.error) throw result.error;
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /ERR_SYNTHETIC_PACK_FAILURE/);
    assert.equal(result.stderr.includes("sk-synthetic-echoed-secret"), false);
  } finally {
    const resolved = await realpath(directory);
    assert.equal(path.dirname(resolved).toLowerCase(), parent.toLowerCase());
    assert.match(path.basename(resolved), /^anyrouter-packer-error-/);
    await rm(resolved, { recursive: true, force: true });
  }
});

test("archive smoke retains dependency files when copy filters receive Windows namespaced paths", async () => {
  const parent = await realpath(tmpdir()), directory = await mkdtemp(path.join(parent, "anyrouter-copy-path-"));
  try {
    const preloader = path.join(directory, "namespaced-copy.cjs");
    await writeFile(preloader, `
      const fs = require("node:fs/promises"), path = require("node:path");
      const copy = fs.cp;
      fs.cp = (source, target, options = {}) => copy(source, target, {
        ...options,
        ...(options.filter ? { filter: (file, destination) => options.filter(path.toNamespacedPath(file), destination) } : {}),
      });
    `);
    const result = spawnSync(node, ["--require", preloader, checker, "--smoke"], { cwd: root, encoding: "utf8", timeout: 10000 });
    if (result.error) throw result.error;
    assert.equal(result.status, 0, "Copied dependencies must remain importable through either Windows path form.");
    assert.equal(JSON.parse(result.stdout).isolatedImport, true);
  } finally {
    const resolved = await realpath(directory);
    assert.equal(path.dirname(resolved).toLowerCase(), parent.toLowerCase());
    assert.match(path.basename(resolved), /^anyrouter-copy-path-/);
    await rm(resolved, { recursive: true, force: true });
  }
});

test("package gate refuses a private-file pack report instead of trusting the manifest", async () => {
  const parent = await realpath(tmpdir()), directory = await mkdtemp(path.join(parent, "anyrouter-package-report-"));
  try {
    const pkg = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
    const report = path.join(directory, "report.json");
    await writeFile(report, JSON.stringify({ name: pkg.name, version: pkg.version, files: [{ path: "lib/content-filter.local.json" }] }));
    const result = run("--report", report, "--no-import");
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Unexpected published file: lib\/content-filter\.local\.json/);
  } finally {
    const resolved = await realpath(directory);
    assert.equal(path.dirname(resolved).toLowerCase(), parent.toLowerCase());
    assert.match(path.basename(resolved), /^anyrouter-package-report-/);
    await rm(resolved, { recursive: true, force: true });
  }
});
