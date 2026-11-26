import assert from "node:assert/strict";
import test from "node:test";
import { externalKeyIds, readExternalCalls } from "../lib/external-calls.mjs";

const now = 1800000000123, second = Math.floor(now / 1000);
const account = { userId: "123", key: "sk-synthetic-magpie", keyId: "7" };
const row = (id, extra = {}) => ({ id, user_id: 123, type: 2, token_id: 8, created_at: second - 1,
  model_name: "gpt-future", prompt_tokens: 100, completion_tokens: 20, quota: 500000,
  other: JSON.stringify({ cache_tokens: 30 }), content: "private prompt", ...extra });
const page = (items, total = items.length, number = 1) => ({ data: { items, total, page: number, page_size: 100 } });
async function read(steps, extra = {}) {
  const paths = [];
  const op = { self: async () => ({ id: 123 }), request: async path => {
    paths.push(path); const next = steps.shift();
    assert.ok(next, "unexpected read-only request"); return typeof next === "function" ? next(path) : next;
  } };
  const calls = await readExternalCalls(op, account, { keyIds: ["8"], since: 0, now: () => now, ...extra });
  return { calls, paths };
}
const key = (extra = {}) => ({ data: { id: 8, user_id: 123, key: "synthetic-external", ...extra } });

test("external-only key IDs require an explicit bounded unique positive list", () => {
  assert.deepEqual(externalKeyIds(undefined), []);
  assert.deepEqual(externalKeyIds([8, "9"]), ["8", "9"]);
  for (const value of ["8", null, [0], ["08"], ["8", 8], ["8/evil"], Array.from({ length: 11 }, (_, i) => i + 1)]) {
    assert.throws(() => externalKeyIds(value));
  }
});

test("complete log import uses stable UID-scoped IDs, separates cached input and strips private fields", async () => {
  const data = Array.from({ length: 100 }, (_, i) => row(i + 1));
  const result = await read([key(), page(data, 101), page([row(101, { token_id: 7 })], 101, 2)]);
  assert.equal(result.calls.length, 100);
  assert.deepEqual(result.calls[0], { rid: "anyrouter:123:log:1", t: (second - 1) * 1000, model: "gpt-future", in: 70, out: 20, cache_read: 30, cache_write: 0, cost: 1 });
  assert.equal(JSON.stringify(result.calls).includes("private prompt"), false);
  assert.deepEqual(result.paths.map(p => p.split("?")[0]), ["/api/token/8", "/api/log/self", "/api/log/self"]);
});

test("query includes the cursor second but excludes pre-cursor rows and never fabricates milliseconds", async () => {
  const since = (second - 1) * 1000 + 1;
  const result = await read([key(), path => {
    assert.equal(new URL(path, "https://anyrouter.top").searchParams.get("start_timestamp"), String(second - 1));
    return page([row(1), row(2, { created_at: second })]);
  }], { since });
  assert.equal(result.calls.length, 1); assert.equal(result.calls[0].t, second * 1000);
  assert.equal(result.calls[0].rid, "anyrouter:123:log:2");
  assert.equal((await read([], { since: now + 1 })).calls.length, 0);
  for (const since of [-1, NaN, "0", Number.MAX_SAFE_INTEGER + 1]) await assert.rejects(read([], { since }));
});

test("cached Anthropic counts are separate only with the site's explicit claude marker", async () => {
  const result = await read([key(), page([row(1, { model_name: "claude-future", other: JSON.stringify({ claude: true, cache_tokens: 30, cache_creation_tokens: 40 }) })])]);
  assert.equal(result.calls[0].in, 100); assert.equal(result.calls[0].cache_write, 40);
  await assert.rejects(read([key(), page([row(1, { other: JSON.stringify({ cache_tokens: 30, cache_creation_tokens: 40 }) })])]));
  await assert.rejects(read([key(), page([row(1, { other: JSON.stringify({ claude: true, cache_tokens: 30, cache_creation_tokens: 40, cache_write_tokens: 41 }) })])]));
});

for (const [name, override] of [
  ["same stored Key ID", { keyIds: ["7"] }],
  ["same model credential", { metadata: { key: "synthetic-magpie" } }],
  ["masked credential", { metadata: { key: "sk-***" } }],
  ["wrong metadata UID", { metadata: { user_id: 124 } }],
  ["wrong metadata ID", { metadata: { id: 9 } }],
]) test(`${name} rejects provenance before reading any consumption logs`, async () => {
  let logReads = 0;
  const op = { self: async () => ({ id: 123 }), request: async path => {
    if (path.startsWith("/api/log/")) logReads++;
    return key(override.metadata);
  } };
  await assert.rejects(readExternalCalls(op, account, { keyIds: override.keyIds ?? ["8"], since: 0, now: () => now }));
  assert.equal(logReads, 0);
});

for (const [name, item] of [
  ["wrong UID", row(1, { user_id: 124 })], ["missing UID", row(1, { user_id: undefined })],
  ["missing stable ID", row(undefined)], ["wrong type", row(1, { type: 1 })],
  ["missing Key ID", row(1, { token_id: undefined })], ["future timestamp", row(1, { created_at: second + 1 })],
  ["bad prompt tokens", row(1, { prompt_tokens: "100" })], ["negative output", row(1, { completion_tokens: -1 })],
  ["cached input overflow", row(1, { other: '{"cache_tokens":101}' })], ["invalid other", row(1, { other: "bad JSON" })],
  ["negative charge", row(1, { quota: -1 })], ["model credential echo", row(1, { model_name: account.key })],
]) test(`${name} fails the whole reading rather than returning partial calls`, async () => {
  await assert.rejects(read([key(), page([row(2), item])]));
});

test("missing or explicit zero quota is not guessed; selected quota conversion is used", async () => {
  const result = await read([key(), page([row(1, { quota: undefined }), row(2, { quota: 0 }), row(3)])], { quotaPerUnit: 1000000 });
  assert.equal(result.calls[0].cost, undefined); assert.equal(result.calls[1].cost, 0); assert.equal(result.calls[2].cost, 0.5);
});

test("duplicate, inconsistent, truncated and oversized pages never publish partial calls", async () => {
  const rows = Array.from({ length: 100 }, (_, i) => row(i + 1));
  for (const pages of [
    [page([row(1), row(1)])], [page(rows, 101), page([row(101)], 102, 2)],
    [page(rows, 101), page([], 101, 2)], [page(rows, 2001)],
    [page(rows, 101), page([row(1)], 101, 2)], [page([row(1)], 0)],
    [{ data: { items: [], total: 0, page: 2, page_size: 100 } }],
  ]) await assert.rejects(read([key(), ...pages]));
});

test("canonical IDs cannot bypass deduplication and explicit null cache counts stay unknown", async () => {
  await assert.rejects(read([key(), page([row(1), row(" 1 ")])]));
  const canonical = await read([key(), page([row(" 12 ", { token_id: " 8 " })])]);
  assert.equal(canonical.calls[0].rid, "anyrouter:123:log:12");
  for (const name of ["cache_creation_tokens", "cache_write_tokens"]) {
    await assert.rejects(read([key(), page([row(1, { other: JSON.stringify({ claude: true, cache_tokens: 0, [name]: null }) })])]));
  }
});

test("cancelled reads do not fetch another page or return partial calls", async () => {
  const controller = new AbortController();
  await assert.rejects(read([key(), () => {
    controller.abort(new Error("synthetic cancel"));
    return page(Array.from({ length: 100 }, (_, i) => row(i + 1)), 101);
  }], { signal: controller.signal }), /synthetic cancel/);
});
