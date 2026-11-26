import assert from "node:assert/strict";
import test from "node:test";
import { readAccount, saveAccount } from "../lib/accounts.mjs";
import { createProvider } from "../lib/provider.mjs";

const now = 1800000000123, time = Math.floor(now / 1000) - 1;
const state = (extra = {}) => ({ mode: "session", site: "top", siteURL: "https://anyrouter.top", apiBase: "https://anyrouter.top/v1",
  userId: "123", key: "sk-synthetic-magpie", keyId: "7", session: "session=synthetic-original", loginGeneration: "synthetic-stable", ...extra });
const json = (data, headers) => Response.json({ success: true, data }, { headers });
const profile = headers => json({ id: 123, username: "alice" }, headers);
const metadata = () => json({ id: 8, user_id: 123, key: "synthetic-external" });
const item = id => ({ id, user_id: 123, type: 2, token_id: 8, created_at: time, model_name: "gpt-future", quota: 1,
  prompt_tokens: 100, completion_tokens: 20, other: '{"cache_tokens":30}', content: "private synthetic prompt" });
const page = (items, total = items.length, page = 1) => json({ items, total, page, page_size: 100 });
function deferred() { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; }
async function harness(steps, { config = { externalUsageKeyIds: [8] }, failSave = false, options = {} } = {}) {
  let auth = saveAccount(state(), {}, now);
  const requests = [], writes = [];
  const hooks = await createProvider({ client: { auth: { set: async ({ body }) => {
    writes.push(body); if (failSave) throw new Error("synthetic storage failure"); auth = body;
  } } } }, options, { now: () => now, fetchImpl: async (url, init) => {
    requests.push({ path: new URL(url).pathname, init });
    assert.equal(init.method, "GET"); assert.equal(init.body, undefined);
    assert.equal(new URL(url).origin, "https://anyrouter.top"); assert.equal(init.redirect, "manual");
    const next = steps.shift(); assert.ok(next, "unexpected extra request"); return typeof next === "function" ? next() : next;
  } });
  await hooks.config({ provider: { anyrouter: config } });
  return { hooks, requests, writes, getAuth: async () => auth, replace: a => { auth = a; }, auth: () => auth };
}

test("unconfigured external usage is a no-network empty hook even without credentials", async () => {
  const h = await harness([], { config: {} });
  assert.deepEqual(await h.hooks.auth.calls(async () => null, {}, { since: 0 }), { calls: [] });
  assert.equal(h.requests.length, 0); assert.equal(h.writes.length, 0);
});

test("configured calls persist scoped cookie rotation, host fields and stable rid without saving external keys", async () => {
  const h = await harness([profile({ "set-cookie": "session=synthetic-rotated; Path=/; Secure" }), metadata(), page([item(9)])], { options: { quotaPerUnit: 1000000 } });
  h.replace({ ...h.auth(), hostNote: "keep-host-value" });
  const result = await h.hooks.auth.calls(h.getAuth, {}, { since: time * 1000 });
  assert.deepEqual(result.calls, [{ rid: "anyrouter:123:log:9", t: time * 1000, model: "gpt-future", in: 70, out: 20, cache_read: 30, cache_write: 0, cost: 0.000001 }]);
  assert.deepEqual(h.requests.map(r => r.path), ["/api/user/self", "/api/token/8", "/api/log/self"]);
  assert.equal(h.requests[1].init.headers.get("cookie"), "session=synthetic-rotated");
  assert.equal(h.writes.length, 1); assert.equal(readAccount(h.auth(), {}, now).key, "sk-synthetic-magpie");
  assert.equal(h.auth().hostNote, "keep-host-value");
  assert.equal(JSON.stringify(h.writes).includes("synthetic-external"), false);
});

for (const change of ["login", "logout"]) test(`${change} during preflight rejects before Key/log reads and preserves new credentials`, async () => {
  const started = deferred(), release = deferred();
  const h = await harness([async () => { started.resolve(); await release.promise; return profile({ "set-cookie": "session=old-rotation; Path=/" }); }]);
  const pending = h.hooks.auth.calls(h.getAuth, {}, { since: 0 });
  await started.promise;
  const newer = change === "logout" ? null : saveAccount(state({ session: "session=new-login", loginGeneration: "new-generation" }), {}, now);
  h.replace(newer); release.resolve();
  await assert.rejects(pending); assert.equal(h.requests.length, 1); assert.equal(h.writes.length, 0); assert.equal(h.auth(), newer);
});

test("a failed cookie save fails the reading once, never advances the cursor or returns an empty success", async () => {
  const h = await harness([profile({ "set-cookie": "session=synthetic-rotated; Path=/" }), metadata(), page([item(9)])], { failSave: true });
  await assert.rejects(h.hooks.auth.calls(h.getAuth, {}, { since: 0 }), /保存|存储/);
  assert.equal(h.writes.length, 1); assert.equal(h.requests.length, 3);
});

test("cancelled paging sends no next page, does not save partial state and propagates cancellation", async () => {
  const controller = new AbortController();
  const h = await harness([profile(), metadata(), () => { controller.abort(new Error("synthetic cancellation")); return page(Array.from({ length: 100 }, (_, i) => item(i + 1)), 101); }]);
  await assert.rejects(h.hooks.auth.calls(h.getAuth, {}, { since: 0, signal: controller.signal }), /synthetic cancellation/);
  assert.equal(h.requests.length, 3); assert.equal(h.writes.length, 0);
});

test("invalid external Key config and pre-aborted hook do not read the account or network", async () => {
  const h = await harness([], { config: { externalUsageKeyIds: ["8", 8] } });
  await assert.rejects(h.hooks.auth.calls(() => assert.fail("no auth read"), {}, { since: 0 }));
  const controller = new AbortController(); controller.abort(new Error("synthetic stopped"));
  await assert.rejects(h.hooks.auth.calls(() => assert.fail("no auth read"), {}, { since: 0, signal: controller.signal }), /synthetic stopped/);
  assert.equal(h.requests.length, 0);
});

test("native API-key-only login cannot import console calls or leak model credentials into site requests", async () => {
  const h = await harness([]); h.replace({ type: "api", key: "sk-synthetic-magpie" });
  await assert.rejects(h.hooks.auth.calls(h.getAuth, {}, { since: 0 }));
  assert.equal(h.requests.length, 0);
});
