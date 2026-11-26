import assert from "node:assert/strict";
import test from "node:test";
import { declaredModels, declaredConfigModels, DECLARED_MODEL_IDS } from "../lib/declared-models.mjs";
import { createProvider } from "../lib/provider.mjs";
import { trustedURL } from "../lib/safety.mjs";

const origin = "https://anyrouter.top", key = "sk-synthetic-native-test";
async function loader(response, options = {}) {
  const calls = [];
  const hooks = await createProvider({ magpie: { option: () => false } }, {}, { fetchImpl: async (url, init) => {
    calls.push({ url: url instanceof Request ? url.url : String(url), init }); return response;
  }, ...options });
  return { fetch: (await hooks.auth.loader(async () => ({ type: "api", key }))).fetch, calls };
}

test("Gemini 4 declarations retain registry-backed friendly names and separate input/output limits", () => {
  const runtime = declaredModels(), config = declaredConfigModels();
  assert.equal(DECLARED_MODEL_IDS.length, 18);
  for (const [id, name, output] of [["gemini-4-carbon", "Gemini 4 Carbon", 32768], ["gemini-4-neon", "Gemini 4 Neon", 65536]]) {
    assert.equal(runtime[id].name, name);
    assert.equal(runtime[id].limit.context, 1048576);
    assert.equal(runtime[id].limit.output, output);
    assert.equal(runtime[id].capabilities.reasoning, true);
    assert.deepEqual(config[id].provider, { npm: "@ai-sdk/google", api: `${origin}/v1beta` });
    assert.equal(config[id].limit.input, undefined, "maker metadata does not invent a site input sub-limit");
  }
});

for (const action of ["generateContent", "streamGenerateContent", "countTokens"]) {
  test(`native ${action} normalizes official v1/trailing-slash inputs without changing signed bodies`, async () => {
    const response = action === "countTokens" ? Response.json({ totalTokens: 5 }) : Response.json({ candidates: [{ content: { parts: [{ text: "OK" }] } }] });
    const h = await loader(response), body = JSON.stringify({ contents: [{ role: "user", parts: [{ text: "synthetic", thoughtSignature: "retain" }] }] }, null, 2);
    const res = await h.fetch(`${origin}/v1/models/gemini-4-neon:${action}/?alt=sse&key=gateway-placeholder`, { method: "POST", body });
    assert.equal(res, response);
    assert.equal(h.calls.length, 1);
    assert.equal(h.calls[0].url, `${origin}/v1beta/models/gemini-4-neon:${action}?alt=sse`);
    assert.equal(h.calls[0].init.body, body);
    assert.equal(h.calls[0].init.headers.get("x-goog-api-key"), key);
    assert.equal(h.calls[0].init.headers.get("authorization"), null);
  });
}

test("countTokens permits only the exact official action, not files/delete or an inherited v1 model suffix", () => {
  assert.equal(trustedURL(`${origin}/v1beta/models/gemini-4-neon:countTokens`, { model: true }).origin, origin);
  for (const url of [
    `${origin}/v1/models/gemini-4-neon:delete`, `${origin}/v1beta/files`, `${origin}/v1beta/models/gemini:countTokens/extra`,
    `${origin}/v1beta/models/gemini%2fsecret:countTokens`, "https://other.example/v1beta/models/gemini:countTokens",
  ]) assert.throws(() => trustedURL(url, { model: true }));
});

for (const [name, data] of [["generated candidates", { candidates: [{ content: { parts: [{ text: "not a count" }] } }] }],
  ["missing count", {}], ["string count", { totalTokens: "7" }], ["negative count", { totalTokens: -1 }],
  ["unsafe count", { totalTokens: Number.MAX_SAFE_INTEGER + 1 }]]) {
  test(`countTokens rejects ${name} instead of manufacturing a token total`, async () => {
    const h = await loader(Response.json(data));
    const result = await h.fetch(`${origin}/v1beta/models/gemini-4-neon:countTokens`, { method: "POST", body: "{}" });
    assert.equal(result.status, 502);
    const value = await result.json();
    assert.equal(value.error.status, "UNAVAILABLE");
    assert.match(value.error.message, /计数/);
    assert.equal(value.totalTokens, undefined);
    assert.equal(h.calls.length, 1, "do not fallback to another generation or count endpoint");
  });
}

test("replacing an invalid count cancels the unused original body without waiting for an uncooperative cancel", async () => {
  let cancellations = 0;
  const source = new Response(new ReadableStream({
    start(controller) { controller.enqueue(new TextEncoder().encode('{"candidates":[]}')); },
    cancel() { cancellations++; return new Promise(() => {}); },
  }), { headers: { "content-type": "application/json" } });
  const h = await loader(source);
  const result = await h.fetch(`${origin}/v1beta/models/gemini-4-neon:countTokens`, { method: "POST", body: "{}" });
  assert.equal(result.status, 502);
  assert.equal(cancellations, 1);
});

test("valid zero count and actual upstream errors remain intact", async () => {
  for (const response of [Response.json({ totalTokens: 0 }), Response.json({ error: { code: 403, status: "PERMISSION_DENIED", message: "denied" } }, { status: 403 })]) {
    const h = await loader(response);
    assert.equal(await h.fetch(`${origin}/v1beta/models/gemini-4-neon:countTokens`, { method: "POST", body: "{}" }), response);
  }
});
