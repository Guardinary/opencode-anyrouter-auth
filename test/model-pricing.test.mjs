import assert from "node:assert/strict";
import test from "node:test";
import { buildCatalog, createCatalog } from "../lib/catalog.mjs";

const row = { id: "gemini-4-neon" };
const price = { model_name: row.id, quota_type: 0, model_ratio: 1, completion_ratio: 5, model_price: 0, enable_groups: ["default"] };
const account = { hasModelKey: true, key: "sk-synthetic-price", apiBase: "https://anyrouter.top/v1" };
const context = { groupRatios: { default: 1 } };
const build = (extra = {}, prices = [price], ctx = context) => buildCatalog([row], {}, account, { pricingGroup: "default", ...extra }, prices, {}, ctx)[row.id];

test("AnyRouter ratios convert to USD per million tokens, not relative official-price or credit rates", () => {
  assert.deepEqual(build().cost, { input: 2, output: 10 });
  assert.equal(build().rate, undefined);
  assert.deepEqual(build({}, [{ ...price, model_name: row.id, model_ratio: 2 }]).cost, { input: 4, output: 20 });
  assert.deepEqual(build({}, [{ ...price, model_ratio: 0.625, completion_ratio: 8 }]).cost, { input: 1.25, output: 10 });
  assert.deepEqual(build({}, [price], { groupRatios: { default: 0.5 } }).cost, { input: 1, output: 5 });
});

test("unselected, unavailable or unknown pricing groups never imply a default or free price", () => {
  for (const [extra, ctx] of [
    [{ pricingGroup: undefined }, context], [{ pricingGroup: "vip" }, context],
    [{}, {}], [{}, { groupRatios: { default: null } }],
    [{}, { groupRatios: { default: "1" } }], [{}, { groupRatios: { default: -1 } }],
  ]) assert.equal(build(extra, [price], ctx).cost, undefined);
  assert.equal(build({}, [{ ...price, enable_groups: ["vip"] }]).cost, undefined);
});

test("absent or invalid token prices remain unknown while explicit zero stays zero", () => {
  for (const model_ratio of [undefined, null, "1", -1, Infinity, NaN]) assert.equal(build({}, [{ ...price, model_ratio }]).cost, undefined);
  assert.deepEqual(build({}, [{ ...price, model_ratio: 0 }]).cost, { input: 0, output: 0 });
  assert.deepEqual(build({}, [price], { groupRatios: { default: 0 } }).cost, { input: 0, output: 0 });
  assert.deepEqual(build({}, [{ ...price, completion_ratio: null }]).cost, { input: 2 });
  assert.equal(build({}, [{ ...price, model_ratio: Number.MAX_VALUE }]).cost, undefined);
});

test("floating-point underflow never turns a nonzero public charge into free pricing", () => {
  assert.equal(build({}, [{ ...price, model_ratio: 1e-200 }], { groupRatios: { default: 1e-200 } }).cost, undefined);
  assert.deepEqual(build({}, [{ ...price, model_ratio: 5e-201, cache_ratio: 1e-200, create_cache_ratio: 1e-200, completion_ratio: 1e-200 }]).cost, { input: 1e-200 });
});

test("fixed-request charges and duplicate pricing rows never masquerade as token costs", () => {
  assert.equal(build({}, [{ ...price, quota_type: 1, model_price: 0.5 }]).cost, undefined);
  assert.equal(build({}, [{ ...price, quota_type: undefined }]).cost, undefined);
  assert.equal(build({}, [price, { ...price, model_ratio: 2 }]).cost, undefined);
});

test("cache prices require explicit finite ratios; there is no maker-price or cache-price guess", () => {
  assert.equal(build().cost?.cache, undefined);
  assert.deepEqual(build({}, [{ ...price, cache_ratio: 0.1, create_cache_ratio: 1.25 }]).cost, { input: 2, output: 10, cache: { read: 0.2, write: 2.5 } });
  assert.deepEqual(build({}, [{ ...price, cache_ratio: 0, create_cache_ratio: null }]).cost, { input: 2, output: 10, cache: { read: 0 } });
  const models = buildCatalog([row], { models: { [row.id]: { cost: { input: 99 } } } }, account, {}, [], { google: { models: { [row.id]: { cost: { input: 88 } } } } });
  assert.equal(models[row.id].cost, undefined);
});

