import assert from "node:assert/strict";
import test from "node:test";
import {
  createSiteClient,
  mergeCookies,
  parseSessionHandoff,
  quotaNumber,
  solveWafChallenge
} from "../lib/site-client.mjs";
import { customHeaders, inferenceHeaders } from "../lib/headers.mjs";
import { SITES } from "../lib/accounts.mjs";

const json = (data, headers = {}) => new Response(JSON.stringify({ success: true, data }), {
  headers: { "content-type": "application/json", ...headers }
});
const rawJson = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), {
  status,
  headers: { "content-type": "application/json", ...headers }
});
const html = (body, headers = {}) => new Response(body, {
  headers: { "content-type": "text/html", ...headers }
});
const account = extra => ({
  mode: "password",
  site: "top",
  siteURL: "https://anyrouter.top",
  apiBase: "https://anyrouter.top/v1",
  userId: "",
  username: "alice",
  password: "private-password",
  key: "private-model-key",
  session: "",
  accessToken: "",
  headers: "",
  siteHeaders: "",
  checkinEnabled: false,
  ...extra
});
const status = (extra = {}, headers = {}) => json({
  turnstile_check: false,
  quota_per_unit: 500000,
  ...extra
}, headers);
const waf = () => html('<html><script>var arg1 = "challenge"</script></html>');
const key = { id: 7, status: 1, key: "existing-model-key", expired_time: -1, unlimited_quota: true };

function harness(steps, options = {}) {
  const calls = [];
  const client = createSiteClient({
    ...options,
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      const next = steps.shift();
      assert.ok(next, "Unexpected additional site request: " + new URL(url).pathname);
      return typeof next === "function" ? next(url, init) : next;
    }
  });
  return { client, calls };
}

test("password login reads status first, carries WAF cookies and sends no model authorization", async () => {
  const h = harness([
    status({}, { "set-cookie": "acw_tc=waf-pass; Path=/" }),
    json({ id: 123, username: "alice" }, { "set-cookie": "session=site-session; HttpOnly; Path=/" })
  ]);
  const result = await h.client.login(account());
  assert.equal(result.account.userId, "123");
  assert.equal(result.account.session, "acw_tc=waf-pass; session=site-session");
  assert.deepEqual(h.calls.map(call => new URL(call.url).pathname), ["/api/status", "/api/user/login"]);
  const login = h.calls[1];
  assert.equal(new URL(login.url).searchParams.get("turnstile"), "");
  assert.equal(login.init.redirect, "manual");
  assert.equal(login.init.headers.has("authorization"), false);
  assert.equal(login.init.headers.get("cookie"), "acw_tc=waf-pass");
  assert.equal(login.init.headers.get("new-api-user"), "-1");
  assert.deepEqual(JSON.parse(login.init.body), { username: "alice", password: "private-password" });
});

test("WAF on the first site request bootstraps /login and retries with anonymous cookies", async () => {
  const h = harness([
    waf(),
    html("<html>login page</html>", { "set-cookie": "_c_WBKFRo=anonymous; Path=/; HttpOnly" }),
    status({}, { "set-cookie": "acw_tc=waf-pass; Path=/" }),
    json({ id: 123, username: "alice" }, { "set-cookie": "session=site-session; HttpOnly; Path=/" })
  ]);
  const result = await h.client.login(account());
  assert.equal(result.account.userId, "123");
  assert.match(result.account.session, /_c_WBKFRo=anonymous/);
  assert.match(result.account.session, /acw_tc=waf-pass/);
  assert.deepEqual(h.calls.map(call => new URL(call.url).pathname), [
    "/api/status",
    "/login",
    "/api/status",
    "/api/user/login"
  ]);
  const bootstrap = h.calls[1];
  assert.equal(bootstrap.init.method, "GET");
  assert.equal(bootstrap.init.headers.get("sec-fetch-mode"), "navigate");
  assert.equal(bootstrap.init.headers.get("new-api-user"), "-1");
  const login = h.calls[3];
  assert.match(login.init.headers.get("cookie"), /_c_WBKFRo=anonymous/);
  assert.match(login.init.headers.get("cookie"), /acw_tc=waf-pass/);
  assert.equal(login.init.headers.get("new-api-user"), "-1");
});

