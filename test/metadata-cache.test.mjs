import assert from "node:assert/strict";
import test from "node:test";
import { setImmediate } from "node:timers/promises";
import { createCatalog } from "../lib/catalog.mjs";
import { createSiteClient } from "../lib/site-client.mjs";
import { createPublicPricing } from "../lib/model-pricing.mjs";
import { readUsage } from "../lib/usage.mjs";

const origin = "https://anyrouter.top", start = Date.parse("2026-11-26T04:00:00Z");
const account = { mode: "session", siteURL: origin, userId: "123", session: "session=synthetic-metadata", key: "sk-synthetic-metadata", hasModelKey: true };
const row = { id: "gpt-synthetic" };
const quote = { model_name: row.id, quota_type: 0, model_ratio: 1, completion_ratio: 2, enable_groups: ["default", "vip"] };
const envelope = () => ({ success: true, data: [quote], group_ratio: { default: 1, vip: 2 } });
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
function pricingHarness(read = async () => envelope()) {
  let time = start, settings = { pricingGroup: "default" };
  const requests = [];
  const catalog = createCatalog({ now: () => time, explicit: () => settings, loadRegistry: async () => ({}),
    fetchImpl: async () => Response.json({ data: [row] }),
    site: { request: async (a, path, options) => { requests.push({ a, path, options }); const value = await read(requests.length, options); return { data: value.data, raw: JSON.stringify(value) }; } },
  });
  return { catalog, requests, time: value => { time = value; }, settings: value => { settings = value; } };
}

test("public pricing shares a fifteen-minute sample across keys while applying current explicit groups", async () => {
  const h = pricingHarness();
  assert.deepEqual((await h.catalog({}, account))[row.id].cost, { input: 2, output: 4 });
  h.time(start + 899999); h.settings({ pricingGroup: "vip" });
  assert.deepEqual((await h.catalog({}, { ...account, key: "sk-synthetic-other" }))[row.id].cost, { input: 4, output: 8 });
  assert.equal(h.requests.length, 1);
  assert.equal(h.requests[0].options.anonymous, true); assert.equal(h.requests[0].a.key, undefined);
  h.time(start + 900000); await h.catalog({}, account); assert.equal(h.requests.length, 2);
});

test("malformed public pricing is briefly suppressed, never guessed or retained as a valid quote", async () => {
  const h = pricingHarness(async n => n === 1 ? { success: true, data: null } : envelope());
  assert.equal((await h.catalog({}, account))[row.id].cost, undefined);
  h.time(start + 59999); assert.equal((await h.catalog({}, account))[row.id].cost, undefined);
  assert.equal(h.requests.length, 1);
  h.time(start + 60000); assert.deepEqual((await h.catalog({}, account))[row.id].cost, { input: 2, output: 4 });
  assert.equal(h.requests.length, 2);
});

test("failed public pricing is not served stale after its fifteen-minute lifetime", async () => {
  const h = pricingHarness(async n => { if (n > 1) throw new Error("synthetic public denial"); return envelope(); });
  await h.catalog({}, account); h.time(start + 900000);
  assert.equal((await h.catalog({}, account))[row.id].cost, undefined);
  await h.catalog({}, account); assert.equal(h.requests.length, 2);
});

test("concurrent catalogs share one anonymous pricing read without sharing mutable model results", async () => {
  const entered = deferred(), release = deferred();
  const h = pricingHarness(async () => { entered.resolve(); await release.promise; return envelope(); });
  const a = h.catalog({}, account), b = h.catalog({}, { ...account, key: "sk-synthetic-other" });
  await entered.promise; await setImmediate(); release.resolve();
  const [first, second] = await Promise.all([a, b]);
  assert.equal(h.requests.length, 1); first[row.id].cost.input = 99;
  assert.equal(second[row.id].cost.input, 2);
});

