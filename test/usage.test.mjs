import assert from "node:assert/strict";
import test from "node:test";

import { saveAccount } from "../lib/accounts.mjs";
import { createProvider } from "../lib/provider.mjs";
import { beijingDayRange, formatUSD, readUsage } from "../lib/usage.mjs";

const json = (data, headers = {}) => new Response(JSON.stringify({ success: true, data }), {
  headers: { "content-type": "application/json", ...headers }
});
const rawJson = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), {
  status,
  headers: { "content-type": "application/json", ...headers }
});
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
  session: "session=site",
  accessToken: "",
  headers: "",
  checkinEnabled: false,
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

async function runUsage(steps, { now = Date.now, extra = {} } = {}) {
  const h = harness(steps);
  let auth = stored(extra);
  const hooks = await createProvider({ magpie: { option: (_provider, key) => key === "site-today-spend" ? true : undefined }, client: { auth: { set: async ({ body }) => { auth = body; } } } }, {}, { fetchImpl: h.fetchImpl, now: typeof now === "function" ? now : () => now });
  return { hooks, h, usage: await hooks.auth.usage(async () => auth, {}) };
}

const dayNow = Date.parse("2026-11-08T04:00:00Z");
const dayStart = Date.parse("2026-11-07T16:00:00Z") / 1000;

test("usage reads user balance, used_quota and the today stat window", async () => {
  const { h, usage } = await runUsage([
    json({ id: 123, username: "alice", quota: 1_250_000, used_quota: 2_500_000 }),
    json({ quota: 300_000 })
  ], { now: dayNow });

  assert.equal(usage.plan, "alice");
  assert.equal(usage.balance, "$2.50");
  assert.equal(usage.signIn, "kept");
  assert.deepEqual(usage.windows.map(window => window.name), ["累计消耗", "余额", "今日消耗"]);
  assert.equal(usage.windows[0].display, "$5.00");
  assert.equal(usage.windows[0].aside, true);
  assert.equal(usage.windows[1].balance, 2.5);
  assert.equal(usage.windows[1].unit, "USD");
  assert.equal(usage.windows[1].display, "$2.50");
  assert.equal(usage.windows[2].display, "$0.60（2026-11-08，北京时间）");
  assert.equal(usage.windows[2].aside, true);
  assert.deepEqual(h.calls.map(call => call.url.pathname), ["/api/user/self", "/api/log/self/stat"]);
  assert.equal(h.calls[1].url.searchParams.get("type"), "2");
  assert.equal(h.calls[1].url.searchParams.get("start_timestamp"), String(dayStart));
  assert.equal(h.calls[1].url.searchParams.get("end_timestamp"), String(Math.floor(dayNow / 1000)));
});

test("stat blocked by http_security_level_rule falls back to complete consume-log pagination", async () => {
  const rows = Array.from({ length: 230 }, (_, index) => ({
    type: 2,
    quota: 1000,
    created_at: dayStart + index
  }));
  const page = (from, count, total, number) => json({
    items: rows.slice(from, from + count),
    total,
    page: number,
    page_size: 100
  });
  const { h, usage } = await runUsage([
    json({ id: 123, username: "alice", quota: 1_250_000, used_quota: 2_500_000 }),
    new Response("<html>WAF security level</html>", {
      status: 200,
      headers: { "content-type": "text/html", "x-tengine-error": "denied by http_security_level_rule" }
    }),
    page(0, 100, 230, 1),
    page(100, 100, 230, 2),
    page(200, 30, 230, 3)
  ], { now: dayNow });

  assert.equal(usage.balance, "$2.50");
  assert.equal(usage.windows[2].display, "$0.46（消费日志汇总）（2026-11-08，北京时间）");
  assert.doesNotMatch(usage.windows[2].display, /不可用/);
  assert.deepEqual(h.calls.map(call => call.url.pathname), [
    "/api/user/self",
    "/api/log/self/stat",
    "/api/log/self",
    "/api/log/self",
    "/api/log/self"
  ]);
  assert.deepEqual(h.calls.slice(2).map(call => call.url.searchParams.get("p")), ["1", "2", "3"]);
  assert.ok(h.calls.slice(2).every(call => call.url.searchParams.get("type") === "2"));
  assert.equal(h.calls.filter(call => call.url.pathname === "/api/log/self/stat").length, 1);
});