test("WAF on a password login POST is observable and the authentication POST is never replayed", async () => {
  const h = harness([status(), waf()]);
  await assert.rejects(h.client.login(account()), { kind: "waf" });
  assert.deepEqual(h.calls.map(call => new URL(call.url).pathname), ["/api/status", "/api/user/login"]);
  assert.equal(h.calls.filter(call => call.init.method === "POST").length, 1);
  assert.equal(h.calls[1].init.headers.get("new-api-user"), "-1");
});

test("the known local 40-hex solver computes acw_sc__v2 and retries a GET once", async () => {
  const challenge = "<html><script>var arg1='0123456789abcdef0123456789abcdef01234567';</script></html>";
  assert.equal(solveWafChallenge(challenge), "acw_sc__v2=d2c7186598ab1a508a4f6064e4fa746323ab17c6");
  assert.equal(solveWafChallenge("<script>document.cookie='acw_sc__v2=untrusted'</script>"), "");
  assert.equal(solveWafChallenge("<script src='https://cdn.example/a.js'></script>"), "");
  assert.equal(solveWafChallenge(""), "");
  const h = harness([html(challenge), status()]);
  const result = await h.client.status(account());
  assert.equal(result.data.turnstile_check, false);
  assert.equal(h.calls.length, 2);
  assert.equal(h.calls[1].init.headers.get("cookie"), "acw_sc__v2=d2c7186598ab1a508a4f6064e4fa746323ab17c6");
});

test("Turnstile-enabled status stops before password login", async () => {
  const h = harness([status({ turnstile_check: true, turnstile_site_key: "site-key" })]);
  await assert.rejects(h.client.login(account()), { kind: "captcha" });
  assert.equal(h.calls.length, 1);
  assert.equal(new URL(h.calls[0].url).pathname, "/api/status");
});

test("account reads are read-only and reject another user's data", async () => {
  const h = harness([
    json({ id: 123, quota: 0, used_quota: 500000 }),
    json({ id: 124, quota: 5 })
  ]);
  const state = account({ userId: "123", accessToken: "system-token" });
  assert.equal((await h.client.self(state)).quota, 0);
  await assert.rejects(h.client.self(state), /不一致/);
  assert.ok(h.calls.every(call => call.url.endsWith("/api/user/self") && call.init.method === "GET"));
  assert.equal(h.calls[0].init.headers.get("authorization"), "system-token");
  assert.equal(h.calls[0].init.headers.get("new-api-user"), "123");
  assert.doesNotMatch(JSON.stringify(h.calls.map(call => call.init.body)), /private-password/);
});

test("profile acquisition enriches verified identity and retains rotated WAF/session cookies", async () => {
  const h = harness([
    json({ id: 123, username: "site-alice", email: "alice@example.test" }, {
      "set-cookie": "session=rotated; HttpOnly"
    })
  ]);
  const source = account({ userId: "123", session: "session=original; acw_tc=waf", label: "display-alias" });
  const result = await h.client.profile(source);
  assert.equal(result.profileVerified, true);
  assert.equal(result.account.email, "alice@example.test");
  assert.equal(result.account.username, "site-alice");
  assert.equal(result.account.label, "display-alias");
  assert.match(result.account.session, /session=rotated/);
  assert.match(result.account.session, /acw_tc=waf/);
  assert.equal(source.session, "session=original; acw_tc=waf");
  assert.equal(h.calls.length, 1);
});

test("wrong-user profile is not a session update", async () => {
  const h = harness([json({ id: 124, username: "bob" }, { "set-cookie": "session=wrong-user" })]);
  const state = account({ userId: "123", session: "session=original" });
  await assert.rejects(h.client.profile(state), /不一致/);
  assert.equal(state.session, "session=original");
});

test("site errors are classified without exposing supplied credentials", async t => {
  const cases = [
    ["captcha", () => html('<html><meta name="aliyun_waf_aa">captcha</html>')],
    ["credentials", () => rawJson({ success: false, message: "用户名或密码错误 private-password" })],
    ["waf", () => waf()],
    ["inactive", () => rawJson({ success: false, message: "签到活动未开启" })],
    ["unavailable", () => new Response("<html>Bad gateway</html>", { status: 502 })],
    ["rate-limit", () => rawJson({ success: false, message: "请求次数过多" }, 429)]
  ];
  for (const [kind, response] of cases) {
    await t.test(kind, async () => {
      const steps = [status(), response()];
      const h = harness(steps);
      await assert.rejects(h.client.login(account()), error => {
        assert.equal(error.kind, kind);
        assert.doesNotMatch(error.message, /private-password|private-model-key/);
        return true;
      });
      assert.equal(h.calls.length, 2, "the authentication POST is never replayed");
    });
  }
});

