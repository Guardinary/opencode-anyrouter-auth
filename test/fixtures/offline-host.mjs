import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

export const root = fileURLToPath(new URL("../../", import.meta.url));
export const preload = fileURLToPath(new URL("./host-preload.mjs", import.meta.url));
export const frame = (value, event = "") => `${event ? `event: ${event}\n` : ""}data: ${JSON.stringify(value)}\n\n`;
export const profile = { id: 123, username: "alice", email: "alice@example.test", quota: 12345678, used_quota: 2345678 };
export const apiKey = "sk-synthetic-offline-model";

export async function existingProgram(value) {
  assert.ok(typeof value === "string" && path.isAbsolute(value), "Integration executables/scripts must use absolute native paths.");
  assert.equal((await stat(value)).isFile(), true);
  return value;
}

export function isolatedEnv(home, bun) {
  // Do not pass production API keys, proxy credentials, preload options or
  // profile-specific environment settings into test children.
  const system = Object.fromEntries(["PATH", "Path", "SystemRoot", "SYSTEMROOT", "WINDIR", "ComSpec", "COMSPEC", "PATHEXT", "OS", "PROCESSOR_ARCHITECTURE", "NUMBER_OF_PROCESSORS", "LANG", "LC_ALL", "TERM"]
    .filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]]));
  return { ...system,
    HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: path.join(home, ".config"), XDG_CACHE_HOME: path.join(home, ".cache"),
    APPDATA: path.join(home, "AppData", "Roaming"), LOCALAPPDATA: path.join(home, "AppData", "Local"), TEMP: home, TMP: home,
    MAGPIE_BUN: bun, MAGPIE_PLUGIN_MARKET: "off", DO_NOT_TRACK: "1",
  };
}

