import test from "node:test";
import assert from "node:assert/strict";
import {
  prepareAnthropicRequest,
  prepareCodexRequest,
  prepareRequest,
  prepareResponsesRequest,
} from "../lib/request.mjs";

const url = "https://anyrouter.top/v1/responses";
const anthropicURL = "https://anyrouter.top/v1/messages";
const history = () => ({ model: "model", store: true, stream: true, input: [
  { role: "user", content: "Keep the literal msg_old and call_old in this text." },
  { type: "message", id: "msg_old", role: "assistant", status: "completed", phase: "commentary", content: [{ type: "output_text", text: "Checking", annotations: [] }] },
  { type: "reasoning", id: "rs_old", summary: [], encrypted_content: "opaque-sealed-value" },
  { type: "function_call", id: "fc_old", call_id: "call_old", name: "lookup", arguments: JSON.stringify({ id: "nested-id" }) },
  { type: "function_call_output", id: "fco_old", call_id: "call_old", output: JSON.stringify({ id: "result-id", value: 42 }) },
], tools: [{ type: "function", name: "lookup", parameters: { type: "object", properties: { id: { type: "string" } } } }] });
async function capture(_t, input, init, enabled = true) {
  const prepared = await prepareRequest(input, init, {
    portableResponses: enabled,
    textFilter: null,
    sessionRepair: false,
  });
  return { input, init: prepared };
}
test("portable inline history does not look up IDs on a different resource", async t => {
  const before = history(); const body = JSON.stringify(before);
  const seen = await capture(t, url, { method: "POST", body });
  const after = JSON.parse(seen.init.body);
  const expected = structuredClone(before); expected.store = false;
  for (const item of expected.input) if (item.type !== "reasoning") delete item.id;
  delete expected.input[1].status;
  assert.deepEqual(after, expected);
  assert.deepEqual(JSON.parse(body), before);
});
test("rewriting removes stale body-integrity headers but keeps request identity and signal", async t => {
  const controller = new AbortController();
  const seen = await capture(t, url, { method: "POST", body: JSON.stringify(history()), signal: controller.signal, headers: { "content-length": "100", "content-md5": "old", "digest": "old", "content-digest": "old", "content-type": "application/json", "x-session-id": "session-42" } });
  const h = new Headers(seen.init.headers);
  for (const name of ["content-length", "content-md5", "digest", "content-digest"]) assert.equal(h.has(name), false);
  assert.equal(h.get("x-session-id"), "session-42"); assert.equal(seen.init.signal, controller.signal);
});
test("Request inputs are cloned without consuming the original body", async t => {
  const body = JSON.stringify(history()); const req = new Request(url, { method: "POST", body, headers: { "content-type": "application/json", "content-length": String(body.length), "digest": "old" } });
  const seen = await capture(t, req);
  assert.equal(new Headers(seen.init.headers).has("content-length"), false);
  assert.equal(new Headers(seen.init.headers).has("digest"), false);
  assert.equal(JSON.parse(seen.init.body).input[1].id, undefined);
  assert.equal(await req.text(), body);
});
test("provider switch restores exact original body forwarding", async t => {
  const body = JSON.stringify(history(), null, 2);
  const seen = await capture(t, url, { method: "POST", body }, false); assert.equal(seen.init.body, body);
});
for (const state of [{ previous_response_id: "resp_remote" }, { conversation: "conv_remote" }, { input: [{ type: "item_reference", id: "msg_remote" }] }]) {
  test("server-only context is never silently discarded: " + Object.keys(state)[0], async t => {
    const body = JSON.stringify({ ...history(), ...state }); const seen = await capture(t, url, { method: "POST", body });
    assert.equal(seen.init.body, body);
  });
}
for (const path of ["/v1/chat/completions", "/v1/responses/compact"]) test("other endpoints stay byte-identical: " + path, async t => {
  const body = JSON.stringify(history()); const seen = await capture(t, "https://anyrouter.top" + path, { method: "POST", body }); assert.equal(seen.init.body, body);
});
test("unknown and non-self-contained items retain every field", async t => {
  const before = { store: false, input: [ { type: "reasoning", id: "rs_reference", summary: [] }, { type: "future_item", id: "future_1", payload: "opaque" }, { type: "function_call", id: "fc_reference" }, { type: "compaction", id: "cmp_1", encrypted_content: "opaque" } ] };
  const body = JSON.stringify(before); const seen = await capture(t, url, { method: "POST", body }); assert.equal(seen.init.body, body);
});
test("GET, malformed JSON and encoded bodies stay untouched", async () => {
  const seen = [];
  seen.push(await prepareRequest(url, { method: "GET" }, { portableResponses: true }));
  seen.push(await prepareRequest(url, { method: "POST", body: "{bad" }, { portableResponses: true }));
  seen.push(await prepareRequest(url, { method: "POST", body: JSON.stringify(history()), headers: { "content-encoding": "gzip" } }, { portableResponses: true }));
  assert.equal(seen[0].body, undefined); assert.equal(seen[1].body, "{bad"); assert.equal(seen[2].body, JSON.stringify(history()));
});
test("annotated messages and opaque reasoning remain intact", async t => {
  const items = [ { type: "message", id: "msg_cited", role: "assistant", content: [{ type: "output_text", text: "Source", annotations: [{ type: "url_citation", url: "https://example.org" }] }] }, { type: "reasoning", id: "rs_sealed", summary: [], encrypted_content: "sealed" } ];
  const body = JSON.stringify({ store: true, input: items });
  const seen = await capture(t, url, { method: "POST", body }); assert.equal(seen.init.body, body);
});
test("over-limit and explicitly non-JSON bodies are not rewritten", async t => {
  const body = JSON.stringify({ ...history(), extra: "x".repeat(4 * 1024 * 1024) });
  const seen = await capture(t, url, { method: "POST", body }); assert.equal(seen.init.body, body);
});
test("aborting a stalled Request clone promptly preserves the caller signal", { timeout: 3000 }, async t => {
  const controller = new AbortController();
  const req = new Request(url, { method: "POST", body: new ReadableStream({ start() {} }), duplex: "half" });
  t.after(() => { void req.body.cancel().catch(() => {}); });
  const pending = capture(t, req, { signal: controller.signal });
  const timer = setTimeout(() => controller.abort(), 10); t.after(() => clearTimeout(timer));
  await assert.rejects(pending, { name: "AbortError" });
  assert.equal(req.bodyUsed, false, "cancellation must not consume the sending body");
});
test("the direct body bound counts UTF-8 bytes, not UTF-16 code units", async t => {
  const body = JSON.stringify({ ...history(), extra: "中".repeat(1500000) });
  assert.ok(body.length < 4 * 1024 * 1024);
  const seen = await capture(t, url, { method: "POST", body }); assert.equal(seen.init.body, body);
});
test("explicit non-JSON content type leaves even JSON-looking data alone", async t => {
  const body = JSON.stringify(history());
  const seen = await capture(t, url, { method: "POST", body, headers: { "content-type": "text/plain" } }); assert.equal(seen.init.body, body);
});
test("oversized Request clones stop without consuming the original", async t => {
  const body = JSON.stringify({ ...history(), extra: "x".repeat(4 * 1024 * 1024) });
  const req = new Request(url, { method: "POST", body, headers: { "content-type": "application/json" } });
  const init = {}; assert.equal(await prepareResponsesRequest(req, init), init);
  assert.equal(await req.text(), body);
});
test("a stalled clone respects the preparation deadline", { timeout: 7000 }, async t => {
  const req = new Request(url, { method: "POST", body: new ReadableStream({ start() {} }), duplex: "half" });
  t.after(() => { void req.body.cancel().catch(() => {}); });
  const init = {}; assert.equal(await prepareResponsesRequest(req, init), init);
});

