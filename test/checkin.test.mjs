import assert from "node:assert/strict";
import test from "node:test";

import { readAccount, saveAccount } from "../lib/accounts.mjs";
import { createProvider } from "../lib/provider.mjs";

const json = (data, headers = {}) => new Response(JSON.stringify({ success: true, data }), {
  headers: { "content-type": "application/json", ...headers }
});
const rawJson = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), {
  status,
  headers: { "content-type": "application/json", ...headers }
});

const dayNow = Date.parse("2026-11-22T04:00:00Z"); // 2026-11-22 12:00 Beijing
const day = "2026-11-22";

const account = (extra = {}) => ({
  mode: "session",
  site: "top",
  siteURL: "https://anyrouter.top",
  apiBase: "https://anyrouter.top/v1",
  key: "",
  keyId: "",
  userId: "123",
  username: "alice",
  password: "",
  session: "session=original; acw_tc=waf",
  accessToken: "",
  headers: "",
  checkinEnabled: true,
  ...extra
});
const stored = extra => saveAccount(account(extra));

function harness(steps) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url: new URL(url), init });
    const next = steps.shift();
    assert.ok(next, `unexpected extra request: ${new URL(url).pathname}`);
    return typeof next === "function" ? next(url, init) : next;
  };
  return { calls, fetchImpl };
}

async function makeProvider(steps, { now = dayNow, auth = stored() } = {}) {
  const h = harness(steps);
  const writes = [];
  const state = { auth };
  const hooks = await createProvider({
    client: {
      auth: {
        set: async ({ path, body }) => {
          writes.push({ path, body });
          state.auth = body;
        }
      }
    }
  }, {}, { fetchImpl: h.fetchImpl, now: () => typeof now === "function" ? now() : now });
  return { hooks, h, writes, state, getAuth: async () => state.auth };
}

const self = () => json({ id: 123, username: "alice", email: "alice@example.test" });
const signIn = (body, status = 200, headers = {}) => rawJson(body, status, headers);

test("session check-in preflights /api/user/self and posts /api/user/sign_in exactly once", async () => {
  const { hooks, h, writes, state, getAuth } = await makeProvider([
    self(),
    signIn({ success: true, message: "签到成功", data: { reward: 25 } }, 200, {
      "set-cookie": "session=after; Path=/; HttpOnly"
    })
  ]);
  const result = await hooks.auth.checkin(getAuth, {});

  assert.equal(result.outcome, "claimed");
  assert.equal(result.credit, 25);
  assert.deepEqual(h.calls.map(call => call.url.pathname), ["/api/user/self", "/api/user/sign_in"]);
  assert.equal(h.calls.filter(call => call.init.method === "POST").length, 1);
  assert.deepEqual(h.calls.map(call => call.init.method), ["GET", "POST"]);

  const post = h.calls[1];
  assert.equal(post.init.redirect, "manual");
  assert.equal(post.init.headers.get("content-type"), "application/json");
  assert.equal(post.init.headers.get("x-requested-with"), "XMLHttpRequest");
  assert.equal(post.init.headers.get("origin"), "https://anyrouter.top");
  assert.equal(post.init.headers.get("referer"), "https://anyrouter.top/");
  assert.equal(post.init.headers.get("new-api-user"), "123");
  assert.equal(post.init.headers.get("authorization"), null);
  assert.match(post.init.headers.get("cookie"), /session=original/);
  assert.equal(post.init.body, "{}");

  assert.equal(writes.length, 1);
  assert.deepEqual(writes[0].path, { id: "anyrouter" });
  const saved = readAccount(state.auth);
  assert.match(saved.session, /session=after/);
  assert.match(saved.session, /acw_tc=waf/);
  assert.equal(saved.lastCheckinDay, day);
  assert.equal(saved.lastCheckin.outcome, "claimed");
  assert.equal(saved.lastCheckin.credit, 25);
});

