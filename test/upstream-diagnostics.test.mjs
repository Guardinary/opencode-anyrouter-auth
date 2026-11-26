import assert from "node:assert/strict";
import test from "node:test";
import { explainResponse } from "../lib/response.mjs";
import { createProvider } from "../lib/provider.mjs";

const frame = value => `data: ${JSON.stringify(value)}\n\n`;
const source = (value, status = 200, stream = false) => new Response(stream ? frame(value) : JSON.stringify(value), {
  status, headers: { "content-type": stream ? "text/event-stream" : "application/json", "x-request-id": "synthetic-request" },
});

for (const [name, error, expected, kind] of [
  ["Google exhausted resources", { status: "RESOURCE_EXHAUSTED" }, 429, "anyrouter_upstream_rate_limit"],
  ["Google unavailable", { status: "UNAVAILABLE" }, 503, "anyrouter_upstream_busy"],
  ["Chinese saturated load", { message: "模型负载已经达到上限，请稍后再试" }, 503, "anyrouter_upstream_busy"],
  ["Chinese reached capacity", { message: "负载已达上限" }, 503, "anyrouter_upstream_busy"],
]) {
  for (const stream of [false, true]) test(`${name} maps early ${stream ? "SSE" : "JSON"} failure without an answer`, async () => {
    const result = await explainResponse(source({ error }, 200, stream), { retryAfterSeconds: 23 });
    assert.equal(result.status, expected);
    assert.equal((await result.json()).error.type, kind);
    assert.equal(result.headers.get("x-request-id"), "synthetic-request");
    assert.equal(result.headers.get("retry-after"), expected === 429 ? "23" : null);
  });
}

for (const status of [500, 503]) test(`real HTTP ${status} retains transport status and explains only explicit meaningful failures`, async () => {
  const result = await explainResponse(source({ error: { message: "模型负载已经达到上限" } }, status));
  assert.equal(result.status, status);
  const value = await result.json();
  assert.equal(value.error.type, "anyrouter_upstream_busy");
  assert.match(value.error.message, /未自动重试/);
  assert.equal(value.error.upstream, "模型负载已经达到上限");
  for (const payload of [{ error: {} }, { opaque: "signed", message: "负载已达上限" }, { error: { code: "new_business_error" } }]) {
    const original = source(payload, status);
    assert.equal(await explainResponse(original), original);
  }
});

test("Google and Chinese business failures veto transient wording at every error boundary", async () => {
  for (const business of [
    { message: "Quota exceeded", status: "RESOURCE_EXHAUSTED" },
    { message: "余额不足，负载已达上限" }, { message: "配额已用尽" },
    { status: "PERMISSION_DENIED" }, { status: "UNAUTHENTICATED" },
    { code: "insufficient_quota" },
  ]) for (const status of [200, 500, 503]) {
    const payload = { ...business, error: { code: 503, message: "负载已达上限" } };
    const original = source(payload, status);
    assert.equal(await explainResponse(original), original, JSON.stringify(business));
    assert.deepEqual(await original.json(), payload);
  }
});

test("capacity wording never swallows Gemini candidates, signatures or a prior SSE answer", async () => {
  const error = { status: "UNAVAILABLE", message: "负载已达上限" };
  const payloads = [
    { error, candidates: [{ content: { parts: [{ text: "partial answer" }] } }] },
    { error, candidates: [{ content: { parts: [{ thoughtSignature: "synthetic-signature" }] } }] },
  ];
  for (const status of [200, 500, 503]) for (const payload of payloads) {
    const original = source(payload, status);
    assert.equal(await explainResponse(original), original);
  }
  const text = frame(payloads[0]) + frame({ error });
  const result = await explainResponse(new Response(text, { headers: { "content-type": "text/event-stream" } }));
  assert.equal(result.status, 200);
  assert.equal(await result.text(), text);
});

test("native Gemini loader emits SDK-compatible numeric codes and canonical status with redaction and one fetch", async () => {
  const key = "sk-synthetic-native-diagnostic";
  for (const stream of [false, true]) {
    let fetches = 0;
    const hooks = await createProvider({}, {}, { fetchImpl: async () => {
      fetches++;
      return source({ error: { status: "UNAVAILABLE", code: `echo-${key}`, message: `负载已达上限 ${key}` } }, stream ? 200 : 500, stream);
    } });
    const loaded = await hooks.auth.loader(async () => ({ type: "api", key }));
    const result = await loaded.fetch("https://anyrouter.top/v1beta/models/gemini-4-neon:generateContent", { method: "POST", body: "{}" });
    const error = (await result.json()).error;
    assert.equal(result.status, stream ? 503 : 500);
    assert.equal(error.code, result.status);
    assert.equal(error.status, stream ? "UNAVAILABLE" : "INTERNAL");
    assert.equal(error.type, "anyrouter_upstream_busy");
    assert.equal(JSON.stringify(error).includes(key), false);
    assert.equal(fetches, 1);
  }
});

test("diagnostics-disabled native loader preserves the original upstream error", async () => {
  const original = source({ error: { status: "UNAVAILABLE", message: "负载已达上限" } }, 503);
  const hooks = await createProvider({ magpie: { option: () => false } }, {}, { fetchImpl: async () => original });
  const loaded = await hooks.auth.loader(async () => ({ type: "api", key: "sk-synthetic-native" }));
  assert.equal(await loaded.fetch("https://anyrouter.top/v1beta/models/gemini-4-neon:generateContent", { method: "POST", body: "{}" }), original);
});

test("native replay does not parse SSE as JSON because of a media-type parameter", async () => {
  const text = frame({ candidates: [{ content: { parts: [{ text: "synthetic answer" }] } }] });
  const result = await explainResponse(new Response(text, { headers: { "content-type": "text/event-stream; profile=json" } }), { protocol: "gemini" });
  assert.equal(result.status, 200);
  assert.equal(await result.text(), text);
});

test("Google Retry-After and bounded inspection remain authoritative", async () => {
  const original = source({ error: { status: "RESOURCE_EXHAUSTED" } });
  original.headers.set("retry-after", "31");
  assert.equal((await explainResponse(original)).headers.get("retry-after"), "31");
  const oversized = source({ error: { status: "UNAVAILABLE", message: "x".repeat(70 * 1024) } }, 503);
  assert.equal(await explainResponse(oversized), oversized);
  const controller = new AbortController(); controller.abort(new Error("synthetic abort"));
  await assert.rejects(explainResponse(source({ error: { status: "UNAVAILABLE" } }), { signal: controller.signal }), /synthetic abort/);
});