test("Tengine rate limiting, custom denial and security-level WAF are classified apart", async () => {
  const limited = harness([html("<html>limited</html>", { "x-tengine-error": "denied by http_ratelimit" })]);
  await assert.rejects(limited.client.status(account()), { kind: "rate-limit" });
  assert.equal(limited.calls.length, 1, "a rate limit is not a solvable JS challenge");

  const custom = harness([html("<html>denied</html>", { "x-tengine-error": "denied by http_custom" })]);
  await assert.rejects(custom.client.status(account()), { kind: "waf" });
  assert.equal(custom.calls.length, 1);

  const security = harness([html("<html>blocked</html>", { "x-tengine-error": "denied by http_security_level_rule" })]);
  await assert.rejects(security.client.status(account()), { kind: "waf" });
  assert.equal(security.calls.length, 1);

  const solvable = harness([
    html("<html><script>var arg1='0123456789abcdef0123456789abcdef01234567';</script></html>",
      { "x-tengine-error": "denied by http_custom" }),
    status()
  ]);
  const result = await solvable.client.status(account());
  assert.equal(result.data.turnstile_check, false);
  assert.equal(solvable.calls.length, 2);
  assert.equal(solvable.calls[1].init.headers.get("cookie"), "acw_sc__v2=d2c7186598ab1a508a4f6064e4fa746323ab17c6");
});

test("API key selection reads existing active keys without creating or rotating credentials", async () => {
  const h = harness([json({ items: [key], total: 1 }), json(key)]);
  const state = account({ userId: "123", session: "session=site-session" });
  assert.deepEqual(await h.client.selectKey(state), { key: `sk-${key.key}`, keyId: "7" });
  assert.deepEqual(await h.client.selectKey(state, "7"), { key: `sk-${key.key}`, keyId: "7" });
  assert.ok(h.calls.every(call => call.init.method === "GET"));
  assert.ok(h.calls.every(call => !call.url.includes("/api/user/token")));
  assert.equal(h.calls[1].url, "https://anyrouter.top/api/token/7");
});

test("ambiguous, truncated, expired, exhausted and masked keys cannot silently win selection", async t => {
  for (const [name, data] of [
    ["ambiguous", { items: [key, { ...key, id: 8 }], total: 2 }],
    ["truncated", { items: [key], total: 20 }],
    ["expired", { items: [{ ...key, expired_time: 1 }] }],
    ["exhausted", { items: [{ ...key, unlimited_quota: false, remain_quota: 0 }] }],
    ["masked", { items: [{ ...key, key: "sk-****" }] }]
  ]) {
    await t.test(name, async () => {
      const h = harness([json(data)]);
      await assert.rejects(
        h.client.selectKey(account({ userId: "123", session: "session=x" })),
        { kind: "selection" }
      );
      assert.equal(h.calls.length, 1);
    });
  }
});

test("sign_in sends only the site session and New-API-User with an empty JSON body", async () => {
  const h = harness([
    rawJson({ success: true, message: "签到成功", data: { reward: 25 } })
  ]);
  const state = account({
    userId: "123",
    session: "session=site-session; acw_tc=waf; acw_sc__v2=challenge; cdn_sec_tc=cdn",
    accessToken: "must-not-be-sent"
  });
  const result = await h.client.signIn(state);
  assert.equal(result.success, true);
  assert.equal(result.message, "签到成功");
  assert.equal(result.cookies, state.session);
  const call = h.calls[0];
  assert.equal(call.url, "https://anyrouter.top/api/user/sign_in");
  assert.equal(call.init.method, "POST");
  assert.equal(call.init.headers.get("cookie"), state.session);
  assert.equal(call.init.headers.get("new-api-user"), "123");
  assert.equal(call.init.headers.get("x-requested-with"), "XMLHttpRequest");
  assert.equal(call.init.headers.has("authorization"), false);
  assert.deepEqual(JSON.parse(call.init.body), {});
});