test("password check-in renews a refused session before the single sign_in POST", async () => {
  const { hooks, h, writes, state, getAuth } = await makeProvider([
    rawJson({ success: false, message: "未登录" }, 401),
    json({ turnstile_check: false }),
    json({ id: 123, username: "alice" }, { "set-cookie": "session=fresh; Path=/; HttpOnly" }),
    self(),
    signIn({ success: true, message: "签到成功" })
  ], {
    auth: stored({
      mode: "password",
      password: "site-password",
      session: "session=original; acw_tc=waf"
    })
  });
  const result = await hooks.auth.checkin(getAuth, {});

  assert.equal(result.outcome, "claimed");
  assert.deepEqual(h.calls.map(call => call.url.pathname), [
    "/api/user/self",
    "/api/status",
    "/api/user/login",
    "/api/user/self",
    "/api/user/sign_in"
  ]);
  assert.deepEqual(h.calls.map(call => call.init.method), ["GET", "GET", "POST", "GET", "POST"]);
  const login = h.calls[2];
  assert.deepEqual(JSON.parse(login.init.body), { username: "alice", password: "site-password" });
  assert.equal(login.init.headers.get("new-api-user"), "-1");
  assert.equal(login.init.headers.get("authorization"), null);
  assert.match(login.init.headers.get("cookie"), /session=original/);

  const post = h.calls[4];
  assert.match(post.init.headers.get("cookie"), /session=fresh/);
  assert.match(post.init.headers.get("cookie"), /acw_tc=waf/);
  assert.equal(post.init.headers.get("new-api-user"), "123");
  assert.equal(writes.length, 1);
  const saved = readAccount(state.auth);
  assert.equal(saved.mode, "password");
  assert.equal(saved.password, "site-password");
  assert.match(saved.session, /session=fresh/);
  assert.equal(saved.lastCheckinDay, day);
});

test("empty successful sign-in message is done, not claimed", async () => {
  const { hooks, writes, state, getAuth } = await makeProvider([
    self(),
    signIn({ success: true, message: "", data: {} })
  ]);
  const result = await hooks.auth.checkin(getAuth, {});
  assert.equal(result.outcome, "done");
  assert.equal(result.credit, undefined);
  assert.match(result.message, /今日已签到/);
  assert.equal(writes.length, 1);
  assert.equal(readAccount(state.auth).lastCheckinDay, day);
  assert.equal(readAccount(state.auth).lastCheckin.outcome, "done");
});

test("already-signed-in responses map to done without a reward", async () => {
  const { hooks, writes, state, getAuth } = await makeProvider([
    self(),
    signIn({ success: false, message: "今天已经签到" })
  ]);
  const result = await hooks.auth.checkin(getAuth, {});
  assert.equal(result.outcome, "done");
  assert.equal(result.credit, undefined);
  assert.equal(writes.length, 1);
  assert.equal(readAccount(state.auth).lastCheckinDay, day);

  const again = await hooks.auth.checkin(getAuth, {});
  assert.equal(again.outcome, "done");
  assert.equal(writes.length, 1);
});

test("captcha responses are observable but do not mark an unconfirmed day complete", async () => {
  const { hooks, writes, state, getAuth } = await makeProvider([
    self(),
    signIn({ success: false, message: "请完成人机验证 captcha" })
  ]);
  const result = await hooks.auth.checkin(getAuth, {});
  assert.equal(result.outcome, "captcha");
  assert.equal(writes.length, 0, "unchanged cookie state needs no write");
  assert.equal(readAccount(state.auth).lastCheckinDay, "");
  assert.equal(readAccount(state.auth).lastCheckin, null);
});

test("401 sign-in is ineligible and still saves rotated site cookies", async () => {
  const { hooks, h, writes, state, getAuth } = await makeProvider([
    self(),
    signIn({ success: false, message: "unauthorized" }, 401, {
      "set-cookie": "acw_tc=after-401; Path=/"
    })
  ]);
  const result = await hooks.auth.checkin(getAuth, {});
  assert.equal(result.outcome, "ineligible");
  assert.equal(h.calls.length, 2);
  assert.equal(writes.length, 1);
  const saved = readAccount(state.auth);
  assert.match(saved.session, /acw_tc=after-401/);
  assert.match(saved.session, /session=original/);
  assert.equal(saved.lastCheckinDay, "");
});

test("404 and 405 sign-in responses are inactive without a confirmed completion day", async t => {
  for (const status of [404, 405]) {
    await t.test(String(status), async () => {
      const { hooks, writes, state, getAuth } = await makeProvider([
        self(),
        signIn({ success: false, message: "not available" }, status)
      ]);
      const result = await hooks.auth.checkin(getAuth, {});
      assert.equal(result.outcome, "inactive");
      assert.equal(writes.length, 0);
      assert.equal(readAccount(state.auth).lastCheckinDay, "");
    });
  }
});

