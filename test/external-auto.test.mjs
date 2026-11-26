import assert from "node:assert/strict";
import test from "node:test";
import { saveAccount } from "../lib/accounts.mjs";
import { createProvider } from "../lib/provider.mjs";

const time = Date.parse("2026-11-26T04:00:00Z"), second = time / 1000;
const base = { mode: "session", site: "top", siteURL: "https://anyrouter.top", userId: "123", session: "session=synthetic-auto", key: "sk-synthetic-current", keyId: "7", loginGeneration: "synthetic-auto-login" };
const log = (id, token_id) => ({ id, type: 2, user_id: 123, token_id, created_at: second, model_name: "gpt-synthetic", prompt_tokens: 100, completion_tokens: 20, quota: 1, other: '{"cache_tokens":0}' });
const token = (id = 7, key = "synthetic-current", extra = {}) => ({ id, key, user_id: 123, ...extra });
const json = data => Response.json({ success: true, data });
async function harness({ extra = {}, tokens, rows = [log(1, 7), log(2, 8)], enabled = true, config = {} } = {}) {
  let auth = saveAccount({ ...base, ...extra }, {}, time);
  const paths = [];
  const hooks = await createProvider({ magpie: { option: (_id, key) => key === "site-external-usage" ? enabled : undefined }, client: { auth: { set: async ({ body }) => { auth = body; } } } }, {}, { now: () => time, fetchImpl: async url => {
    const path = new URL(url).pathname; paths.push(path);
    if (path === "/api/user/self") return json({ id: 123, quota: 1, used_quota: 0 });
    if (path === "/api/token/") return json(tokens ?? { items: [token(), token(8, "synthetic-other")], total: 2 });
    if (path.startsWith("/api/token/")) return json(tokens ?? token(Number(path.split("/").at(-1)), path.endsWith("/8") ? "synthetic-other" : "synthetic-current"));
    assert.equal(path, "/api/log/self"); return json({ items: rows, total: rows.length });
  } });
  await hooks.config({ provider: { anyrouter: config } });
  return { hooks, paths, getAuth: async () => auth };
}

test("GUI external sync is default-off with an explicit shared-key/device provenance warning", async () => {
  const h = await harness({ enabled: false });
  const option = h.hooks.auth.options.find(item => item.key === "site-external-usage");
  assert.ok(option); assert.equal(option.default, false); assert.match(option.confirm, /重复|其他.*设备|来源/);
  assert.deepEqual(await h.hooks.auth.calls(h.getAuth), { calls: [] }); assert.deepEqual(h.paths, []);
});

test("GUI automatic sync verifies and excludes the stored current Key ID without an external whitelist", async () => {
  const h = await harness();
  const { calls } = await h.hooks.auth.calls(h.getAuth, {}, { since: time });
  assert.deepEqual(calls.map(call => call.rid), ["anyrouter:123:log:2"]);
  assert.deepEqual(h.paths, ["/api/user/self", "/api/token/7", "/api/log/self"]);
  assert.equal(JSON.stringify(calls).includes("synthetic-current"), false);
});

test("a model key without a stored ID is resolved from a complete read-only token list", async () => {
  const h = await harness({ extra: { keyId: "" } });
  assert.deepEqual((await h.hooks.auth.calls(h.getAuth)).calls.map(call => call.rid), ["anyrouter:123:log:2"]);
  assert.deepEqual(h.paths, ["/api/user/self", "/api/token/", "/api/log/self"]);
});

test("balance-only accounts import all complete logs without requiring any Key metadata", async () => {
  const h = await harness({ extra: { key: "", keyId: "" } });
  assert.equal((await h.hooks.auth.calls(h.getAuth)).calls.length, 2);
  assert.deepEqual(h.paths, ["/api/user/self", "/api/log/self"]);
});

for (const [name, options] of [
  ["stored ID mismatch", { tokens: token(7, "synthetic-wrong") }],
  ["foreign token owner", { tokens: token(7, "synthetic-current", { user_id: 124 }) }],
  ["masked current key", { tokens: token(7, "sk-***") }],
  ["missing current key", { extra: { keyId: "" }, tokens: { items: [token(8, "synthetic-other")], total: 1 } }],
  ["truncated token list", { extra: { keyId: "" }, tokens: { items: [token()], total: 2 } }],
  ["duplicate current credentials", { extra: { keyId: "" }, tokens: { items: [token(), token(8)], total: 2 } }],
]) test(`${name} fails auto identification before reading logs`, async () => {
  const h = await harness(options);
  await assert.rejects(h.hooks.auth.calls(h.getAuth)); assert.equal(h.paths.includes("/api/log/self"), false);
});

test("explicit advanced whitelist remains active even when the GUI is off and overrides automatic selection", async () => {
  const h = await harness({ enabled: false, config: { externalUsageKeyIds: [8] } });
  assert.deepEqual((await h.hooks.auth.calls(h.getAuth)).calls.map(call => call.rid), ["anyrouter:123:log:2"]);
  assert.deepEqual(h.paths, ["/api/user/self", "/api/token/8", "/api/log/self"]);
  const empty = await harness({ config: { externalUsageKeyIds: [] } });
  assert.deepEqual(await empty.hooks.auth.calls(empty.getAuth), { calls: [] }); assert.deepEqual(empty.paths, []);
});

test("automatic synchronization preserves strict complete-row identity validation", async () => {
  const h = await harness({ rows: [log(1, 8), { ...log(2, 9), user_id: 124 }] });
  await assert.rejects(h.hooks.auth.calls(h.getAuth), /身份|用户/);
});