test("one cancelled public-price subscriber returns promptly without aborting the other catalog", async () => {
  const entered = deferred(), release = deferred(), controller = new AbortController();
  const h = pricingHarness(async () => { entered.resolve(); await release.promise; return envelope(); });
  let stopped = false, failure;
  const a = h.catalog({}, account, { signal: controller.signal }).catch(error => { stopped = true; failure = error; });
  const b = h.catalog({}, account);
  await entered.promise; await setImmediate(); controller.abort(new Error("synthetic public cancellation")); await setImmediate();
  try { assert.equal(stopped, true); assert.match(failure.message, /synthetic public cancellation/); assert.equal(h.requests[0].options.signal.aborted, false); }
  finally { release.resolve(); await Promise.all([a, b]); }
  assert.deepEqual((await b)[row.id].cost, { input: 2, output: 4 }); assert.equal(h.requests.length, 1);
});

test("last public-price cancellation aborts the shared request and does not cache a late result", async () => {
  const entered = deferred(), release = deferred(), controller = new AbortController();
  const h = pricingHarness(async n => { if (n === 1) { entered.resolve(); await release.promise; } return envelope(); });
  const rejected = h.catalog({}, account, { signal: controller.signal }).catch(error => error);
  await entered.promise; controller.abort(); await setImmediate();
  try { assert.equal(h.requests[0].options.signal.aborted, true); }
  finally { release.resolve(); await rejected; }
  await h.catalog({}, account); assert.equal(h.requests.length, 2);
});

test("synchronous cancellation at public fetch entry rejects promptly and cannot seed a cache", async () => {
  const controller = new AbortController(), release = deferred(); let requests = 0, stopped = false;
  const read = createPublicPricing({ now: () => start, site: { request: async () => {
    if (++requests === 1) { controller.abort(new Error("synthetic synchronous cancellation")); await release.promise; }
    return { raw: JSON.stringify(envelope()) };
  } } });
  const rejected = read(controller.signal).catch(error => { stopped = true; return error; });
  await setImmediate();
  try { assert.equal(stopped, true); }
  finally { release.resolve(); await rejected; }
  assert.match((await rejected).message, /synthetic synchronous cancellation/);
  await read(); assert.equal(requests, 2);
});

for (const kind of ["waf", "inactive"]) test(`a known ${kind} stat path is skipped for fifteen minutes without pausing self or logs`, async () => {
  let time = start, stats = 0;
  const paths = [];
  const site = createSiteClient({ now: () => time, fetchImpl: async url => {
    const path = new URL(url).pathname; paths.push(path);
    if (path === "/api/user/self") return Response.json({ success: true, data: { id: 123, quota: 500000, used_quota: 0 } });
    if (path === "/api/log/self/stat") {
      stats++;
      if (stats === 1) return kind === "waf" ? new Response("<html>blocked</html>", { status: 403, headers: { "x-tengine-error": "http_security_level_rule" } }) : Response.json({ success: false }, { status: 404 });
      return Response.json({ success: true, data: { quota: 250000 } });
    }
    assert.equal(path, "/api/log/self"); return Response.json({ success: true, data: { items: [], total: 0 } });
  } });
  const read = () => readUsage(site, account, { now: () => time });
  assert.match((await read()).windows[2].display, /消费日志汇总/);
  time = start + 899999; assert.equal((await read()).balance, "$1.00");
  assert.deepEqual(paths, ["/api/user/self", "/api/log/self/stat", "/api/log/self", "/api/user/self", "/api/log/self"]);
  assert.equal(site.cooldownMs(), 0);
  time = start + 900000; assert.match((await read()).windows[2].display, /^\$0\.50（/); assert.equal(stats, 2);
});

test("transient network stat failure does not create a blocked-path cooldown", async () => {
  let stats = 0;
  const site = createSiteClient({ now: () => start, fetchImpl: async url => {
    const path = new URL(url).pathname;
    if (path === "/api/user/self") return Response.json({ success: true, data: { id: 123, quota: 1, used_quota: 0 } });
    if (path === "/api/log/self/stat") { if (++stats === 1) throw new Error("synthetic temporary network fault"); return Response.json({ success: true, data: { quota: 1 } }); }
    return Response.json({ success: true, data: { items: [], total: 0 } });
  } });
  await readUsage(site, account); await readUsage(site, account); assert.equal(stats, 2);
});