test("429 and 5xx sign-in failures are failed and never persist lastCheckinDay", async t => {
  for (const status of [429, 503]) {
    await t.test(String(status), async () => {
      let time = dayNow;
      const { hooks, h, writes, state, getAuth } = await makeProvider([
        self(),
        signIn({ success: false, message: "请求次数过多" }, status),
        self(),
        signIn({ success: false, message: "请求次数过多" }, status)
      ], { now: () => time });
      const first = await hooks.auth.checkin(getAuth, {});
      assert.equal(first.outcome, "failed");
      assert.equal(writes.length, 0);
      assert.equal(readAccount(state.auth).lastCheckinDay, "");

      const paused = await hooks.auth.checkin(getAuth, {});
      assert.equal(paused.outcome, "failed");
      assert.match(paused.message, /限流/);
      assert.equal(h.calls.length, 2, "an immediate retry must not submit another POST");
      time += 60000;
      const second = await hooks.auth.checkin(getAuth, {});
      assert.equal(second.outcome, "failed");
      assert.deepEqual(h.calls.map(call => call.url.pathname), [
        "/api/user/self",
        "/api/user/sign_in",
        "/api/user/self",
        "/api/user/sign_in"
      ]);
      assert.equal(writes.length, 0);
      assert.equal(readAccount(state.auth).lastCheckinDay, "");
    });
  }
});

test("a WAF challenge on the sign_in POST is captcha and is never replayed", async () => {
  const challenge = "<html><script>var arg1='challenge';document.cookie='acw_sc__v2=feedface'</script></html>";
  const { hooks, h, writes, state, getAuth } = await makeProvider([
    self(),
    new Response(challenge, {
      status: 200,
      headers: {
        "content-type": "text/html",
        "x-tengine-error": "denied by http_custom",
        "set-cookie": "acw_tc=post-rotated; Path=/"
      }
    })
  ]);
  const result = await hooks.auth.checkin(getAuth, {});
  assert.equal(result.outcome, "captcha");
  assert.deepEqual(h.calls.map(call => call.url.pathname), ["/api/user/self", "/api/user/sign_in"]);
  assert.equal(h.calls.filter(call => call.init.method === "POST").length, 1);
  assert.match(result.message, /WAF|验证|挑战/);
  assert.equal(writes.length, 1);
  const saved = readAccount(state.auth);
  assert.match(saved.session, /acw_tc=post-rotated/);
  assert.equal(saved.lastCheckinDay, "");
});

test("concurrent same-account check-ins queue to one preflight and one sign_in POST", async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const { hooks, h, writes, getAuth } = await makeProvider([
    self(),
    async () => {
      await gate;
      return signIn({ success: true, message: "签到成功", data: { reward: 5 } });
    }
  ]);
  const first = hooks.auth.checkin(getAuth, {});
  await new Promise(resolve => setImmediate(resolve));
  const second = hooks.auth.checkin(getAuth, {});
  release();
  const results = await Promise.all([first, second]);

  assert.deepEqual(results.map(result => result.outcome), ["claimed", "done"]);
  assert.deepEqual(h.calls.map(call => call.url.pathname), ["/api/user/self", "/api/user/sign_in"]);
  assert.equal(h.calls.filter(call => call.init.method === "POST").length, 1);
  assert.equal(writes.length, 1);
});

test("wrong UID during preflight fails closed without replacing credentials", async () => {
  const original = stored();
  const { hooks, h, writes, state, getAuth } = await makeProvider([
    json({ id: 999, username: "other" })
  ], { auth: original });
  const result = await hooks.auth.checkin(getAuth, {});
  assert.equal(result.outcome, "ineligible");
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].url.pathname, "/api/user/self");
  assert.equal(writes.length, 0);
  assert.equal(state.auth, original);
  assert.equal(readAccount(state.auth).userId, "123");
});

test("api-key-only accounts cannot check in and make no site request", async () => {
  let calls = 0;
  const hooks = await createProvider({}, {}, {
    fetchImpl: async () => { calls++; throw new Error("site request not allowed"); },
    now: () => dayNow
  });
  const auth = stored({ mode: "api-key", userId: "", session: "", key: "sk-test" });
  const result = await hooks.auth.checkin(async () => auth, {});
  assert.equal(result.outcome, "ineligible");
  assert.equal(calls, 0);
});