test("sign_in results distinguish claimed, done, captcha, inactive and reward credit", async () => {
  const client = createSiteClient({ fetchImpl: async () => rawJson({ success: true, message: "签到成功", data: { reward: 25 } }) });
  const state = account({ userId: "123", session: "session=site-session" });
  const claimed = client.checkinResult(await client.signIn(state));
  assert.equal(claimed.lastCheckin.outcome, "claimed");
  assert.equal(claimed.lastCheckin.credit, 25);
  assert.equal(claimed.lastCheckinDay, new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10));

  const empty = createSiteClient({ fetchImpl: async () => rawJson({ success: true, message: "" }) });
  const emptyResult = empty.checkinResult(await empty.signIn(state));
  assert.equal(emptyResult.lastCheckin.outcome, "done", "an empty success message is not a new reward");
  assert.match(emptyResult.lastCheckin.message, /今日已签到/);

  const doneClient = createSiteClient({ fetchImpl: async () => rawJson({ success: false, message: "今天已经签到" }) });
  assert.equal(doneClient.checkinResult(await doneClient.signIn(state)).lastCheckin.outcome, "done");

  const captchaClient = createSiteClient({ fetchImpl: async () => rawJson({ success: false, message: "Turnstile token 为空" }) });
  assert.equal(captchaClient.checkinResult(await captchaClient.signIn(state)).lastCheckin.outcome, "captcha");

  const inactiveClient = createSiteClient({ fetchImpl: async () => rawJson({ success: false, message: "签到活动未开启" }) });
  assert.equal(inactiveClient.checkinResult(await inactiveClient.signIn(state)).lastCheckin.outcome, "inactive");
});

test("sign_in HTTP and WAF failures retain a non-retryable classification", async () => {
  const state = account({ userId: "123", session: "session=site-session" });
  for (const [response, kind] of [
    [rawJson({ success: false, message: "无权进行此操作，权限不足" }, 403), "forbidden"],
    [rawJson({ success: false, message: "not found" }, 404), "inactive"],
    [rawJson({ success: false, message: "请求次数过多" }, 429), "rate-limit"],
    [waf(), "waf"]
  ]) {
    const client = createSiteClient({ fetchImpl: async () => response.clone() });
    await assert.rejects(client.signIn(state), { kind });
  }
});

test("a WAF challenge on the sign_in POST is never replayed", async () => {
  let calls = 0;
  const challenge = "<html><script>var arg1='ABC';document.cookie='acw_sc__v2=solved; path=/';</script></html>";
  const client = createSiteClient({
    fetchImpl: async () => {
      calls++;
      return html(challenge, { "set-cookie": "acw_tc=post-rotated; Path=/" });
    }
  });
  const state = account({ userId: "123", session: "session=site-session" });
  const op = client.openSession(state);
  try {
    await assert.rejects(op.signIn(), error => {
      assert.equal(error.kind, "waf");
      assert.equal(error.cookies, undefined, "exceptions must not contain secret Cookie strings");
      return true;
    });
    assert.match(op.account().session, /acw_tc=post-rotated/, "the owned operation retains rotation without placing it in an error");
  } finally { op.close(); }
  assert.equal(calls, 1, "a mutating POST must never be replayed");
});

test("session handoff accepts AnyRouter cURL and WAF cookies but rejects other sites and unsafe input", async () => {
  const pasted = "curl 'https://anyrouter.top/api/user/self' -H 'New-Api-User: 123' -b 'session=site-secret; acw_tc=waf; acw_sc__v2=challenge' -H 'User-Agent: browser-client' -H 'Sec-CH-UA: \"Chrome\";v=\"143\"' -H 'Authorization: must-not-import' --compressed";
  const handoff = parseSessionHandoff(pasted);
  assert.equal(handoff.userId, "123");
  assert.equal(handoff.session, "session=site-secret; acw_tc=waf; acw_sc__v2=challenge");
  assert.deepEqual(handoff.siteHeaders, { "user-agent": "browser-client", "sec-ch-ua": "\"Chrome\";v=\"143\"" });

  const h = harness([json({ id: 123, username: "alice" })]);
  const result = await h.client.importSession(account({ mode: "session" }), pasted);
  assert.equal(result.account.mode, "session");
  assert.equal(result.account.checkinEnabled, false);
  assert.equal(result.account.password, "");
  assert.equal(result.account.accessToken, "");
  assert.equal(h.calls[0].url, "https://anyrouter.top/api/user/self");
  assert.equal(h.calls[0].init.headers.get("user-agent"), "browser-client");
  assert.equal(h.calls[0].init.headers.get("sec-ch-ua"), "\"Chrome\";v=\"143\"");
  assert.equal(h.calls[0].init.headers.get("authorization"), null);

  for (const text of [
    "curl 'https://github.com/api/user/self' -H 'cookie: session=github' -H 'new-api-user: 123'",
    "curl 'https://connect.linux.do/api/user/self' -H 'cookie: session=linuxdo' -H 'new-api-user: 123'",
    "curl 'https://other.example/api/user/self' -H 'cookie: session=other' -H 'new-api-user: 123'",
    "curl 'https://anyrouter.top/api/token/' -H 'cookie: session=site' -H 'new-api-user: 123'",
    '{"cookie":"session=site"}',
    '{"cookie":"session=site\\r\\nX-Secret: x","userId":"123"}',
    "{}"
  ]) {
    assert.throws(() => parseSessionHandoff(text));
  }

  const legacy = harness([]);
  await assert.rejects(
    legacy.client.importSession(account({ siteURL: "https://legacy.example" }), '{"cookie":"session=site","userId":"123"}'),
    { kind: "config" }
  );
});