test("inconsistent pagination totals become unknown rather than a partial or zero total", async () => {
  const { usage } = await runUsage([
    json({ id: 123, username: "alice", quota: 1_250_000, used_quota: 2_500_000 }),
    new Response("<html>blocked</html>", {
      headers: { "content-type": "text/html", "x-tengine-error": "denied by http_security_level_rule" }
    }),
    json({ items: [{ type: 2, quota: 1, created_at: dayStart }, { type: 2, quota: 1, created_at: dayStart + 1 }], total: 3, page: 1, page_size: 100 }),
    json({ items: [{ type: 2, quota: 1, created_at: dayStart + 2 }], total: 4, page: 2, page_size: 100 })
  ], { now: dayNow });

  assert.equal(usage.balance, "$2.50");
  assert.match(usage.windows[2].display, /不可用/);
  assert.match(usage.windows[2].display, /分页总数变化/);
  assert.doesNotMatch(usage.windows[2].display, /\$0\.00/);
});

test("incomplete and malformed log pages never fabricate a total", async t => {
  const badPages = [
    ["empty data object", json({})],
    ["empty page before expected total", json({ items: [], total: 5, page: 1, page_size: 100 })],
    ["non-numeric quota", json({ items: [{ type: 2, quota: "oops" }], total: 1, page: 1, page_size: 100 })],
    ["created_at outside today", json({ items: [{ type: 2, quota: 1, created_at: dayStart - 1 }], total: 1, page: 1, page_size: 100 })]
  ];
  for (const [name, page] of badPages) {
    await t.test(name, async () => {
      const { usage } = await runUsage([
        json({ id: 123, username: "alice", quota: 1_250_000, used_quota: 2_500_000 }),
        new Response("<html>blocked</html>", {
          headers: { "content-type": "text/html", "x-tengine-error": "denied by http_security_level_rule" }
        }),
        page
      ], { now: dayNow });
      assert.equal(usage.balance, "$2.50");
      assert.match(usage.windows[2].display, /不可用/);
      assert.doesNotMatch(usage.windows[2].display, /今日消耗.*\$0\.00/);
    });
  }
});

test("explicit zero from stat or an empty log page is a real zero", async () => {
  const statZero = await runUsage([
    json({ id: 123, username: "alice", quota: 1_250_000, used_quota: 2_500_000 }),
    json({ quota: 0 })
  ], { now: dayNow });
  assert.equal(statZero.usage.windows[2].display, "$0.00（2026-11-08，北京时间）");
  assert.doesNotMatch(statZero.usage.windows[2].display, /不可用/);

  const logZero = await runUsage([
    json({ id: 123, username: "alice", quota: 1_250_000, used_quota: 2_500_000 }),
    new Response("<html>blocked</html>", {
      headers: { "content-type": "text/html", "x-tengine-error": "denied by http_security_level_rule" }
    }),
    json({ items: [], total: 0, page: 1, page_size: 100 })
  ], { now: dayNow });
  assert.equal(logZero.usage.windows[2].display, "$0.00（消费日志汇总）（2026-11-08，北京时间）");
  assert.doesNotMatch(logZero.usage.windows[2].display, /不可用/);
});

