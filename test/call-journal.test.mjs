import assert from "node:assert/strict";
import test from "node:test";
import { setImmediate, setTimeout } from "node:timers/promises";
import { createCallJournal } from "../lib/call-journal.mjs";

const time = Date.parse("2026-11-26T04:00:00Z"), account = { siteURL: "https://anyrouter.top", userId: "123", key: "sk-synthetic-journal", loginGeneration: "synthetic-journal-login" };
const call = (extra = {}) => ({ rid: "anyrouter:123:log:1", t: time, model: "gpt-synthetic", in: 70, out: 20, cache_read: 30, cache_write: 0, ...extra });
const usage = { input_tokens: 100, output_tokens: 20, input_tokens_details: { cached_tokens: 30 } };
function harness(protocol = "responses", signal) {
  const journal = createCallJournal({ now: () => time });
  return { journal, watch: response => journal.watch(response, { account, model: "gpt-synthetic", protocol, started: journal.begin(account), signal }) };
}
const sse = value => `data: ${JSON.stringify(value)}\n\n`;

test("observer adds no eager read and promptly forwards cancellation even when upstream cancel hangs", async () => {
  let reads = 0, cancelled = false;
  const source = new ReadableStream({ pull(controller) { reads++; controller.enqueue(new TextEncoder().encode('data: {"delta":"synthetic"}\n\n')); }, cancel() { cancelled = true; return new Promise(() => {}); } }, { highWaterMark: 0 });
  const h = harness(), watched = h.watch(new Response(source, { headers: { "content-type": "text/event-stream" } }));
  await setImmediate(); assert.equal(reads, 0);
  const reader = watched.body.getReader(); await reader.read(); assert.equal(reads, 1);
  assert.equal(await Promise.race([reader.cancel("synthetic stopped").then(() => true), setTimeout(200).then(() => false)]), true);
  assert.equal(cancelled, true); assert.deepEqual(h.journal.filter(account, [call()]), [call()]);
});

test("invalid UTF-8 and over-limit JSON or SSE stay byte-identical and produce no guessed fingerprint", async () => {
  const json = Buffer.from(JSON.stringify({ output: "x".repeat(65536), usage }));
  for (const [body, type] of [[json, "application/json"], [Buffer.from([0xff, 0xfe, 0x00]), "text/event-stream"], [Buffer.from('data: ' + 'x'.repeat(65536) + '\n\n' + sse({ type: "response.completed", response: { usage } })), "text/event-stream"]]) {
    const h = harness(); const watched = h.watch(new Response(body, { headers: { "content-type": type } }));
    assert.deepEqual(Buffer.from(await watched.arrayBuffer()), body); assert.deepEqual(h.journal.filter(account, [call()]), [call()]);
  }
});

test("truncated terminal SSE cannot be mistaken for a completely observed local call", async () => {
  const h = harness(); await h.watch(new Response(sse({ type: "response.completed", response: { usage } }).trimEnd(), { headers: { "content-type": "text/event-stream" } })).text();
  assert.deepEqual(h.journal.filter(account, [call()]), [call()]);
});

test("Claude start/delta/stop preserves cache-exclusive counts and does not journal an unfinished stream", async () => {
  const raw = sse({ type: "message_start", message: { usage: { input_tokens: 70, output_tokens: 0, cache_read_input_tokens: 30, cache_creation_input_tokens: 0 } } }) + sse({ type: "message_delta", usage: { output_tokens: 20 } });
  for (const complete of [false, true]) {
    const h = harness("anthropic"); const body = raw + (complete ? sse({ type: "message_stop" }) : "");
    assert.equal(await h.watch(new Response(body, { headers: { "content-type": "text/event-stream" } })).text(), body);
    assert.deepEqual(h.journal.filter(account, [call()]), complete ? [] : [call()]);
  }
});

test("Google usage requires numeric prompt/cache/output counts, not coercible strings", async () => {
  for (const promptTokenCount of [100, "100"]) {
    const h = harness("gemini"); await h.watch(Response.json({ usageMetadata: { promptTokenCount, candidatesTokenCount: 20, cachedContentTokenCount: 30 } })).text();
    assert.deepEqual(h.journal.filter(account, [call()]), typeof promptTokenCount === "number" ? [] : [call()]);
  }
});

test("an aborted caller cannot seed a local fingerprint from a late uncooperative body", async () => {
  const controller = new AbortController(), h = harness("responses", controller.signal);
  const watched = h.watch(Response.json({ usage })); controller.abort(); await watched.text();
  assert.deepEqual(h.journal.filter(account, [call()]), [call()]);
});

test("multiple identical local fingerprints remain ambiguous rather than erasing external calls", async () => {
  const h = harness(); await h.watch(Response.json({ usage })).text(); await h.watch(Response.json({ usage })).text();
  assert.deepEqual(h.journal.filter(account, [call()]), [call()]);
});

test("the journal retains at most 512 call fingerprints", async () => {
  const h = harness();
  for (let i = 1; i <= 513; i++) await h.watch(Response.json({ usage: { ...usage, input_tokens: i + 100 } })).text();
  const oldest = call({ in: 71 }), newest = call({ rid: "anyrouter:123:log:2", in: 583 });
  assert.deepEqual(h.journal.filter(account, [oldest, newest]), [oldest]);
});

test("active same-key scopes keep a rolling hour instead of dropping the whole window at the birthday", () => {
  let now = time;
  const journal = createCallJournal({ now: () => now }); journal.begin(account);
  now += 59 * 60000; journal.begin(account);
  now += 2 * 60000;
  const recent = call({ t: now - 60000 });
  assert.deepEqual(journal.filter(account, [recent]), [recent]);
});

test("incomplete JSON successes are never declared a completely observed local call", async () => {
  for (const response of [Response.json({ status: "incomplete", usage }), new Response(sse({ type: "response.completed", response: { status: "incomplete", usage } }), { headers: { "content-type": "text/event-stream" } })]) {
    const h = harness(); await h.watch(response).text();
    assert.deepEqual(h.journal.filter(account, [call()]), [call()]);
  }
});

test("trailing error frames prevent journal success and original bytes survive", async () => {
  const h = harness(), raw = sse({ type: "response.completed", response: { usage } }) + sse({ type: "error", error: { message: "synthetic error" } });
  assert.equal(await h.watch(new Response(raw, { headers: { "content-type": "text/event-stream" } })).text(), raw);
  assert.deepEqual(h.journal.filter(account, [call()]), [call()]);
});