test("site operations reject API-only and unknown origins but accept the one API base", async () => {
  for (const state of [
    account({ userId: "123", session: "session=site", siteURL: "https://a-ocnfniawgw.cn-shanghai.fcapp.run" }),
    account({ userId: "123", session: "session=site", siteURL: "https://legacy.example" })
  ]) {
    const h = harness([]);
    await assert.rejects(h.client.self(state), /只支持 anyrouter\.top/);
    assert.equal(h.calls.length, 0);
  }
  const h = harness([json({ id: 123, quota: 0 })]);
  await h.client.self(account({ userId: "123", session: "session=site", apiBase: "https://anyrouter.top/v1" }));
  assert.equal(h.calls[0].url, "https://anyrouter.top/api/user/self");
});

test("session import fails closed when the selected site returns another UID", async () => {
  const h = harness([json({ id: 456, username: "other" })]);
  await assert.rejects(
    h.client.importSession(account(), '{"cookie":"session=site","userId":"123"}'),
    /不一致/
  );
});

test("cookie merging handles Expires commas, WAF rotation and scoped deletion", () => {
  const headers = new Headers();
  const future = new Date(Date.now() + 3600000).toUTCString();
  headers.append("set-cookie", `session=new; Expires=${future}; Path=/; HttpOnly`);
  headers.append("set-cookie", "acw_tc=waf; Path=/");
  headers.append("set-cookie", "old=gone; Max-Age=0; Path=/");
  assert.equal(mergeCookies("session=old; old=old", headers), "session=new; acw_tc=waf");
});

test("missing or malformed quota values are not zero", () => {
  for (const value of [null, undefined, "", " ", false, true, "not-a-number", Infinity, {}]) {
    assert.equal(quotaNumber(value), null);
  }
  assert.equal(quotaNumber("0"), 0);
  assert.equal(quotaNumber(0), 0);
  assert.equal(quotaNumber("123.5"), 123.5);
});

test("account custom headers override native defaults but cannot leak account credentials", () => {
  for (const header of [
    "Authorization: token",
    "Cookie: session=x",
    "New-Api-User: 123",
    "X-Api-Key: key",
    "X-Goog-Api-Key: key",
    "Host: evil.example"
  ]) {
    assert.throws(() => customHeaders(header), /由所选账号或传输层管理/);
  }
  const state = account({
    headers: "X-Account: alice\nX-Selected-Model: default\nUser-Agent: custom-client"
  });
  // AnyRouter's Claude Code path authenticates with ANTHROPIC_AUTH_TOKEN, so
  // every non-Gemini protocol carries `Authorization: Bearer`; only Gemini uses
  // its native `x-goog-api-key`.
  for (const [protocol, expectedHeader, expectedValue] of [
    ["responses", "authorization", "Bearer private-model-key"],
    ["chat", "authorization", "Bearer private-model-key"],
    ["anthropic", "authorization", "Bearer private-model-key"],
    ["gemini", "x-goog-api-key", "private-model-key"]
  ]) {
    const headers = inferenceHeaders(
      state,
      {
        "x-selected-model": "native-model",
        cookie: "session=never-forward",
        authorization: "gateway-key",
        "new-api-user": "123"
      },
      protocol
    );
    assert.equal(headers.get("x-selected-model"), "default");
    assert.equal(headers.get("x-account"), "alice");
    assert.equal(headers.get("user-agent"), "custom-client");
    assert.equal(headers.get("cookie"), null);
    assert.equal(headers.get("new-api-user"), null);
    assert.equal(headers.get(expectedHeader), expectedValue, protocol);
    assert.equal(["authorization", "x-api-key", "x-goog-api-key"].filter(name => headers.has(name)).length, 1, protocol);
  }
});

