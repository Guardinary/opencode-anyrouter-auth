import assert from "node:assert/strict";
import test from "node:test";
import { saveAccount } from "../lib/accounts.mjs";
import { createProvider } from "../lib/provider.mjs";
import { createSiteClient } from "../lib/site-client.mjs";
import { formatUSD, quotaRate, readUsage } from "../lib/usage.mjs";

const now = Date.parse("2026-11-24T04:00:00Z"), timestamp = Math.floor(now / 1000);
const account = { mode: "session", site: "top", siteURL: "https://anyrouter.top", apiBase: "https://anyrouter.top/v1", userId: "123", session: "session=synthetic-usage", checkinEnabled: false, loginGeneration: "synthetic-usage-login" };
const json = data => Response.json({ success: true, data });
const profile = () => json({ id: 123, username: "alice", quota: 2000000, used_quota: 1000000 });
const blocked = () => new Response("<html>blocked</html>", { headers: { "content-type": "text/html" } });
const item = id => ({ ...(id === undefined ? {} : { id }), type: 2, quota: 1, created_at: timestamp, user_id: 123 });
const page = (items, total, number = 1) => json({ items, total, page: number, page_size: 100 });
async function run(steps, signal) {
  const calls = [];
  const site = createSiteClient({ now: () => now, fetchImpl: async (url, init) => {
    calls.push({ url: String(url), init });
    const next = steps.shift(); assert.ok(next, "No unexpected extra usage request is allowed.");
    return typeof next === "function" ? next(url, init) : next;
  } });
  const op = site.openSession(account, { signal });
  try { return { result: await readUsage(op, account, { now: () => now, quotaPerUnit: 1000000, signal: op.signal }), calls }; }
  finally { op.close(); }
}

for (const rate of [1000000000001, Number.MAX_SAFE_INTEGER]) {
  test(`single-quota precision stays nonzero at valid rate ${rate}`, () => {
    assert.equal(quotaRate(rate), rate);
    const positive = formatUSD(1, rate), negative = formatUSD(-1, rate);
    assert.notEqual(positive, "$0.00");
    assert.notEqual(negative, "-$0.00");
    assert.equal(negative, `-${positive}`);
    assert.ok(Number(positive.slice(1)) > 0);
    assert.ok(Math.abs(Number(positive.slice(1)) - 1 / rate) < 1e-18, "the bounded decimal expansion must not invent or lose a whole quota");
  });
}

test("one alternate conversion rate governs balance, numeric wallet, total and today's single quota", async () => {
  let auth = saveAccount(account);
  const steps = [profile(), json({ quota: 1 })];
  const hooks = await createProvider({ client: { auth: { set: async ({ body }) => { auth = body; } } } }, { quotaPerUnit: 1000000 }, {
    now: () => now, fetchImpl: async () => { assert.ok(steps.length); return steps.shift(); },
  });
  const result = await hooks.auth.usage(async () => auth);
  assert.equal(result.balance, "$2.00");
  assert.equal(result.windows[0].display, "$1.00");
  assert.equal(result.windows[1].balance, 2);
  assert.equal(result.windows[1].display, "$2.00");
  assert.match(result.windows[2].display, /^\$0\.000001（/);
});

for (const [name, pages] of [
  ["duplicate pages without IDs", [page([item(), item()], 4), page([item(), item()], 4, 2)]],
  ["overlapping consume-log IDs", [page([item(1), item(2)], 4), page([item(2), item(3)], 4, 2)]],
  ["wrong account in a log row", [page([{ ...item(1), user_id: 456 }], 1)]],
  ["more records than the declared total", [page([item(1), item(2), item(3)], 2)]],
  ["wrong page number", [page([item(1)], 1, 2)]],
]) {
  test(`${name} produces unknown daily usage, never a partial or zero estimate`, async () => {
    const { result, calls } = await run([profile(), blocked(), ...pages]);
    assert.equal(result.balance, "$2.00");
    assert.equal(result.signIn, "kept");
    const daily = result.windows.find(window => window.name === "今日消耗");
    assert.match(daily.display, /不可用/);
    assert.doesNotMatch(daily.display, /\$0\.00/);
    assert.ok(calls.every(call => call.init.method === "GET"));
  });
}

for (const stage of ["stat", "log page"]) {
  test(`cancelling the ${stage} stops fallback/pagination without publishing a partial result`, async () => {
    const controller = new AbortController();
    let calls = 0;
    const site = createSiteClient({ now: () => now, fetchImpl: async () => {
      calls++;
      if (calls === 1) return profile();
      if (stage === "log page" && calls === 2) return blocked();
      controller.abort();
      return stage === "stat" ? json({ quota: 0 }) : page([item(1)], 1000);
    } });
    const op = site.openSession(account, { signal: controller.signal });
    try { await assert.rejects(readUsage(op, account, { now: () => now, signal: op.signal }), { name: "AbortError" }); }
    finally { op.close(); }
    assert.equal(calls, stage === "stat" ? 2 : 3);
  });
}