export async function openOfflineFixture(bun) {
  const home = await mkdtemp(path.join(tmpdir(), "anyrouter-offline-host-"));
  const configDir = path.join(home, ".config", "magpie"), cacheDir = path.join(home, ".cache", "magpie");
  await mkdir(configDir, { recursive: true }); await mkdir(cacheDir, { recursive: true });
  const registry = await readFile(new URL("./models.json", import.meta.url));
  const modelsDevPath = path.join(cacheDir, "models.json");
  await writeFile(modelsDevPath, registry);
  const authPath = path.join(configDir, "plugin-auth.json");
  const requests = [];
  const state = { listMode: "success", rows: [
    { id: "fixture-responses", supported_endpoint_types: ["responses"], context_length: 10000 },
    { id: "fixture-messages", supported_endpoint_types: ["anthropic"], context_length: 10000 },
  ], prices: [], groupRatios: { default: 1 }, tokens: [], cookie: "s123", selfRotation: false, expiredSession: false };
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, "http://127.0.0.1");
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      requests.push({ method: req.method, path: url.pathname, query: url.search, headers: req.headers, body: Buffer.concat(chunks).toString("utf8") });
      const send = (data, status = 200, headers = {}) => {
        res.writeHead(status, { "content-type": "application/json", ...headers }); res.end(JSON.stringify(data));
      };
      if (req.headers["x-test-upstream-origin"] !== "https://anyrouter.top" || req.headers["x-test-redirect-policy"] !== "manual") {
        return send({ success: false, message: "Offline fixture boundary was not active" }, 500);
      }
      const authorized = !state.expiredSession && req.headers["new-api-user"] === "123" &&
        (String(req.headers.cookie ?? "").split(/;\s*/).includes(`session=${state.cookie}`) || req.headers.authorization === "synthetic-system-token");
      if (url.pathname === "/api/status") return send({ success: true, data: { turnstile_check: false, quota_per_unit: 500000 } });
      if (url.pathname === "/api/user/login" && req.method === "POST") {
        state.cookie = "s123";
        return send({ success: true, data: profile }, 200, { "set-cookie": "session=s123; Path=/; HttpOnly" });
      }
      if (url.pathname === "/api/user/self") {
        if (!authorized) return send({ success: false, message: "未登录" }, 401);
        const headers = {};
        if (state.selfRotation) {
          state.cookie = `${state.cookie}-rotated`;
          headers["set-cookie"] = `session=${state.cookie}; Path=/; HttpOnly; Max-Age=3600`;
        }
        return send({ success: true, data: profile }, 200, headers);
      }
      if (url.pathname === "/api/user/sign_in" && req.method === "POST") {
        if (!authorized) return send({ success: false, message: "未登录" }, 401);
        return send({ success: true, message: "签到成功", data: { reward: 5 } });
      }
      if (url.pathname === "/api/log/self/stat") {
        res.writeHead(200, { "content-type": "text/html", "x-tengine-error": "http_security_level_rule" });
        return res.end("<html>security level rule</html>");
      }
      if (url.pathname === "/api/log/self") {
        if (!authorized) return send({ success: false, message: "未登录" }, 401);
        return send({ success: true, data: { items: [{ id: 1, type: 2, user_id: 123, quota: 1000000, created_at: Number(url.searchParams.get("end_timestamp")) }], total: 1 } });
      }
      if (url.pathname.startsWith("/api/token/")) {
        if (!authorized) return send({ success: false, message: "未登录" }, 401);
        const selected = /^\/api\/token\/(\d+)$/.exec(url.pathname);
        return selected ? send({ success: true, data: state.tokens.find(item => String(item.id) === selected[1]) ?? {} }) :
          send({ success: true, data: { items: state.tokens, total: state.tokens.length } });
      }
      if (url.pathname === "/api/pricing") return send({ success: true, data: state.prices, group_ratio: state.groupRatios });
      if (url.pathname === "/v1/models") {
        if (!req.headers.authorization?.startsWith("Bearer ")) return send({ error: { code: "invalid_api_key" } }, 401);
        if (state.listMode === "waf") {
          res.writeHead(401, { "content-type": "text/html" }); return res.end("<html>verification</html>");
        }
        if (state.listMode === "failure") return send({ error: { message: "Synthetic unavailable" } }, 503);
        return send({ data: state.listMode === "empty" ? [] : state.rows });
      }
      if (url.pathname === "/v1/dashboard/billing/usage") return send({ total_usage: 1234 });
      if (url.pathname === "/v1/responses") {
        res.writeHead(200, { "content-type": "text/event-stream" });
        return res.end(frame({ type: "response.completed", response: { status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: "safe-result" }] }] } }));
      }
      if (/^\/v1beta\/models\/gemini-[A-Za-z0-9._-]+:(?:streamGenerateContent|generateContent|countTokens)$/.test(url.pathname)) {
        if (req.headers["x-goog-api-key"] !== apiKey || req.headers.authorization || req.headers.cookie || req.headers["new-api-user"]) {
          return send({ error: { code: 401, status: "UNAUTHENTICATED", message: "Wrong native model credential boundary" } }, 401);
        }
        if (url.pathname.endsWith(":countTokens")) return send({ totalTokens: 5 });
        const value = { candidates: [{ content: { role: "model", parts: [{ text: "safe-gemini-result" }] }, finishReason: "STOP" }], usageMetadata: { totalTokenCount: 4 } };
        if (url.pathname.endsWith(":streamGenerateContent")) {
          res.writeHead(200, { "content-type": "text/event-stream" }); return res.end(frame(value));
        }
        return send(value);
      }
      if (url.pathname === "/v1/messages") {
        res.writeHead(200, { "content-type": "text/event-stream" });
        return res.end(frame({ type: "content_block_start", index: 0, content_block: { type: "text", text: "safe-claude-result" } }, "content_block_start") + frame({ type: "message_stop" }, "message_stop"));
      }
      send({ success: false, message: "Unexpected offline fixture path" }, 404);
    } catch { if (!res.headersSent) res.writeHead(500); res.end("Fixture handler failed"); }
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const env = { ...isolatedEnv(home, bun), MAGPIE_TEST_ORIGIN: origin };
  const config = `preload = [${JSON.stringify(preload)}]\nenv = false\ntelemetry = false\n`;
  // Measured on the installed CLI: its Bun host's cwd is the isolated magpie
  // config directory, not the caller's HOME or the host-script cache directory.
  for (const directory of [home, configDir]) {
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, "bunfig.toml"), config);
  }
  async function close() {
    server.closeAllConnections();
    await new Promise(resolve => server.listening ? server.close(resolve) : resolve());
    const resolved = await realpath(home), parent = await realpath(tmpdir());
    assert.equal(path.dirname(resolved).toLowerCase(), parent.toLowerCase());
    assert.match(path.basename(resolved), /^anyrouter-offline-host-/);
    await rm(resolved, { recursive: true, force: true, maxRetries: 40, retryDelay: 100 });
  }
  return { home, configDir, authPath, modelsDevPath, env, origin, state, requests, close };
}

