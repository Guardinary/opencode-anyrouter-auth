import assert from "node:assert/strict";
import test from "node:test";
import { saveAccount } from "../lib/accounts.mjs";
import { createProvider } from "../lib/provider.mjs";
import { applySetCookies, importCookieHeader, serializeSession } from "../lib/cookies.mjs";
import { setImmediate } from "node:timers/promises";

const start = Date.parse("2026-11-26T04:00:00Z");
const base = { mode: "session", site: "top", siteURL: "https://anyrouter.top", userId: "123", key: "sk-synthetic-cache", session: "session=synthetic-cache", loginGeneration: "synthetic-cache-login" };
const profile = (quota = 500000, headers = {}) => Response.json({ success: true, data: { id: 123, quota, used_quota: 250000 } }, { headers });
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
async function harness(fetch, { saveError = false, extra = {} } = {}) {
  let time = start, auth = saveAccount({ ...base, ...extra }, {}, start), daily = false;
  const requests = [];
  const hooks = await createProvider({ magpie: { option: (_id, key) => key === "site-today-spend" ? daily : undefined }, client: { auth: { set: async ({ body }) => { if (saveError) throw new Error("synthetic storage failure"); auth = body; } } } }, {}, { now: () => time, fetchImpl: async (url, init) => { requests.push({ path: new URL(url).pathname, init }); return fetch(url, init, requests.length); } });
  return { hooks, requests, getAuth: async () => auth, replace: value => { auth = value; }, auth: () => auth, time: value => { time = value; }, daily: value => { daily = value; } };
}

test("concurrent usage readers share one request and one independently owned result", async () => {
  const entered = deferred(), release = deferred();
  const h = await harness(async () => { entered.resolve(); await release.promise; return profile(); });
  const a = h.hooks.auth.usage(h.getAuth), b = h.hooks.auth.usage(h.getAuth);
  await entered.promise; release.resolve();
  const [first, second] = await Promise.all([a, b]);
  assert.equal(h.requests.length, 1); assert.equal(first.balance, "$1.00");
  first.windows[0].display = "synthetic mutation";
  assert.notEqual(second.windows[0].display, first.windows[0].display);
});

test("one cancelled merged reader does not cancel the surviving reader", async () => {
  const entered = deferred(), release = deferred();
  const h = await harness(async () => { entered.resolve(); await release.promise; return profile(); });
  const controller = new AbortController();
  const a = h.hooks.auth.usage(h.getAuth, {}, { signal: controller.signal });
  const b = h.hooks.auth.usage(h.getAuth);
  const rejected = assert.rejects(a, /synthetic first stopped/);
  await entered.promise; controller.abort(new Error("synthetic first stopped")); await rejected;
  try { assert.equal(h.requests[0].init.signal.aborted, false); }
  finally { release.resolve(); await b; }
  assert.equal((await b).balance, "$1.00"); assert.equal(h.requests.length, 1);
});

test("last merged cancellation aborts its owned request and cannot seed the cache", async () => {
  const entered = deferred(), release = deferred();
  const h = await harness(async (_url, _init, n) => { if (n === 1) { entered.resolve(); await release.promise; } return profile(n * 500000); });
  const controller = new AbortController();
  const pending = h.hooks.auth.usage(h.getAuth, {}, { signal: controller.signal });
  const rejected = assert.rejects(pending, { name: "AbortError" });
  await entered.promise; controller.abort(); await rejected;
  try { assert.equal(h.requests[0].init.signal.aborted, true); }
  finally { release.resolve(); }
  assert.equal((await h.hooks.auth.usage(h.getAuth)).balance, "$2.00"); assert.equal(h.requests.length, 2);
});