test("prepareAnthropicRequest adds Claude system blocks, metadata, beta and removes stale length", async () => {
  const body = {
    model: "claude-sonnet-4-5",
    max_tokens: 2048,
    system: "You are a careful coding assistant.",
    messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
  };
  const original = JSON.stringify(body, null, 2);
  const headers = { "content-type": "application/json", "content-length": "999", "x-claude-code-session-id": "session-anthropic" };
  const prepared = await prepareAnthropicRequest(anthropicURL, { method: "POST", headers, body: original });
  assert.notEqual(prepared, undefined);
  assert.equal(new Headers(prepared.headers).has("content-length"), false);
  const after = JSON.parse(prepared.body);
  assert.equal(after.max_tokens, 2048);
  assert.deepEqual(after.messages, body.messages);
  assert.equal(after.system.length, 3);
  assert.deepEqual(after.system[0], { type: "text", text: "You are Claude Code, Anthropic's official CLI for Claude." });
  assert.deepEqual(after.system[1], { type: "text", text: "You are a Claude agent, built on Anthropic's Claude Agent SDK.", cache_control: { type: "ephemeral" } });
  assert.deepEqual(after.system[2], { type: "text", text: body.system, cache_control: { type: "ephemeral" } });
  const metadata = JSON.parse(after.metadata.user_id);
  assert.equal(typeof metadata.device_id, "string");
  assert.ok(metadata.device_id.length > 0);
  assert.equal(metadata.account_uuid, "");
  assert.equal(metadata.session_id, "session-anthropic");
  // Body and beta URL are one compatibility decision; requestURL no longer
  // injects Claude beta independently of this enabled transform.
  assert.equal(prepared.url, `${anthropicURL}?beta=true`);
  assert.equal(original, JSON.stringify(body, null, 2));
});

test("prepareAnthropicRequest preserves an existing system array and metadata user id", async () => {
  const body = {
    model: "claude-sonnet-4-5",
    system: [{ type: "text", text: "Existing system", cache_control: { type: "ephemeral" } }],
    metadata: { user_id: "already-set" },
    context_management: { edits: [] },
    messages: [{ role: "user", content: "hello" }],
  };
  const original = JSON.stringify(body);
  const prepared = await prepareAnthropicRequest(anthropicURL, { method: "POST", body: original });
  assert.equal(prepared.body, original);
  assert.equal(new URL(prepared.url).searchParams.get("beta"), "true");
});