export function runProgram(executable, argv, { cwd, env, input = "", timeoutMs = 60000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, argv, { cwd, env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    let stdout = "", stderr = "";
    const timer = setTimeout(() => { child.kill("SIGTERM"); reject(new Error("Isolated integration process timed out")); }, timeoutMs);
    child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
    child.stdout.on("data", data => { stdout += data; }); child.stderr.on("data", data => { stderr += data; });
    child.once("error", error => { clearTimeout(timer); reject(error); });
    child.once("close", code => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
    child.stdin.end(input);
  });
}

export function startHost(bun, script, fixture) {
  const child = spawn(bun, ["--preload", preload, script], { cwd: fixture.home, env: fixture.env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
  let stderr = "", nextId = 1;
  const pending = new Map(), events = [];
  child.stderr.setEncoding("utf8"); child.stderr.on("data", data => { stderr += data; });
  const lines = readline.createInterface({ input: child.stdout });
  lines.on("line", line => {
    let message;
    try { message = JSON.parse(line); } catch {
      for (const p of pending.values()) { clearTimeout(p.timer); p.reject(new Error("Host returned a non-RPC line")); }
      pending.clear(); return;
    }
    const p = pending.get(message.id);
    if (!p) { events.push(message); return; }
    if (message.event) { p.events.push(message); return; }
    clearTimeout(p.timer); pending.delete(message.id);
    if (message.error) p.reject(new Error(message.error.message)); else p.resolve({ result: message.result, events: p.events });
  });
  const rejectPending = error => {
    for (const p of pending.values()) { clearTimeout(p.timer); p.reject(error); }
    pending.clear();
  };
  child.once("error", rejectPending);
  child.once("exit", code => rejectPending(new Error(`Host exited ${code}: ${stderr}`)));
  const rpc = (method, params = {}) => new Promise((resolve, reject) => {
    const id = nextId++;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Host RPC timed out: ${method}`)); }, 15000);
    pending.set(id, { resolve, reject, timer, events: [] });
    child.stdin.write(JSON.stringify({ id, method, params }) + "\n");
  });
  async function close() {
    if (child.exitCode === null) {
      const exit = new Promise(resolve => child.once("exit", resolve));
      child.stdin.end();
      const term = setTimeout(() => child.kill("SIGTERM"), 1000);
      const kill = setTimeout(() => child.kill("SIGKILL"), 3000);
      let deadline;
      try { await Promise.race([exit, new Promise((_, reject) => { deadline = setTimeout(() => reject(new Error("Host did not close")), 6000); })]); }
      finally { clearTimeout(term); clearTimeout(kill); clearTimeout(deadline); }
    }
    lines.close();
    for (const stream of [child.stdin, child.stdout, child.stderr]) stream.destroy();
  }
  return { rpc, events, close, stderr: () => stderr };
}

export function responseBody(events) {
  return events.filter(event => event.event === "chunk").map(event => Buffer.from(event.data, "base64").toString("utf8")).join("");
}