test("explicit user prices survive aliases, unknown groups and failed discovery without filling unknown fields", async () => {
  const settings = { models: { [row.id]: { cost: { input: 0, output: 3, cache_read: 0, cache: { write: 4 } } } } };
  assert.deepEqual(build(settings).cost, { input: 0, output: 3, cache: { read: 0, write: 4 } });
  assert.deepEqual(build({ models: { [row.id]: { cost: { input: 0 } } } }).cost, { input: 0 });
  assert.equal(build({ models: { [row.id]: { cost: { input: "0", output: null } } } }).cost, undefined);
  const catalog = createCatalog({ site: {}, explicit: () => settings, fetchImpl: async () => { throw new Error("synthetic offline"); } });
  assert.deepEqual((await catalog({}, account))[row.id].cost, { input: 0, output: 3, cache: { read: 0, write: 4 } });
  const aliases = buildCatalog([row], {}, account, { models: { alias: { id: row.id, cost: { input: 7 } } } });
  assert.deepEqual(aliases.alias.cost, { input: 7 });
});

test("anonymous pricing envelope retains group ratios but never grants account models or sends site credentials", async () => {
  let pricingReads = 0;
  const envelope = { success: true, data: [price, { ...price, model_name: "not-accessible" }], group_ratio: { default: 1 } };
  const catalog = createCatalog({
    explicit: () => ({ pricingGroup: "default" }), loadRegistry: async () => ({}),
    fetchImpl: async () => Response.json({ data: [row] }),
    site: { request: async (a, path, options) => {
      pricingReads++; assert.equal(path, "/api/pricing"); assert.equal(options.anonymous, true);
      assert.equal(a.session, ""); assert.equal(a.accessToken, undefined); assert.equal(a.key, undefined);
      return { data: envelope.data, raw: JSON.stringify(envelope) };
    } },
  });
  const result = await catalog({}, account);
  assert.deepEqual(Object.keys(result), [row.id]);
  assert.deepEqual(result[row.id].cost, { input: 2, output: 10 });
  assert.equal(pricingReads, 1);
});

test("missing or malformed public envelope keeps prices unknown without disrupting valid model discovery", async () => {
  for (const raw of [undefined, "not JSON", '{"group_ratio":{"default":1}}', JSON.stringify({ success: false, data: [price], group_ratio: { default: 1 } })]) {
    const catalog = createCatalog({ explicit: () => ({ pricingGroup: "default" }), loadRegistry: async () => ({}),
      fetchImpl: async () => Response.json({ data: [row] }), site: { request: async () => ({ data: [price], raw }) } });
    const result = await catalog({}, account);
    assert.deepEqual(Object.keys(result), [row.id]); assert.equal(result[row.id].cost, undefined);
  }
});

test("successful empty or keyless account catalogs still perform no pricing read", async () => {
  const catalog = createCatalog({ site: { request: () => assert.fail("no pricing read") }, loadRegistry: () => assert.fail("no registry read"), fetchImpl: async () => Response.json({ data: [] }) });
  assert.deepEqual(await catalog({}, account), {});
  assert.deepEqual(await catalog({}, { hasModelKey: false }), {});
});

test("pricing cancellation is observable and never publishes a guessed price", async () => {
  const controller = new AbortController();
  const catalog = createCatalog({ explicit: () => ({ pricingGroup: "default" }), loadRegistry: async () => ({}),
    fetchImpl: async () => Response.json({ data: [row] }), site: { request: async () => { controller.abort(new Error("synthetic cancel")); throw controller.signal.reason; } } });
  await assert.rejects(catalog({}, account, { signal: controller.signal }), /synthetic cancel/);
});