test("Anthropic inference headers restore the Claude Code client identity", () => {
  const headers = inferenceHeaders(account(), { "x-session-id": "s1" }, "anthropic");
  assert.equal(headers.get("authorization"), "Bearer private-model-key");
  assert.equal(headers.has("x-api-key"), false);
  assert.match(headers.get("user-agent"), /^claude-cli\//);
  assert.equal(headers.get("x-app"), "cli");
  assert.equal(headers.get("anthropic-version"), "2023-06-01");
  assert.match(headers.get("anthropic-beta"), /claude-code-20250219/);
  assert.equal(headers.get("anthropic-dangerous-direct-browser-access"), "true");

  const off = inferenceHeaders(account(), {}, "anthropic", false);
  assert.equal(off.get("authorization"), "Bearer private-model-key");
  assert.equal(off.get("anthropic-beta"), null);
});

test("site requests use browser headers and site-only overrides", async () => {
  const read = harness([json({ id: 123, quota: 0 })]);
  await read.client.self(account({ userId: "123", accessToken: "system-token" }));
  const headers = read.calls[0].init.headers;
  assert.match(headers.get("user-agent"), /^Mozilla\/5\.0 .*Chrome\//);
  assert.equal(headers.get("accept"), "application/json, text/plain, */*");
  assert.match(headers.get("accept-language"), /^zh-CN/);
  assert.match(headers.get("sec-ch-ua"), /Chrome/);
  assert.equal(headers.get("sec-fetch-site"), "same-origin");
  assert.equal(headers.get("referer"), "https://anyrouter.top/");
  assert.equal(headers.has("origin"), false);

  const login = harness([
    status(),
    json({ id: 123, username: "alice" }, { "set-cookie": "session=site-session; Path=/" })
  ]);
  await login.client.login(account());
  assert.equal(login.calls[0].init.headers.get("origin"), null);
  assert.equal(login.calls[1].init.headers.get("origin"), "https://anyrouter.top");

  const override = harness([json({ id: 123, quota: 0 })]);
  await override.client.self(account({
    userId: "123",
    accessToken: "system-token",
    headers: "User-Agent: model-client\nAccept: application/json",
    siteHeaders: { "user-agent": "my-client", accept: "application/xml" }
  }));
  assert.equal(override.calls[0].init.headers.get("user-agent"), "my-client");
  assert.equal(override.calls[0].init.headers.get("accept"), "application/xml");
});

test("session handoff accepts Chrome's `curl --url` output shape", async () => {
  const pasted = [
    "curl --url '" + SITES.top + "/api/user/self' \\",
    "  -H 'accept: application/json, text/plain, */*' \\",
    "  -H 'cache-control: no-store' \\",
    "  -b 'acw_tc=waf; cdn_sec_tc=cdn; acw_sc__v2=solve; session=site-secret' \\",
    "  -H 'new-api-user: 83237' \\",
    "  -H 'pragma: no-cache' \\",
    "  -H 'priority: u=1, i' \\",
    "  -H 'referer: " + SITES.top + "/console/personal' \\",
    "  -H 'sec-ch-ua: \"Not:A-Brand\";v=\"8\", \"Chromium\";v=\"156\", \"Google Chrome\";v=\"156\"' \\",
    "  -H 'sec-fetch-mode: cors' \\",
    "  -H 'user-agent: browser-client'",
  ].join("\n");
  const handoff = parseSessionHandoff(pasted);
  assert.equal(handoff.userId, "83237");
  assert.match(handoff.session, /^acw_tc=waf; cdn_sec_tc=cdn; acw_sc__v2=solve; session=site-secret$/);
  assert.equal(handoff.siteHeaders["user-agent"], "browser-client");
  assert.throws(
    () => parseSessionHandoff(pasted.replace("/api/user/self", "/api/token/")),
    /\/api\/user\/self/
  );
});
