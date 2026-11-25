import assert from "node:assert/strict";
import test from "node:test";
import { readAccount } from "../lib/accounts.mjs";
import { createProvider } from "../lib/provider.mjs";
import { createSiteClient } from "../lib/site-client.mjs";

const origin = "https://anyrouter.top";
const account = { mode: "session", siteURL: origin, userId: "123", session: "session=synthetic" };
const active = { id: 7, user_id: 123, status: 1, key: "synthetic-model", expired_time: -1, unlimited_quota: true };
const json = data => Response.json({ success: true, data });
function clientFor(data) {
  const calls = [];
  const client = createSiteClient({ fetchImpl: async (url, init) => { calls.push({ url, init }); return json(data); } });
  return { client, calls };
}

test("explicit Key ID fetches only that token instead of guessing from a list", async () => {
  const { client, calls } = clientFor({ ...active, id: 8 });
  assert.deepEqual(await client.selectKey(account, "8"), { key: "sk-synthetic-model", keyId: "8" });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, `${origin}/api/token/8`);
  assert.equal(calls[0].init.method, "GET");
  assert.equal(calls[0].init.headers.get("cookie"), account.session);
});

test("same Key value under distinct IDs remains ambiguous", async () => {
  const { client, calls } = clientFor({ items: [active, { ...active, id: 8 }], total: 2 });
  await assert.rejects(client.selectKey(account), { kind: "selection" });
  assert.equal(calls.length, 1);
});

test("Key selection trims before checking an existing sk- prefix", async () => {
  const { client } = clientFor({ ...active, key: " sk-synthetic-model " });
  assert.deepEqual(await client.selectKey(account, "7"), { key: "sk-synthetic-model", keyId: "7" });
});

for (const [name, row] of [
  ["foreign owner", { ...active, user_id: 999 }],
  ["invalid owner", { ...active, user_id: "not-an-id" }],
  ["missing ID", { ...active, id: undefined }],
  ["missing expiration", { ...active, expired_time: undefined }],
  ["unknown remaining quota", { ...active, unlimited_quota: false }],
  ["masked key", { ...active, key: "sk-****" }],
  ["non-ASCII key", { ...active, key: "sk-synthetic-\u200b" }],
]) {
  test(`Key discovery rejects ${name} without mutating the site`, async () => {
    const { client, calls } = clientFor({ items: [row], total: 1 });
    await assert.rejects(client.selectKey(account), { kind: "selection" });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].init.method, "GET");
  });
}

test("invalid explicit IDs are rejected before any request", async () => {
  const { client, calls } = clientFor(active);
  for (const id of ["0", "07", "+7", "7x", "1e3", "9007199254740992"]) {
    await assert.rejects(client.selectKey(account, id), { kind: "selection" });
  }
  assert.equal(calls.length, 0);
});

test("a requested ID cannot silently select a different returned token", async () => {
  const { client, calls } = clientFor({ ...active, id: 8 });
  await assert.rejects(client.selectKey(account, "7"), { kind: "selection" });
  assert.equal(calls.length, 1);
});

test("login with an explicit unavailable Key ID fails instead of saving a guessed inference key", async () => {
  const calls = [];
  const hooks = await createProvider({}, {}, { fetchImpl: async url => {
    calls.push(String(url));
    return calls.length === 1 ? json({ id: 123, username: "alice" }) : json({ ...active, id: 8 });
  } });
  const flow = await hooks.auth.methods[3].authorize({ keyId: "7" });
  const result = await flow.callback(JSON.stringify({ cookie: account.session, userId: account.userId }));
  assert.equal(result.type, "failed");
  assert.equal(result.access, undefined);
  assert.deepEqual(calls.map(url => new URL(url).pathname), ["/api/user/self", "/api/token/7"]);
});

test("ambiguous optional discovery saves a balance-only account, never one of the keys", async () => {
  const calls = [];
  const hooks = await createProvider({}, {}, { fetchImpl: async url => {
    calls.push(String(url));
    return calls.length === 1 ? json({ id: 123, username: "alice" }) : json({ items: [active, { ...active, id: 8 }], total: 2 });
  } });
  const flow = await hooks.auth.methods[3].authorize({});
  const result = await flow.callback(JSON.stringify({ cookie: account.session, userId: account.userId }));
  assert.equal(result.type, "success");
  assert.equal(result.access, "anyrouter");
  const saved = readAccount({ ...result, type: "oauth" });
  assert.equal(saved.hasModelKey, false);
  assert.equal(saved.keyId, "");
  assert.equal(calls.length, 2);
});

test("non-ASCII native API keys fail locally before header conversion can echo them", async () => {
  let calls = 0;
  const hooks = await createProvider({}, {}, { fetchImpl: async () => { calls++; return Response.json({}); } });
  const raw = { type: "api", key: "sk-synthetic-\u200b" };
  const loaded = await hooks.auth.loader(async () => raw);
  const response = await loaded.fetch(`${origin}/v1/responses`, { method: "POST", body: "{}" });
  assert.equal(response.status, 400);
  assert.equal((await response.json()).error.code, "anyrouter_missing_api_key");
  assert.equal(calls, 0);
});
