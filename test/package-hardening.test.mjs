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
  assert.equal(value.runtimeModules, 19);
  assert.equal(value.publishedFiles, 28);
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
