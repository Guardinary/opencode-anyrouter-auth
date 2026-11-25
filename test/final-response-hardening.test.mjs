import assert from "node:assert/strict";
import test from "node:test";
import { saveAccount } from "../lib/accounts.mjs";
import { createProvider } from "../lib/provider.mjs";
import { explainResponse } from "../lib/response.mjs";

const key = "sk-synthetic-diagnostic-key", password = "synthetic+password%", token = "synthetic-console-token", cookie = "synthetic-cookie-value";
const auth = () => saveAccount({ mode: "password", site: "top", siteURL: "https://anyrouter.top", apiBase: "https://anyrouter.top/v1", userId: "123", username: "alice",
  key, password, accessToken: token, session: `session=${cookie}`, checkinEnabled: true, loginGeneration: "synthetic-diagnostic-login" });
const frame = value => `data: ${JSON.stringify(value)}\n\n`;
const sse = text => new Response(text, { headers: { "content-type": "text/event-stream" } });
async function throughLoader(response) {
  const record = auth();
  const hooks = await createProvider({}, {}, { fetchImpl: async () => response });
  const loaded = await hooks.auth.loader(async () => record);
  return loaded.fetch("https://anyrouter.top/v1/responses", { method: "POST", body: JSON.stringify({ model: "gpt-future", input: "synthetic" }) });
}
function assertRedacted(text) {
  for (const value of [key, password, token, cookie]) {
    assert.equal(text.includes(value), false, "a transformed diagnostic must not contain an account secret");
    assert.equal(text.includes(encodeURIComponent(value)), false, "URL-encoded credentials must also be redacted");
  }
}
for (const kind of ["JSON", "SSE"]) {
  test(`${kind} transformed diagnostics redact credential echoes in codes and messages`, async () => {
    const message = `busy ${key} ${password} ${token} ${cookie} ${encodeURIComponent(password)}`;
    const value = { error: { status: 503, code: `echo-${key}`, message } };
    const source = kind === "JSON" ? Response.json(value) : sse(frame(value));
    const result = await throughLoader(source);
    assert.equal(result.status, 503);
    assertRedacted(await result.text());
  });
}

test("diagnostic hints derived from an upstream model/id string are also redacted", async () => {
  const message = `Your requests to ${key} for user exceeded token rate limit; request id: ${token}; ${password}`;
  const result = await throughLoader(Response.json({ error: { message } }));
  assert.equal(result.status, 429);
  assertRedacted(await result.text());
});

test("structured unknown error codes are not copied into transformed diagnostics", async () => {
  const result = await throughLoader(Response.json({ error: { type: "server_error", code: { private: key }, message: "busy" } }));
  assert.equal(result.status, 500);
  const value = await result.json();
  assert.equal(typeof value.error.code, "number");
  assertRedacted(JSON.stringify(value));
});

for (const kind of ["JSON", "SSE"]) {
  test(`${kind} deeply nested opaque response metadata releases unchanged without a stack overflow`, async () => {
    const nested = '{"response":'.repeat(4000) + '{"future_state":"opaque"}' + '}'.repeat(4000);
    const data = `{"error":{"code":"server_error","message":"busy"},"response":${nested}}`;
    const text = kind === "SSE" ? `event: error\ndata: ${data}\n\n` : data;
    assert.ok(Buffer.byteLength(text) < 64 * 1024);
    const source = kind === "SSE" ? sse(text) : new Response(text, { headers: { "content-type": "application/json" } });
    const result = await explainResponse(source);
    assert.equal(result.status, 200);
    assert.equal(await result.text(), text);
  });
}

const completion = extra => ({ type: "response.completed", response: { status: "completed", output: [], usage: { input_tokens: 0, output_tokens: 0 }, ...extra } });
for (const [name, value] of [
  ["future response state", completion({ encrypted_content: "opaque-future-state" })],
  ["signed top-level event", { ...completion({}), signature: "opaque-event-signature" }],
  ["unknown usage state", completion({ usage: { input_tokens: 0, output_tokens: 0, future_usage: { sealed: "opaque" } } })],
  ["nonzero reasoning usage", completion({ usage: { input_tokens: 0, output_tokens: 0, output_tokens_details: { reasoning_tokens: 1 } } })],
]) {
  test(`an apparently empty completion with ${name} is not repackaged as a proven empty failure`, async () => {
    const text = frame(value), result = await explainResponse(sse(text));
    assert.equal(result.status, 200);
    assert.equal(await result.text(), text);
  });
}
for (const [name, extension] of [
  ["opaque reasoning effort", { reasoning: { effort: { sealed: "opaque" } } }],
  ["opaque text format", { text: { format: { type: "text", future_state: "opaque" } } }],
  ["opaque instruction field", { instructions: { sealed: "opaque" } }],
  ["future tool declaration", { tools: [{ type: "future_tool", sealed: "opaque" }] }],
  ["opaque numeric config", { max_output_tokens: { signed: "opaque" } }],
]) {
  test(`a known prelude with ${name} releases before a later error`, async () => {
    const text = frame({ type: "response.created", response: { status: "in_progress", output: [], ...extension } }) + frame({ error: { code: "server_error", message: "busy" } });
    const result = await explainResponse(sse(text));
    assert.equal(result.status, 200);
    assert.equal(await result.text(), text);
  });
}

test("known all-zero terminal metadata can still produce the explicit empty-response diagnostic", async () => {
  const result = await explainResponse(sse(frame(completion({ usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0, output_tokens_details: { reasoning_tokens: 0 } } }))));
  assert.equal(result.status, 502);
  assert.equal((await result.json()).error.code, "empty_response");
});

test("semantic output remains byte-identical even when it intentionally mentions a synthetic credential", async () => {
  const text = JSON.stringify({ error: { code: "server_error", message: "busy" }, output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: key }] }] });
  const source = new Response(text, { headers: { "content-type": "application/json" } });
  const result = await throughLoader(source);
  assert.equal(result, source);
  assert.equal(await result.text(), text, "privacy diagnostics must not silently rewrite user-visible model output");
});

test("invalid UTF-8 in an SSE frame releases its original bytes instead of inventing a parsed error", async () => {
  const prefix = Buffer.from('data: {"error":{"code":"server_error","message":"invalid ');
  const bytes = Buffer.concat([prefix, Buffer.from([0xff]), Buffer.from('"}}\n\n')]);
  const result = await explainResponse(sse(bytes));
  assert.equal(result.status, 200);
  assert.deepEqual(Buffer.from(await result.arrayBuffer()), bytes);
});

test("a rewritten diagnostic removes stale digest headers but retains unrelated metadata", async () => {
  const response = Response.json({ error: { code: "server_error", message: "busy" } }, { headers: {
    "content-digest": "sha-256=:old-content:", "repr-digest": "sha-256=:old-representation:", "x-request-id": "synthetic-request",
  } });
  const result = await explainResponse(response);
  assert.equal(result.status, 500);
  assert.equal(result.headers.get("content-digest"), null);
  assert.equal(result.headers.get("repr-digest"), null);
  assert.equal(result.headers.get("x-request-id"), "synthetic-request");
});
