import assert from "node:assert/strict";
import test from "node:test";
import { createCatalog, buildCatalog, protocolForModel } from "../lib/catalog.mjs";
import { declaredModels, DECLARED_MODEL_IDS } from "../lib/declared-models.mjs";

const account = (extra = {}) => ({
  mode: "session",
  site: "top",
  siteURL: "https://anyrouter.top",
  apiBase: "https://anyrouter.top/v1",
  key: "model-key",
  hasModelKey: true,
  userId: "123",
  session: "session=site",
  ...extra
});

const provider = () => ({ id: "anyrouter", models: declaredModels() });

test("declared model catalog contains the 16 public AnyRouter models with protocol-specific SDKs", () => {
  const models = declaredModels();
  assert.equal(Object.keys(models).length, 16);
  assert.deepEqual(Object.keys(models), DECLARED_MODEL_IDS);
  assert.equal(models["claude-opus-4-6"].limit.context, 500_000);
  assert.equal(models["claude-opus-4-6"].limit.output, 32_000);
  assert.equal(models["claude-opus-4-6"].api, undefined);
  assert.equal(models["gpt-5-codex"].api.npm, "@ai-sdk/openai");
  assert.equal(models["gpt-5-codex"].api.url, "https://anyrouter.top/v1");
  assert.equal(models["gemini-2.5-pro"].api.npm, "@ai-sdk/openai");
  assert.equal(models["gpt-6-astra-cc-format"].api, undefined);
});

test("protocol mapping sends Claude to Anthropic Messages and GPT/Gemini to Responses", () => {
  assert.equal(protocolForModel("claude-opus-4-6"), "anthropic");
  assert.equal(protocolForModel("gpt-6-astra-cc-format"), "anthropic");
  assert.equal(protocolForModel("gpt-5-codex"), "responses");
  assert.equal(protocolForModel("gemini-2.5-pro"), "responses");
  assert.equal(protocolForModel("unknown-model"), "responses");
});

test("buildCatalog applies declared models, protocol SDKs and the single AnyRouter API base", () => {
  const rows = DECLARED_MODEL_IDS.map(id => ({ id }));
  const out = buildCatalog(rows, provider(), account(), {
    npm: "@ai-sdk/anthropic",
    api: "https://anyrouter.top/v1",
    models: {}
  });
  assert.equal(Object.keys(out).length, 16);
  for (const model of Object.values(out)) {
    assert.equal(model.api.url, "https://anyrouter.top/v1");
  }
  assert.equal(out["claude-opus-4-6"].api.npm, "@ai-sdk/anthropic");
  assert.equal(out["claude-3-5-haiku-20241022"].api.npm, "@ai-sdk/anthropic");
  assert.equal(out["gpt-5-codex"].api.npm, "@ai-sdk/openai");
  assert.equal(out["gemini-2.5-pro"].api.npm, "@ai-sdk/openai");
  assert.equal(out["gpt-6-astra-cc-format"].api.npm, "@ai-sdk/anthropic");
});

test("explicit model overrides keep aliases, SDK, official base URL, headers and limits", () => {
  const explicit = {
    npm: "@ai-sdk/anthropic",
    api: "https://anyrouter.top/v1",
    models: {
      friendly: {
        id: "gpt-5-codex",
        name: "My model",
        provider: { npm: "@ai-sdk/openai-compatible", api: "https://anyrouter.top/v1" },
        headers: { "x-selected": "yes" },
        limit: { context: 1234 }
      }
    }
  };
  const out = buildCatalog([{ id: "gpt-5-codex" }], provider(), account(), explicit);
  assert.deepEqual(Object.keys(out), ["friendly"]);
  assert.equal(out.friendly.api.id, "gpt-5-codex");
  assert.equal(out.friendly.api.url, "https://anyrouter.top/v1");
  assert.equal(out.friendly.api.npm, "@ai-sdk/openai-compatible");
  assert.equal(out.friendly.limit.context, 1234);
  assert.equal(out.friendly.headers["x-selected"], "yes");
});

test("public pricing metadata never grants a model the account did not discover", () => {
  const out = buildCatalog([{ id: "gpt-5-codex" }], provider(), account(), { models: {} }, [
    { model_name: "pricing-only", limit: { context: 999 } }
  ]);
  assert.deepEqual(Object.keys(out), ["gpt-5-codex"]);
});

test("site-only accounts receive no inference catalog and make no network call", async () => {
  let calls = 0;
  const catalog = createCatalog({
    site: { request: async () => ({ data: [] }) },
    explicit: () => ({ models: {} }),
    compatibility: () => false,
    fetchImpl: async () => { calls++; throw new Error("no model key must not reach upstream"); },
    loadRegistry: async () => ({})
  });
  const out = await catalog(provider(), { hasModelKey: false, key: "", siteURL: "https://anyrouter.top" });
  assert.equal(calls, 0);
  assert.deepEqual(out, {}, "balance-only accounts must not advertise unusable models");
});

test("discovery uses the account model key and never adds registry-only models", async () => {
  const calls = [];
  const catalog = createCatalog({
    site: { request: async () => ({ data: [] }) },
    explicit: () => ({ models: {} }),
    compatibility: () => false,
    fetchImpl: async (url, init) => {
      calls.push({ url: String(url), init });
      return Response.json({ data: [
        { id: "gpt-5-codex", supported_endpoint_types: ["responses"] },
        { id: "claude-opus-4-6" }
      ] });
    },
    loadRegistry: async () => ({ openai: { models: { "registry-only": { reasoning: true } } } })
  });
  const out = await catalog(provider(), account());
  assert.deepEqual(Object.keys(out).sort(), ["claude-opus-4-6", "gpt-5-codex"]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://anyrouter.top/v1/models");
  assert.equal(calls[0].init.headers.get("authorization"), "Bearer model-key");
  assert.equal(calls[0].init.headers.get("cookie"), null);
});

test("discovery failure falls back to the provider-declared models with a visible marker", async () => {
  const catalog = createCatalog({
    site: { request: async () => ({ data: [] }) },
    explicit: () => ({ models: {} }),
    compatibility: () => false,
    fetchImpl: async () => { throw new Error("offline"); },
    loadRegistry: async () => { throw new Error("offline registry"); }
  });
  const out = await catalog(provider(), account());
  assert.equal(Object.keys(out).length, 16);
  assert.equal(out[Symbol.for("magpie.fellBack")], true);
  assert.equal(out["claude-opus-4-6"].api.npm, "@ai-sdk/anthropic");
});
