import assert from "node:assert/strict";
import test from "node:test";
import { readAccount, saveAccount } from "../lib/accounts.mjs";
import { createProvider } from "../lib/provider.mjs";
import { applySetCookies, importCookieHeader, serializeSession } from "../lib/cookies.mjs";

const origin = "https://anyrouter.top";
const account = (extra = {}) => ({
  mode: "session", site: "top", siteURL: origin, apiBase: `${origin}/v1`,
  userId: "123", username: "alice", key: "sk-synthetic-model", session: "session=original",
  checkinEnabled: true, loginGeneration: "synthetic-login-one", ...extra,
});
const profile = (headers = {}) => Response.json({ success: true, data: { id: 123, quota: 500000, used_quota: 0 } }, { headers });
const claimed = (headers = {}) => Response.json({ success: true, message: "签到成功", data: { reward: 5 } }, { headers });
function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}
async function harness(steps, { extra = {}, now = Date.now, saveError = false } = {}) {
  let auth = saveAccount(account(extra), {}, now());
  const calls = [], writes = [];
  const hooks = await createProvider({ magpie: { option: (_provider, key) => key === "site-today-spend" ? true : undefined }, client: { auth: { set: async ({ body }) => {
    writes.push(body);
    if (saveError) throw new Error("synthetic storage failure");
    auth = body;
  } } } }, {}, { now, fetchImpl: async (url, init) => {
    calls.push({ url: String(url), init });
    const step = steps.shift();
    assert.ok(step, `unexpected request: ${new URL(String(url)).pathname}`);
    return typeof step === "function" ? step(url, init) : step;
  } });
  return { hooks, calls, writes, getAuth: async () => auth, auth: () => auth, replace: value => { auth = value; } };
}

test("serialized usage/check-in operations use the latest persisted rotation", async () => {
  const entered = deferred(), release = deferred();
  const h = await harness([
    async () => { entered.resolve(); await release.promise; return profile({ "set-cookie": "session=rotated; Path=/" }); },
    Response.json({ success: true, data: { quota: 1 } }),
    profile(), claimed(),
  ]);
  const usage = h.hooks.auth.usage(h.getAuth);
  await entered.promise;
  const checkin = h.hooks.auth.checkin(h.getAuth);
  release.resolve();
  assert.equal((await usage).balance, "$1.00");
  assert.equal((await checkin).outcome, "claimed");
  assert.deepEqual(h.calls.map(c => new URL(c.url).pathname), ["/api/user/self", "/api/log/self/stat", "/api/user/self", "/api/user/sign_in"]);
  assert.equal(h.calls[2].init.headers.get("cookie"), "session=rotated");
  assert.equal(h.calls[3].init.headers.get("cookie"), "session=rotated");
  assert.equal(h.writes.length, 2);
  assert.equal(readAccount(h.auth()).loginGeneration, "synthetic-login-one");
});

for (const replacement of ["same-uid-login", "logout"]) {
  test(`${replacement} during preflight prevents the POST and stale cookie write`, async () => {
    const entered = deferred(), release = deferred();
    const h = await harness([async () => { entered.resolve(); await release.promise; return profile({ "set-cookie": "session=stale-rotation; Path=/" }); }]);
    const result = h.hooks.auth.checkin(h.getAuth);
    await entered.promise;
    const next = replacement === "logout" ? null : saveAccount(account({ session: "session=new-login", loginGeneration: "synthetic-login-two" }));
    h.replace(next); release.resolve();
    assert.equal((await result).outcome, "failed");
    assert.equal(h.calls.length, 1);
    assert.equal(h.writes.length, 0);
    assert.equal(h.auth(), next);
  });
}

test("a new same-UID login after the POST retains confirmed success without reverting credentials", async () => {
  const entered = deferred(), release = deferred();
  const h = await harness([profile(), async () => { entered.resolve(); await release.promise; return claimed({ "set-cookie": "session=stale-rotation; Path=/" }); }]);
  const pending = h.hooks.auth.checkin(h.getAuth);
  await entered.promise;
  const next = saveAccount(account({ session: "session=new-login", loginGeneration: "synthetic-login-two" }));
  h.replace(next); release.resolve();
  const result = await pending;
  assert.equal(result.outcome, "claimed");
  assert.match(result.message, /登录已变化/);
  assert.equal(h.calls.length, 2);
  assert.equal(h.writes.length, 0);
  assert.equal(h.auth(), next);
});

test("patching session state preserves the latest host fields and unknown refresh fields", async () => {
  const entered = deferred(), release = deferred();
  const h = await harness([async () => { entered.resolve(); await release.promise; return profile({ "set-cookie": "session=rotated; Path=/" }); }, claimed()], { extra: { futureConsoleSetting: { keep: true } } });
  const pending = h.hooks.auth.checkin(h.getAuth);
  await entered.promise;
  h.replace({ ...h.auth(), metadata: { owner: "host", extra: { preserve: true } }, hostExtension: "latest", accountId: "custom-display" });
  release.resolve();
  assert.equal((await pending).outcome, "claimed");
  const saved = h.auth();
  assert.deepEqual(saved.metadata, { owner: "host", extra: { preserve: true } });
  assert.equal(saved.hostExtension, "latest");
  assert.equal(saved.accountId, "custom-display");
  assert.deepEqual(JSON.parse(saved.refresh).futureConsoleSetting, { keep: true });
  assert.match(readAccount(saved).session, /session=rotated/);
  assert.equal(JSON.parse(saved.refresh).session, undefined);
});

