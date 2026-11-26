import assert from "node:assert/strict";
import test from "node:test";
import { saveAccount } from "../lib/accounts.mjs";
import { createProvider } from "../lib/provider.mjs";
import { createSiteClient } from "../lib/site-client.mjs";
import { readUsage } from "../lib/usage.mjs";

const now = Date.parse("2026-11-26T04:00:00Z");
const account = { mode: "session", site: "top", siteURL: "https://anyrouter.top", apiBase: "https://anyrouter.top/v1", userId: "123", session: "session=synthetic-comfort", key: "sk-synthetic-comfort", checkinEnabled: false, loginGeneration: "synthetic-comfort-login" };
const json = data => Response.json({ success: true, data });
const profile = () => json({ id: 123, username: "alice", quota: 1250000, used_quota: 2500000 });

async function provider(steps, values = {}) {
  let auth = saveAccount(account, {}, now);
  const requests = [];
  const hooks = await createProvider({ magpie: { option: (_provider, key) => values[key] === true }, client: { auth: { set: async ({ body }) => { auth = body; } } } }, {}, {
    now: () => now, fetchImpl: async (url, init) => {
      requests.push({ path: new URL(url).pathname, init });
      const next = steps.shift(); assert.ok(next, "No extra comfort query is allowed"); return next;
    },
  });
  return { hooks, requests, getAuth: async () => auth };
}

test("provider defaults to one balance request with no invented daily window", async () => {
  const h = await provider([profile()]);
  const result = await h.hooks.auth.usage(h.getAuth);
  assert.deepEqual(h.requests.map(r => r.path), ["/api/user/self"]);
  assert.deepEqual(result.windows.map(w => w.name), ["累计消耗", "余额"]);
  assert.equal(result.balance, "$2.50");
  assert.equal(result.windows[1].balance, 2.5);
  assert.equal(result.signIn, "kept");
  assert.equal(result.error, undefined);
});

test("GUI daily-spend option is off by default and explicitly restores the daily window", async () => {
  const h = await provider([profile(), json({ quota: 1 })], { "site-today-spend": true });
  const option = h.hooks.auth.options.find(o => o.key === "site-today-spend");
  assert.ok(option); assert.equal(option.default, false);
  const result = await h.hooks.auth.usage(h.getAuth);
  assert.deepEqual(h.requests.map(r => r.path), ["/api/user/self", "/api/log/self/stat"]);
  assert.match(result.windows[2].display, /^\$0\.000002（/);
});

for (const [name, limited] of [
  ["HTTP429", () => Response.json({ success: false, message: "Too many requests" }, { status: 429, headers: { "retry-after": "23" } })],
  ["Tengine HTTP403 rate limit", () => new Response("<html>blocked</html>", { status: 403, headers: { "x-tengine-error": "http_ratelimit" } })],
  ["rate-limit business error", () => Response.json({ success: false, message: "请求次数过多" })],
]) test(`${name} stat failure stops without fetching consume-log fallback`, async () => {
  const h = await provider([profile(), limited()], { "site-today-spend": true });
  const result = await h.hooks.auth.usage(h.getAuth);
  assert.deepEqual(h.requests.map(r => r.path), ["/api/user/self", "/api/log/self/stat"]);
  assert.equal(result.balance, "$2.50");
  assert.equal(result.windows[1].balance, 2.5);
  assert.match(result.windows[2].display, /限流/);
  assert.doesNotMatch(result.windows[2].display, /\$0\.00/);
  assert.equal(result.signIn, "kept");
});

test("balance-only reading does not publish a self result after caller cancellation", async () => {
  const controller = new AbortController();
  const site = { snapshot() {}, async self() { controller.abort(new Error("synthetic stopped after self")); return { quota: 1, used_quota: 0 }; } };
  await assert.rejects(readUsage(site, account, { signal: controller.signal, todaySpend: false }), /synthetic stopped after self/);
});

test("disabling daily spend in the low-level reader performs only self and preserves amounts", async () => {
  let requests = 0;
  const site = createSiteClient({ now: () => now, fetchImpl: async () => { requests++; return profile(); } });
  const op = site.openSession(account);
  try {
    const result = await readUsage(op, account, { now: () => now, todaySpend: false, quotaPerUnit: 1000000 });
    assert.equal(requests, 1); assert.equal(result.balance, "$1.25");
    assert.deepEqual(result.windows.map(w => w.name), ["累计消耗", "余额"]);
    assert.equal(result.windows[1].balance, 1.25);
  } finally { op.close(); }
});