test("prepareAnthropicRequest ignores other paths, non-JSON bodies, encoded bodies and disabled compatibility", async () => {
  const body = JSON.stringify({ system: "keep", messages: [] });
  const responsesURL = { method: "POST", body };
  assert.equal((await prepareAnthropicRequest(url, responsesURL)).body, body);
  const textPlain = { method: "POST", body, headers: { "content-type": "text/plain" } };
  assert.equal(await prepareAnthropicRequest(anthropicURL, textPlain), textPlain);
  const gzip = { method: "POST", body, headers: { "content-encoding": "gzip" } };
  assert.equal(await prepareAnthropicRequest(anthropicURL, gzip), gzip);
  const init = { method: "POST", body };
  assert.equal(await prepareAnthropicRequest(anthropicURL, init, { compatibility: false }), init);
});

test("prepareCodexRequest normalizes input, fills Codex defaults and headers", async () => {
  const body = {
    model: "gpt-5.1-codex",
    input: "run the tests",
    max_tokens: 4096,
  };
  const headers = { "content-type": "application/json", "content-length": "999", "x-session-id": "codex-session", "thread-id": "codex-thread" };
  const prepared = await prepareCodexRequest(url, { method: "POST", headers, body: JSON.stringify(body) });
  const after = JSON.parse(prepared.body);
  assert.deepEqual(after.input, [{ type: "message", role: "user", content: [{ type: "input_text", text: "run the tests" }] }]);
  assert.equal(after.prompt_cache_key, "codex-session");
  assert.equal(after.client_metadata.session_id, "codex-session");
  assert.equal(after.client_metadata.thread_id, "codex-thread");
  assert.equal(typeof after.client_metadata.turn_id, "string");
  assert.equal(typeof after.client_metadata["x-codex-installation-id"], "string");
  assert.equal(after.client_metadata["x-codex-window-id"], "codex-session:0");
  const turnMetadata = JSON.parse(after.client_metadata["x-codex-turn-metadata"]);
  assert.equal(turnMetadata.session_id, "codex-session");
  assert.equal(turnMetadata.thread_id, "codex-thread");
  assert.equal(turnMetadata.request_kind, "turn");
  assert.equal(turnMetadata.thread_source, "user");
  assert.equal(typeof turnMetadata.turn_started_at_unix_ms, "number");
  assert.equal(after.reasoning, undefined, "compatibility must not invent unsupported reasoning settings");
  assert.equal(after.stream, true);
  assert.equal(after.store, false);
  assert.equal(after.tool_choice, "auto");
  assert.equal(after.parallel_tool_calls, false);
  assert.deepEqual(after.text, { verbosity: "low" });
  assert.deepEqual(after.include, ["reasoning.encrypted_content"]);
  assert.equal(after.max_output_tokens, 4096);
  const h = new Headers(prepared.headers);
  assert.equal(h.has("content-length"), false);
  assert.equal(h.get("x-codex-window-id"), "codex-session:0");
  assert.equal(h.get("session-id"), "codex-session");
  assert.equal(h.get("thread-id"), "codex-thread");
  assert.equal(h.get("x-client-request-id"), "codex-session");
  assert.equal(JSON.parse(h.get("x-codex-turn-metadata")).session_id, "codex-session");
});

test("prepareCodexRequest preserves existing fields and normalizes array message content", async () => {
  const body = {
    input: [
      { type: "message", role: "user", content: "keep this" },
      { type: "function_call", call_id: "call_keep", name: "tool", arguments: "{}" },
    ],
    prompt_cache_key: "existing-key",
    client_metadata: { session_id: "existing" },
    reasoning: { effort: "high" },
    include: ["reasoning.encrypted_content", "message.output_text.logprobs"],
    max_output_tokens: 123,
    store: true,
    tool_choice: "none",
  };
  const prepared = await prepareCodexRequest(url, { method: "POST", body: JSON.stringify(body) });
  const after = JSON.parse(prepared.body);
  assert.equal(after.prompt_cache_key, "existing-key");
  assert.deepEqual(after.client_metadata, { session_id: "existing" });
  assert.deepEqual(after.reasoning, { effort: "high" }, "existing reasoning settings stay untouched");
  assert.deepEqual(after.include, ["reasoning.encrypted_content", "message.output_text.logprobs"]);
  assert.equal(after.max_output_tokens, 123);
  assert.equal(after.store, true);
  assert.equal(after.tool_choice, "none");
  assert.deepEqual(after.input[0].content, [{ type: "input_text", text: "keep this" }]);
  assert.deepEqual(after.input[1], body.input[1]);
});

test("prepareCodexRequest ignores non-Responses paths, GET, malformed and oversized bodies", async () => {
  const body = JSON.stringify({ input: "hello" });
  for (const [input, init] of [
    ["https://anyrouter.top/v1/chat/completions", { method: "POST", body }],
    [url, { method: "GET", body }],
    [url, { method: "POST", body: "{bad" }],
    [url, { method: "POST", body: JSON.stringify({ input: "x".repeat(4 * 1024 * 1024) }) }],
  ]) {
    assert.equal(await prepareCodexRequest(input, init), init);
  }
});
