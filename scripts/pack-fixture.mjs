import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { cp, lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";
import { redactedMessage } from "../lib/safety.mjs";

// Exercise the real packer with private-file sentinels in a disposable source
// copy. Reuse installed dependencies for import only; do not install or publish.
const source = fileURLToPath(new URL("../", import.meta.url));
const checker = fileURLToPath(new URL("./check-package.mjs", import.meta.url));
const pm = process.env.ANYROUTER_TEST_PNPM || process.env.npm_execpath;
if (!pm || !path.isAbsolute(pm)) throw new Error("Use pnpm run check:pack, or set ANYROUTER_TEST_PNPM to an absolute native executable/CLI JS path.");
assert.equal((await lstat(pm)).isFile(), true);
const javascriptPM = /\.(?:cjs|mjs|js)$/i.test(pm);
if (process.platform === "win32" && /\.(?:cmd|bat|ps1)$/i.test(pm)) throw new Error("Provide the actual pnpm executable or CLI JS file, not a Windows shell wrapper.");
const parent = await realpath(tmpdir()), temporary = await mkdtemp(path.join(parent, "anyrouter-pack-fixture-"));
const env = { ...process.env, npm_config_ignore_scripts: "true" };
function command(executable, argv, cwd) {
  const result = spawnSync(executable, argv, { cwd, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 30000, maxBuffer: 4 * 1024 * 1024 });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, `Package fixture command failed: ${path.basename(executable)} ${argv[0]}: ${redactedMessage(result.stderr || result.stdout || "no child error detail")}`);
  return result.stdout;
}
const pack = (argv, cwd) => command(javascriptPM ? process.execPath : pm, javascriptPM ? [pm, ...argv] : argv, cwd);
const check = argv => command(process.execPath, [checker, ...argv], source);
const payload = text => { const value = JSON.parse(text); return Array.isArray(value) ? value[0] : value; };
try {
  check([]); // Reject lifecycle requirements/invalid source before invoking pack.
  const initialText = pack(["pack", "--dry-run", "--json"], source), initial = payload(initialText);
  const initialReport = path.join(temporary, "initial-report.json"); await writeFile(initialReport, initialText);
  check(["--report", initialReport]);
  const copy = path.join(temporary, "source"), packed = path.join(temporary, "packed"), extracted = path.join(temporary, "extracted");
  await mkdir(copy); await mkdir(packed); await mkdir(extracted);
  for (const item of initial.files) {
    const name = typeof item === "string" ? item : item.path;
    assert.ok(typeof name === "string" && !path.isAbsolute(name) && !name.split(/[\\/]/).includes(".."));
    const target = path.join(copy, name); await mkdir(path.dirname(target), { recursive: true });
    await cp(path.join(source, name), target);
  }
  const sentinel = `ANYROUTER_PRIVATE_FIXTURE_${randomUUID()}`;
  for (const name of ["lib/content-filter.local.json", "plugin-auth.json", "private-probe.log"]) {
    await writeFile(path.join(copy, name), JSON.stringify({ privateSentinel: sentinel }));
  }
  const reportText = pack(["pack", "--pack-destination", packed, "--json"], copy), report = payload(reportText);
  const reportPath = path.join(temporary, "packed-report.json"); await writeFile(reportPath, reportText);
  check(["--root", copy, "--report", reportPath, "--no-import"]);
  const archive = path.join(packed, `${report.name}-${report.version}.tgz`);
  assert.equal((await lstat(archive)).isFile(), true);
  const bytes = await readFile(archive);
  assert.ok(bytes.byteLength < 32 * 1024 * 1024);
  assert.equal(gunzipSync(bytes).includes(Buffer.from(sentinel)), false, "Private fixture data must not exist anywhere in the actual archive.");
  // Relative forward-slash paths work with both native Windows tar and MSYS
  // GNU tar; a drive-letter archive must not be mistaken for host:archive.
  const listed = command("tar", ["-tzf", path.basename(archive)], packed).split(/\r?\n/).filter(Boolean);
  const allowed = new Set(report.files.map(item => `package/${typeof item === "string" ? item : item.path}`));
  for (const name of listed) assert.ok(allowed.has(name) || name === "package/" || name === "package/lib/", "Unexpected archive member; refuse extraction.");
  command("tar", ["-xzf", path.relative(extracted, archive).split(path.sep).join("/")], extracted);
  const smoke = payload(check(["--root", path.join(extracted, "package"), "--report", reportPath, "--smoke"]));
  assert.equal(smoke.isolatedImport, true);
  console.log(JSON.stringify({ package: report.name, version: report.version, publishedFiles: report.files.length,
    privateSentinelExcluded: true, actualArchiveImported: true, borrowedInstalledDependencies: smoke.borrowedInstalledDependencies }));
} finally {
  const resolved = await realpath(temporary);
  assert.equal(path.dirname(resolved).toLowerCase(), parent.toLowerCase());
  assert.match(path.basename(resolved), /^anyrouter-pack-fixture-/);
  await rm(resolved, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
}
