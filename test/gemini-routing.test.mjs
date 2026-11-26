import assert from "node:assert/strict";
import test from "node:test";
import { buildCatalog, createCatalog, protocolForModel } from "../lib/catalog.mjs";
import { declaredConfigModels } from "../lib/declared-models.mjs";
import { createProvider } from "../lib/provider.mjs";
import { trustedURL } from "../lib/safety.mjs";

const origin = "https://anyrouter.top", googleBase = `${origin}/v1beta`;
const account = { hasModelKey: true, key: "sk-synthetic-gemini", apiBase: `${origin}/v1`, siteURL: origin };

test("Gemini family chooses native Google without overriding cc-format or explicit endpoint metadata", () => {
  assert.equal(protocolForModel("gemini-4-carbon"), "gemini");
  assert.equal(protocolForModel("gemini-4-neon"), "gemini");
  assert.equal(protocolForModel("gemini-future-cc-format"), "anthropic");
  const models = buildCatalog([
    { id: "gemini-4-carbon", supported_endpoint_types: [null, { toString: "opaque" }, "constructor", "__proto__"] }, { id: "gemini-4-neon", supported_endpoint_types: ["google"] },
    { id: "custom-native", supported_endpoint_types: ["gemini"] },
    { id: "gemini-explicit-responses", supported_endpoint_types: ["responses"] },
    { id: "gpt-future" }, { id: "claude-future" },
  ], {}, account);
  for (const id of ["gemini-4-carbon", "gemini-4-neon", "custom-native"]) {
    assert.equal(models[id].api.npm, "@ai-sdk/google");
    assert.equal(models[id].api.url, googleBase);
  }
  assert.equal(models["gemini-explicit-responses"].api.npm, "@ai-sdk/openai");
  assert.equal(models["gemini-explicit-responses"].api.url, `${origin}/v1`);
  assert.equal(models["gpt-future"].api.npm, "@ai-sdk/openai");
  assert.equal(models["claude-future"].api.npm, "@ai-sdk/anthropic");
});

test("Gemini configuration, preview and failure fallback use host-shaped native SDK/base", async () => {
  assert.deepEqual(declaredConfigModels()["gemini-2.5-pro"].provider, { npm: "@ai-sdk/google", api: googleBase });
  const catalog = createCatalog({ site: {}, fetchImpl: async () => { throw new Error("offline"); } });
  for (const auth of [null, account]) {
    const models = await catalog({}, auth);
    assert.equal(models["gemini-2.5-pro"].api.npm, "@ai-sdk/google");
    assert.equal(models["gemini-2.5-pro"].api.url, googleBase);
  }
});

test("explicit Gemini SDK overrides remain authoritative and model discovery still uses /v1/models", async () => {
  const manual = buildCatalog([{ id: "gemini-4-neon" }], {}, account, { models: {
    alias: { id: "gemini-4-neon", provider: { npm: "@ai-sdk/openai", api: `${origin}/v1` } },
  } });
  assert.equal(manual.alias.api.npm, "@ai-sdk/openai");
  assert.equal(manual.alias.api.url, `${origin}/v1`);
  const calls = [];
  const catalog = createCatalog({ site: { request: async () => ({ data: [] }) }, loadRegistry: async () => ({}),
    fetchImpl: async (url, init) => { calls.push({ url, init }); return Response.json({ data: [{ id: "gemini-4-neon" }] }); },
  });
  const models = await catalog({}, { ...account, apiBase: googleBase });
  assert.equal(calls[0].url, `${origin}/v1/models`);
  assert.equal(calls[0].init.headers.get("authorization"), `Bearer ${account.key}`);
  assert.equal(models["gemini-4-neon"].api.url, googleBase);
});

for (const action of ["generateContent", "streamGenerateContent"]) {
  test(`native ${action} is permitted only at the official origin and exact model-action path`, () => {
    assert.equal(trustedURL(`${googleBase}/models/gemini-4-neon:${action}?alt=sse`, { model: true }).origin, origin);
    for (const path of [
      `${googleBase}/models/gemini-4-neon:delete`, `${googleBase}/files`,
      `${googleBase}/models/gemini%2fsecret:${action}`, `${googleBase}/models/gemini:x:${action}`,
      `https://untrusted.example/v1beta/models/gemini-4-neon:${action}`,
    ]) assert.throws(() => trustedURL(path, { model: true }));
  });
  test(`loader forwards ${action} once with the account Google key and unmodified signed contents`, async () => {
    const calls = [], controller = new AbortController();
    const source = Response.json({ candidates: [{ content: { parts: [{ text: "synthetic OK" }] }, finishReason: "STOP" }] });
    const hooks = await createProvider({ magpie: { option: () => true } }, {}, {
      fetchImpl: async (target, init) => { calls.push({ target: String(target), init }); return source; },
    });
    const auth = { type: "api", key: account.key };
    const loaded = await hooks.auth.loader(async () => auth);
    const body = JSON.stringify({ contents: [{ role: "model", parts: [{ text: "history", thoughtSignature: "synthetic-signature" }] }], generationConfig: { maxOutputTokens: 32 } }, null, 2);
    const url = `${googleBase}/models/gemini-4-neon:${action}?alt=sse`;
    const result = await loaded.fetch(url, { method: "POST", body, signal: controller.signal,
      headers: { "content-type": "application/json", "x-goog-api-key": "gateway-placeholder", authorization: "Bearer must-not-forward", cookie: "session=must-not-forward", "new-api-user": "123" },
    });
    assert.equal(result.status, 200);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].target, url);
    assert.equal(calls[0].init.body, body);
    assert.equal(calls[0].init.signal, controller.signal);
    assert.equal(calls[0].init.redirect, "manual");
    assert.equal(calls[0].init.headers.get("x-goog-api-key"), account.key);
    for (const field of ["authorization", "cookie", "new-api-user", "originator", "anthropic-beta"]) assert.equal(calls[0].init.headers.has(field), false);
  });
}

test("native Gemini URL query key is removed, redirects are blocked, and no fallback model request is replayed", async () => {
  let count = 0, target;
  const hooks = await createProvider({}, {}, { fetchImpl: async (url) => {
    count++; target = String(url); return new Response(null, { status: 307, headers: { location: "https://untrusted.example" } });
  } });
  const loaded = await hooks.auth.loader(async () => ({ type: "api", key: account.key }));
  const result = await loaded.fetch(`${googleBase}/models/gemini-4-carbon:generateContent?key=gateway-placeholder`, { method: "POST", body: "{}" });
  assert.equal(result.status, 502);
  assert.equal((await result.json()).error.code, "anyrouter_upstream_redirect");
  assert.equal(count, 1);
  assert.equal(new URL(target).searchParams.has("key"), false);
});
