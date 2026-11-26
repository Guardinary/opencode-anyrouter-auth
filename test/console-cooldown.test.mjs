import assert from "node:assert/strict";
import test from "node:test";
import { createSiteClient } from "../lib/site-client.mjs";
import { createProvider } from "../lib/provider.mjs";
import { saveAccount } from "../lib/accounts.mjs";

const origin = "https://anyrouter.top";
const start = Date.parse("2026-11-26T04:00:00Z");
const account = (userId = "123") => ({ mode: "session", site: "top", siteURL: origin, userId, key: "sk-synthetic-cooldown", session: "session=synthetic-cooldown", loginGeneration: "synthetic-cooldown-login" });
const profile = () => Response.json({ success: true, data: { id: 123, quota: 500000, used_quota: 0 } });

for (const [name, limited] of [
  ["HTTP429 JSON", () => Response.json({ success: false }, { status: 429, headers: { "retry-after": "120" } })],
  ["HTTP429 solvable HTML", () => new Response("<script>var arg1='0123456789abcdef0123456789abcdef01234567';</script>", { status: 429, headers: { "content-type": "text/html", "retry-after": "120" } })],
  ["Tengine HTTP403", () => new Response("blocked", { status: 403, headers: { "x-tengine-error": "http_ratelimit", "retry-after": "120" } })],
  ["HTTP200 business limit", () => Response.json({ success: false, message: "请求次数过多" }, { headers: { "retry-after": "120" } })],
]) test(`${name} pauses all console accounts and anonymous pricing without replay`, async () => {
  let time = start, requests = 0;
  const site = createSiteClient({ now: () => time, fetchImpl: async () => { requests++; return requests === 1 ? limited() : profile(); } });
  await assert.rejects(site.self(account()), { kind: "rate-limit" });
  assert.equal(requests, 1, "limits must not trigger a challenge GET replay");
  time += 30000;
  await assert.rejects(site.self(account("456")), error => error.kind === "rate-limit" && error.retryAfterMs === 90000);
  await assert.rejects(site.request({ siteURL: origin }, "/api/pricing", { anonymous: true }), { kind: "rate-limit" });
  await assert.rejects(site.signIn(account()), { kind: "rate-limit" });
  assert.equal(requests, 1, "cooldown must stop before GET/POST credentials are sent");
  time = start + 120000;
  assert.equal((await site.self(account())).quota, 500000);
  assert.equal(requests, 2);
});

test("Retry-After HTTP dates use the injected clock and excessive values are bounded", async () => {
  let time = start, requests = 0;
  const responses = [
    Response.json({ success: false }, { status: 429, headers: { "retry-after": new Date(start + 180000).toUTCString() } }),
    Response.json({ success: false }, { status: 429, headers: { "retry-after-ms": "99999999999999999999" } }),
    profile(),
  ];
  const site = createSiteClient({ now: () => time, fetchImpl: async () => { requests++; return responses.shift(); } });
  await assert.rejects(site.self(account()), { kind: "rate-limit" });
  time += 60000;
  await assert.rejects(site.self(account()), error => error.retryAfterMs === 120000);
  time = start + 180000;
  await assert.rejects(site.self(account()), { kind: "rate-limit" });
  time += 86400000 - 1;
  await assert.rejects(site.self(account()), error => error.retryAfterMs === 1);
  time++;
  assert.equal((await site.self(account())).quota, 500000);
  assert.equal(requests, 3);
});

test("a rate-limit header starts cooldown even when its body is unreadable", async () => {
  let requests = 0;
  const site = createSiteClient({ now: () => start, fetchImpl: async () => {
    requests++;
    return new Response(new ReadableStream({ start(controller) { controller.error(new Error("synthetic unreadable body")); } }), { status: 429 });
  } });
  await assert.rejects(site.self(account()));
  await assert.rejects(site.self(account()), { kind: "rate-limit" });
  assert.equal(requests, 1);
});

test("ordinary path WAF and invalid credentials do not start a global cooldown", async () => {
  const responses = [new Response("<html>blocked</html>", { status: 403, headers: { "x-tengine-error": "http_security_level_rule" } }), Response.json({ success: false }, { status: 401 }), profile()];
  let requests = 0;
  const site = createSiteClient({ now: () => start, fetchImpl: async () => { requests++; return responses.shift(); } });
  await assert.rejects(site.self(account()), { kind: "waf" });
  await assert.rejects(site.self(account()), { kind: "credentials" });
  assert.equal((await site.self(account())).quota, 500000);
  assert.equal(requests, 3);
});

test("usage cooldown preserves model inference and never causes password re-login", async () => {
  let auth = saveAccount({ ...account(), mode: "password", username: "alice", password: "synthetic-password", checkinEnabled: true }, {}, start);
  const paths = [];
  const hooks = await createProvider({ client: { auth: { set: async ({ body }) => { auth = body; } } } }, {}, { now: () => start, fetchImpl: async url => {
    const path = new URL(url).pathname; paths.push(path);
    if (path === "/v1/responses") return Response.json({ output: [{ type: "message", content: [{ type: "output_text", text: "synthetic OK" }] }] });
    return Response.json({ success: false }, { status: 429 });
  } });
  const getAuth = async () => auth;
  assert.match((await hooks.auth.usage(getAuth)).error, /限流/);
  const checked = await hooks.auth.checkin(getAuth);
  assert.equal(checked.outcome, "failed"); assert.match(checked.message, /限流/);
  const loaded = await hooks.auth.loader(getAuth);
  assert.equal((await loaded.fetch(`${origin}/v1/responses`, { method: "POST", body: JSON.stringify({ model: "synthetic-model", input: "synthetic" }) })).status, 200);
  assert.deepEqual(paths, ["/api/user/self", "/v1/responses"]);
});

test("credential failures win over incidental business rate-limit wording", async () => {
  let requests = 0;
  const site = createSiteClient({ now: () => start, fetchImpl: async () => ++requests === 1 ? Response.json({ success: false, message: "未登录，请求次数过多" }) : profile() });
  await assert.rejects(site.self(account()), { kind: "credentials" });
  assert.equal((await site.self(account())).quota, 500000); assert.equal(requests, 2);
});

test("a known header limit stops without waiting for a hanging response body", async () => {
  let cancelled = false;
  const site = createSiteClient({ now: () => start, fetchImpl: async () => new Response(new ReadableStream({ cancel() { cancelled = true; } }), { status: 429 }) });
  const controller = new AbortController();
  const result = site.self(account(), controller.signal);
  const rejected = assert.rejects(result, { kind: "rate-limit" });
  try {
    const prompt = await Promise.race([rejected.then(() => true), new Promise(resolve => setImmediate(() => resolve(false)))]);
    assert.equal(prompt, true); assert.equal(cancelled, true);
  } finally { controller.abort(); await result.catch(() => {}); await rejected.catch(() => {}); }
});

test("pre-aborted cooldown waiters reject with their own reason", async () => {
  let requests = 0;
  const site = createSiteClient({ now: () => start, fetchImpl: async () => { requests++; return Response.json({ success: false }, { status: 429 }); } });
  await assert.rejects(site.self(account()));
  const controller = new AbortController(); controller.abort(new Error("synthetic caller stopped"));
  await assert.rejects(site.self(account(), controller.signal), /synthetic caller stopped/);
  assert.equal(requests, 1);
});