test("confirmed check-in with a failed save makes one write attempt and never resubmits", async () => {
  const h = await harness([profile(), claimed({ "set-cookie": "session=rotated; Path=/" })], { saveError: true });
  const result = await h.hooks.auth.checkin(h.getAuth);
  assert.equal(result.outcome, "claimed");
  assert.match(result.message, /保存失败/);
  assert.equal(h.writes.length, 1, "a failed auth.set must not trigger the coordinator's automatic second attempt");
  assert.equal((await h.hooks.auth.checkin(h.getAuth)).outcome, "done");
  assert.equal(h.calls.length, 2);
  assert.equal(h.writes.length, 1);
});

test("usage with a failed save preserves the result and attempts storage once", async () => {
  const h = await harness([profile({ "set-cookie": "session=rotated; Path=/" }), Response.json({ success: true, data: { quota: 1 } })], { saveError: true });
  const result = await h.hooks.auth.usage(h.getAuth);
  assert.equal(result.balance, "$1.00");
  assert.equal(result.signIn, "kept");
  assert.match(result.error, /保存失败/);
  assert.equal(h.writes.length, 1);
});

test("queued cancellation does not abort the current account operation or submit later", async () => {
  const entered = deferred(), release = deferred();
  const h = await harness([async () => { entered.resolve(); await release.promise; return profile(); }, Response.json({ success: true, data: { quota: 0 } }), profile(), claimed()]);
  const usage = h.hooks.auth.usage(h.getAuth);
  await entered.promise;
  const controller = new AbortController();
  const cancelled = h.hooks.auth.checkin(h.getAuth, {}, { signal: controller.signal });
  const rejected = assert.rejects(cancelled, { name: "AbortError" });
  controller.abort();
  await rejected;
  assert.equal(h.calls[0].init.signal.aborted, false, "one waiter must not cancel an unrelated operation");
  release.resolve();
  assert.equal((await usage).balance, "$1.00");
  assert.equal((await h.hooks.auth.checkin(h.getAuth)).outcome, "claimed");
  assert.equal(h.calls.filter(c => c.init.method === "POST").length, 1);
});

test("pre-aborted account hooks and login authorization perform no network calls", async () => {
  const h = await harness([]);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(h.hooks.auth.checkin(h.getAuth, {}, { signal: controller.signal }), { name: "AbortError" });
  await assert.rejects(h.hooks.auth.usage(h.getAuth, {}, { signal: controller.signal }), { name: "AbortError" });
  await assert.rejects(h.hooks.auth.methods[0].authorize({ username: "alice", password: "synthetic-password" }, { signal: controller.signal }), { name: "AbortError" });
  assert.equal(h.calls.length, 0);
});

test("a deleted session during preflight is persisted but is not used for a POST", async () => {
  const h = await harness([profile({ "set-cookie": "session=deleted; Max-Age=0; Path=/" })]);
  const result = await h.hooks.auth.checkin(h.getAuth);
  assert.equal(result.outcome, "ineligible");
  assert.equal(h.calls.length, 1);
  assert.equal(readAccount(h.auth()).session, "");
  assert.equal(readAccount(h.auth()).hasModelKey, true);
});

test("a session scoped to self cannot authorize the different sign-in path", async () => {
  const jar = importCookieHeader("");
  applySetCookies(jar, new Headers({ "set-cookie": "session=scoped; Path=/api/user/self" }), `${origin}/api/user/self`);
  const h = await harness([profile()], { extra: { sessionState: serializeSession(jar) } });
  const result = await h.hooks.auth.checkin(h.getAuth);
  assert.equal(result.outcome, "ineligible");
  assert.equal(h.calls.length, 1, "do not submit a sign-in POST without a session eligible for that exact URL");
});

test("cross-midnight preflight stores the confirmation day, not the queued start day", async () => {
  let time = Date.parse("2026-11-24T15:59:59Z");
  const h = await harness([async () => { time = Date.parse("2026-11-24T16:00:01Z"); return profile(); }, claimed()], { now: () => time });
  assert.equal((await h.hooks.auth.checkin(h.getAuth)).outcome, "claimed");
  assert.equal(readAccount(h.auth()).lastCheckinDay, "2026-11-25");
  assert.equal((await h.hooks.auth.checkin(h.getAuth)).outcome, "done");
  assert.equal(h.calls.length, 2);
});

test("the injected clock governs persisted cookie expiry throughout the account codec", async () => {
  const time = Date.parse("2020-01-01T00:00:00Z");
  const jar = importCookieHeader("", origin, time);
  applySetCookies(jar, new Headers({ "set-cookie": "session=timed; Max-Age=10; Path=/" }), `${origin}/api/user/self`, time);
  const h = await harness([profile(), claimed()], { now: () => time, extra: { sessionState: serializeSession(jar, time) } });
  assert.equal(readAccount(h.auth(), {}, time).session, "session=timed");
  assert.equal((await h.hooks.auth.checkin(h.getAuth)).outcome, "claimed");
  assert.equal(readAccount(h.auth(), {}, time).session, "session=timed");
});