test("Beijing day boundary is UTC 16:00 and survives year and leap-day changes", () => {
  const before = beijingDayRange(Date.parse("2026-11-08T15:59:59.999Z"));
  assert.equal(before.startTimestamp, Date.parse("2026-11-07T16:00:00Z") / 1000);
  assert.equal(before.endTimestamp, Date.parse("2026-11-08T15:59:59Z") / 1000);
  assert.equal(before.date, "2026-11-08");

  const midnight = beijingDayRange(Date.parse("2026-11-08T16:00:00Z"));
  assert.equal(midnight.startTimestamp, midnight.endTimestamp);
  assert.equal(midnight.date, "2026-11-09");
  assert.equal(beijingDayRange(Date.parse("2026-12-31T16:00:00Z")).date, "2027-01-01");
  assert.equal(beijingDayRange(Date.parse("2024-02-28T16:00:00Z")).date, "2024-02-29");
});

test("formatUSD preserves one-quota precision and negative values", () => {
  assert.equal(formatUSD(0), "$0.00");
  assert.equal(formatUSD(1), "$0.000002");
  assert.equal(formatUSD(-1), "-$0.000002");
  assert.equal(formatUSD(250_000), "$0.50");
  assert.equal(formatUSD(500_000), "$1.00");
  assert.equal(formatUSD(12_500_000), "$25.00");
  assert.equal(formatUSD(-12_500_000), "-$25.00");
});

test("negative quota from the user endpoint formats without becoming zero", async () => {
  const { usage } = await runUsage([
    json({ id: 123, username: "alice", quota: -1, used_quota: 0 }),
    json({ quota: 0 })
  ], { now: dayNow });
  assert.equal(usage.balance, "-$0.000002");
  assert.equal(usage.windows[1].balance, -0.000002);
  assert.equal(usage.windows[1].display, "-$0.000002");
});

test("api-key-only billing usage fallback uses the injected fetch implementation", async () => {
  const calls = [];
  const apiKeyAccount = { mode: "api-key", apiBase: "https://anyrouter.top/v1", key: "sk-test" };
  const result = await readUsage(null, apiKeyAccount, {
    fetchImpl: async (url, init) => {
      calls.push({ url: new URL(url), init });
      return Response.json({ data: { total_usage: 1234 } });
    }
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url.pathname, "/v1/dashboard/billing/usage");
  assert.equal(new Headers(calls[0].init.headers).get("authorization"), "Bearer sk-test");
  assert.deepEqual(result.windows, [{ name: "累计消耗", display: "$12.34", aside: true }]);
  assert.equal(result.plan, "API Key（仅推理）");

  const unavailable = await readUsage(null, apiKeyAccount, {
    fetchImpl: async () => new Response("nope", { status: 503 })
  });
  assert.deepEqual(unavailable.windows, []);
  assert.equal(unavailable.plan, "API Key（仅推理）");
});

test("usage failures preserve login status and never fabricate a zero balance", async () => {
  const { usage } = await runUsage([
    rawJson({ success: false, message: "unauthorized" }, 401)
  ], { now: dayNow });
  assert.equal(usage.balance, undefined);
  assert.deepEqual(usage.windows, []);
  assert.equal(usage.signIn, "kept", "console-session failure must not expire independent model credentials");
  assert.match(usage.error, /会话.*失效/);
});

test("provider-level api-key usage forwards the injected fetch implementation", async () => {
  const calls = [];
  const hooks = await createProvider({}, {}, {
    fetchImpl: async (url, init) => {
      calls.push({ url: new URL(url), init });
      return Response.json({ data: { total_usage: 4321 } });
    },
    now: () => dayNow
  });
  const auth = stored({
    mode: "api-key",
    userId: "",
    session: "",
    username: "",
    key: "sk-test",
    apiBase: "https://anyrouter.top/v1"
  });
  const usage = await hooks.auth.usage(async () => auth, {});
  assert.equal(usage.plan, "API Key（仅推理）");
  assert.deepEqual(usage.windows, [{ name: "累计消耗", display: "$43.21", aside: true }]);
  assert.equal(calls.length, 1);
});
