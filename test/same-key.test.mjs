import assert from "node:assert/strict";
import test from "node:test";
import { saveAccount } from "../lib/accounts.mjs";
import { createProvider } from "../lib/provider.mjs";

const origin = "https://anyrouter.top", start = Date.parse("2026-11-26T04:00:00Z");
const base = { mode: "session", site: "top", siteURL: origin, userId: "123", session: "session=synthetic-same", key: "sk-synthetic-same", keyId: "7", loginGeneration: "synthetic-same-login" };
const usage = { input_tokens: 100, output_tokens: 20, input_tokens_details: { cached_tokens: 30 } };
const payload = { model: "gpt-synthetic", output: [{ type: "message", content: [{ type: "output_text", text: "synthetic private response" }] }], usage };
const row = (id, extra = {}) => ({ id, user_id: 123, token_id: 7, type: 2, created_at: start / 1000, model_name: "gpt-synthetic", prompt_tokens: 100, completion_tokens: 20, other: '{"cache_tokens":30}', ...extra });
const frame = value => `data: ${JSON.stringify(value)}\n\n`;
async function harness({ same = true, automatic = true, response = () => Response.json(payload), rows = [row(1), row(2, { prompt_tokens: 200 }), row(3, { token_id: 8 })], config = {} } = {}) {
  let time = start, auth = saveAccount(base, {}, time);
  const paths = [];
  const hooks = await createProvider({ magpie: { option: (_id, key) => key === "site-external-usage" ? automatic : key === "site-external-same-key" ? same : false }, client: { auth: { set: async ({ body }) => { auth = body; } } } }, {}, { now: () => time, fetchImpl: async url => {
    const path = new URL(url).pathname; paths.push(path);
    if (path.startsWith("/v1")) return response();
    if (path === "/api/user/self") return Response.json({ success: true, data: { id: 123 } });
    if (path.startsWith("/api/token/")) return Response.json({ success: true, data: { id: Number(path.split("/").at(-1)), user_id: 123, key: path.endsWith("/8") ? "synthetic-other" : "synthetic-same" } });
    assert.equal(path, "/api/log/self"); return Response.json({ success: true, data: { items: rows, total: rows.length } });
  } });
  await hooks.config({ provider: { anyrouter: config } });
  const getAuth = async () => auth;
  const loaded = await hooks.auth.loader(getAuth);
  return { hooks, paths, getAuth, replace: value => { auth = value; }, time: value => { time = value; }, fetch: () => loaded.fetch(`${origin}/v1/responses`, { method: "POST", body: '{"model":"gpt-synthetic","input":"synthetic private request"}' }) };
}

const rids = result => result.calls.map(call => call.rid).sort();
test("same-key sync is default-off and requires a specific best-effort/restart warning", async () => {
  const h = await harness({ same: false });
  const option = h.hooks.auth.options.find(item => item.key === "site-external-same-key");
  assert.ok(option); assert.equal(option.default, false); assert.match(option.confirm, /重复/); assert.match(option.confirm, /漏|误/); assert.match(option.description, /重启|本进程/);
  await (await h.fetch()).text();
  assert.deepEqual(rids(await h.hooks.auth.calls(h.getAuth)), ["anyrouter:123:log:3"]);
});

test("opt-in same-key matching preserves JSON bytes and excludes one unique locally observed call", async () => {
  const raw = JSON.stringify(payload), original = new Response(raw, { status: 200, headers: { "content-type": "application/json", "content-digest": "synthetic-retained", "x-synthetic": "retained" } });
  const h = await harness({ response: () => original });
  const observed = await h.fetch(); assert.equal(observed.headers.get("content-digest"), "synthetic-retained");
  assert.equal(await observed.text(), raw);
  assert.deepEqual(rids(await h.hooks.auth.calls(h.getAuth)), ["anyrouter:123:log:2", "anyrouter:123:log:3"]);
  assert.deepEqual(rids(await h.hooks.auth.calls(h.getAuth)), ["anyrouter:123:log:2", "anyrouter:123:log:3"], "retrying the same cursor must keep matching stable");
  assert.equal(h.paths.filter(path => path === "/v1/responses").length, 1);
});

test("stream terminal usage is observed without changing split SSE bytes", async () => {
  const raw = frame({ type: "response.output_text.delta", delta: "synthetic stream" }) + frame({ type: "response.completed", response: { model: "gpt-synthetic", usage } });
  const bytes = new TextEncoder().encode(raw);
  const h = await harness({ response: () => new Response(new ReadableStream({ start(controller) { for (let i = 0; i < bytes.length; i += 7) controller.enqueue(bytes.slice(i, i + 7)); controller.close(); } }), { headers: { "content-type": "text/event-stream; charset=utf-8" } }) });
  assert.equal(await (await h.fetch()).text(), raw);
  assert.deepEqual(rids(await h.hooks.auth.calls(h.getAuth)), ["anyrouter:123:log:2", "anyrouter:123:log:3"]);
});

test("ambiguous identical current-key logs are retained rather than called exact local provenance", async () => {
  const h = await harness({ rows: [row(1), row(2)] });
  await (await h.fetch()).text();
  assert.deepEqual(rids(await h.hooks.auth.calls(h.getAuth)), ["anyrouter:123:log:1", "anyrouter:123:log:2"]);
});

test("same-key alone does not turn on external sync or override an advanced whitelist", async () => {
  const h = await harness({ automatic: false });
  assert.deepEqual(await h.hooks.auth.calls(h.getAuth), { calls: [] }); assert.deepEqual(h.paths, []);
  const advanced = await harness({ config: { externalUsageKeyIds: [8] } });
  await (await advanced.fetch()).text(); assert.deepEqual(rids(await advanced.hooks.auth.calls(advanced.getAuth)), ["anyrouter:123:log:3"]);
});

for (const [name, response] of [
  ["missing usage", () => Response.json({ output: [] })],
  ["unknown cache counts", () => Response.json({ usage: { input_tokens: 100, output_tokens: 20 } })],
  ["bad usage types", () => Response.json({ usage: { ...usage, input_tokens: "100" } })],
  ["upstream error", () => Response.json(payload, { status: 500 })],
]) test(`${name} is never invented as a known local fingerprint`, async () => {
  const h = await harness({ response, rows: [row(1)] });
  await (await h.fetch()).text(); assert.deepEqual(rids(await h.hooks.auth.calls(h.getAuth)), ["anyrouter:123:log:1"]);
});

test("new same-UID login cannot borrow an old local fingerprint", async () => {
  const h = await harness({ rows: [row(1)] }); await (await h.fetch()).text();
  h.replace(saveAccount({ ...base, loginGeneration: "synthetic-new-login" }, {}, start));
  assert.deepEqual(rids(await h.hooks.auth.calls(h.getAuth)), ["anyrouter:123:log:1"]);
});

test("same-key historical backlog before opt-in is not silently double-imported", async () => {
  const h = await harness({ rows: [row(1, { created_at: start / 1000 - 60 }), row(2)] });
  assert.deepEqual(rids(await h.hooks.auth.calls(h.getAuth)), ["anyrouter:123:log:2"]);
});