test("fresh cache retains the actual sampling time and expires exactly at 60 seconds", async () => {
  const h = await harness(async (_url, _init, n) => profile(n * 500000));
  assert.equal((await h.hooks.auth.usage(h.getAuth)).balance, "$1.00");
  h.time(start + 59000);
  const cached = await h.hooks.auth.usage(h.getAuth);
  assert.equal(h.requests.length, 1); assert.equal(cached.windows.find(w => w.name === "余额").balance, 1);
  assert.match(cached.windows.find(w => w.name === "余额").display, /缓存.*12:00:00/);
  h.time(start + 60000);
  assert.equal((await h.hooks.auth.usage(h.getAuth)).balance, "$2.00"); assert.equal(h.requests.length, 2);
});

test("cached usage follows a successfully persisted cookie rotation", async () => {
  const h = await harness(async () => profile(500000, { "set-cookie": "session=synthetic-rotated; Path=/" }));
  await h.hooks.auth.usage(h.getAuth);
  const cached = await h.hooks.auth.usage(h.getAuth);
  assert.equal(h.requests.length, 1); assert.match(cached.windows[1].display, /缓存/);
});

for (const field of ["loginGeneration", "session", "key"]) test(`changing ${field} invalidates cached usage for the same UID`, async () => {
  const h = await harness(async (_url, _init, n) => profile(n * 500000));
  await h.hooks.auth.usage(h.getAuth);
  const value = field === "session" ? "session=synthetic-new" : field === "key" ? "sk-synthetic-new" : "synthetic-new-login";
  h.replace(saveAccount({ ...base, [field]: value }, {}, start));
  assert.equal((await h.hooks.auth.usage(h.getAuth)).balance, "$2.00"); assert.equal(h.requests.length, 2);
});

test("daily option changes and Beijing midnight do not reuse an earlier daily sample", async () => {
  const h = await harness(async url => new URL(url).pathname.endsWith("/stat") ? Response.json({ success: true, data: { quota: 1 } }) : profile());
  await h.hooks.auth.usage(h.getAuth); h.daily(true);
  const daily = await h.hooks.auth.usage(h.getAuth);
  assert.equal(daily.windows.length, 3); assert.equal(h.requests.length, 3);
  h.time(Date.parse("2026-11-26T15:59:59Z")); await h.hooks.auth.usage(h.getAuth);
  h.time(Date.parse("2026-11-26T16:00:01Z"));
  assert.match((await h.hooks.auth.usage(h.getAuth)).windows[2].display, /2026-11-27/);
  assert.equal(h.requests.length, 7);
});

test("expired cached balance during shared cooldown is historical text, never a routing wallet", async () => {
  const h = await harness(async (_url, _init, n) => n === 1 ? profile() : Response.json({ success: false }, { status: 429, headers: { "retry-after": "120" } }));
  await h.hooks.auth.usage(h.getAuth); h.time(start + 61000);
  const failed = await h.hooks.auth.usage(h.getAuth);
  assert.equal(failed.balance, undefined); assert.match(failed.error, /限流/);
  assert.match(failed.windows.find(w => w.name === "余额").display, /历史.*12:00:00/);
  assert.ok(failed.windows.every(w => w.balance === undefined && w.aside === true));
  h.time(start + 70000);
  const repeated = await h.hooks.auth.usage(h.getAuth);
  assert.equal(h.requests.length, 2); assert.equal(repeated.balance, undefined);
});

test("storage failures and changed login during reading never populate the cache", async () => {
  const h = await harness(async () => profile(500000, { "set-cookie": "session=synthetic-rotated; Path=/" }), { saveError: true });
  assert.match((await h.hooks.auth.usage(h.getAuth)).error, /保存失败/);
  assert.match((await h.hooks.auth.usage(h.getAuth)).error, /保存失败/); assert.equal(h.requests.length, 2);
  const entered = deferred(), release = deferred();
  const changed = await harness(async (_url, _init, n) => { if (n === 1) { entered.resolve(); await release.promise; } return profile(); });
  const pending = changed.hooks.auth.usage(changed.getAuth); await entered.promise;
  changed.replace(saveAccount({ ...base, loginGeneration: "synthetic-new-login" }, {}, start)); release.resolve();
  assert.equal((await pending).balance, undefined);
  assert.equal((await changed.hooks.auth.usage(changed.getAuth)).balance, "$1.00"); assert.equal(changed.requests.length, 2);
});

test("host-only metadata changes preserve fresh cache but logout does not", async () => {
  const h = await harness(async () => profile()); await h.hooks.auth.usage(h.getAuth);
  h.replace({ ...h.auth(), hostExtension: "synthetic latest" });
  await h.hooks.auth.usage(h.getAuth); assert.equal(h.requests.length, 1);
  h.replace(null); const missing = await h.hooks.auth.usage(h.getAuth);
  assert.equal(missing.balance, undefined); assert.equal(missing.windows.length, 0); assert.equal(h.requests.length, 1);
});

test("cache cannot outlive the console session expiry", async () => {
  const jar = importCookieHeader("", base.siteURL, start);
  applySetCookies(jar, new Headers({ "set-cookie": "session=synthetic-expiring; Path=/; Max-Age=10" }), `${base.siteURL}/api/user/self`, start);
  const h = await harness(async () => profile(), { extra: { sessionState: serializeSession(jar, start) } });
  await h.hooks.auth.usage(h.getAuth); h.time(start + 10000);
  const expired = await h.hooks.auth.usage(h.getAuth);
  assert.equal(expired.balance, undefined); assert.match(expired.error, /会话|令牌/);
  assert.equal(h.requests.length, 1);
});

test("cancellation during cache credential verification returns promptly", async () => {
  const h = await harness(async () => profile()); await h.hooks.auth.usage(h.getAuth);
  const entered = deferred(), release = deferred(), controller = new AbortController(); let reads = 0;
  const getAuth = async () => { if (++reads === 2) { entered.resolve(); await release.promise; } return h.auth(); };
  const pending = h.hooks.auth.usage(getAuth, {}, { signal: controller.signal });
  const rejected = assert.rejects(pending, /synthetic verification cancelled/);
  await entered.promise; controller.abort(new Error("synthetic verification cancelled"));
  try { assert.equal(await Promise.race([rejected.then(() => true), setImmediate().then(() => false)]), true); }
  finally { release.resolve(); await rejected; }
});

test("sampling time is self completion, not queued start or daily completion", async () => {
  const h = await harness(async url => {
    if (new URL(url).pathname.endsWith("/stat")) { h.time(start + 30000); return Response.json({ success: true, data: { quota: 1 } }); }
    h.time(start + 20000); return profile();
  });
  h.daily(true); await h.hooks.auth.usage(h.getAuth); h.time(start + 40000);
  const cached = await h.hooks.auth.usage(h.getAuth);
  assert.equal(h.requests.length, 2); assert.match(cached.windows[1].display, /12:00:20/);
});

test("usage cache bounds its credential entries without leaking another login", async () => {
  const h = await harness(async () => profile()); const first = h.auth();
  await h.hooks.auth.usage(h.getAuth);
  for (let i = 1; i <= 64; i++) { h.replace(saveAccount({ ...base, loginGeneration: `synthetic-bounded-${i}` }, {}, start)); await h.hooks.auth.usage(h.getAuth); }
  assert.equal(h.requests.length, 65); h.replace(first);
  await h.hooks.auth.usage(h.getAuth); assert.equal(h.requests.length, 66);
});

test("a pre-aborted cache reader rejects without reading cached data", async () => {
  const h = await harness(async () => profile()); await h.hooks.auth.usage(h.getAuth);
  const controller = new AbortController(); controller.abort(new Error("synthetic cache cancelled"));
  await assert.rejects(h.hooks.auth.usage(h.getAuth, {}, { signal: controller.signal }), /synthetic cache cancelled/);
  assert.equal(h.requests.length, 1);
});
