import assert from "node:assert/strict";
import test from "node:test";
import { buildCatalog, createCatalog } from "../lib/catalog.mjs";
import { declaredConfigModels, DECLARED_MODEL_IDS } from "../lib/declared-models.mjs";
import { createProvider } from "../lib/provider.mjs";
import { createModelRegistry } from "../lib/model-registry.mjs";

const origin = "https://anyrouter.top", baseURL = `${origin}/v1`;
const account = { hasModelKey: true, key: "sk-synthetic", siteURL: origin, apiBase: baseURL };
const hostFilled = (id, npm = "@ai-sdk/anthropic") => ({ id, api: { id, url: baseURL, npm },
  limit: { context: 0, output: 0 }, capabilities: { reasoning: false, attachment: false, toolcall: true, input: { text: true }, output: { text: true } } });
const catalog = (data, extra = {}) => createCatalog({
  site: { request: async () => ({ data: [] }) }, loadRegistry: async () => ({}),
  fetchImpl: async () => Response.json({ data }), ...extra,
});
function gate() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

test("config declarations have host-supported provider and modality fields, never runtime-only objects", () => {
  const models = declaredConfigModels();
  assert.deepEqual(Object.keys(models), DECLARED_MODEL_IDS);
  for (const row of Object.values(models)) {
    assert.equal(row.provider.api, row.provider.npm === "@ai-sdk/google" ? `${origin}/v1beta` : baseURL);
    assert.equal(typeof row.reasoning, "boolean");
    assert.equal(typeof row.attachment, "boolean");
    assert.equal(typeof row.tool_call, "boolean");
    assert.deepEqual(row.modalities.input, ["text", "image"]);
    assert.deepEqual(row.modalities.output, ["text"]);
    assert.equal(row.api, undefined);
    assert.equal(row.capabilities, undefined);
  }
  assert.equal(models["gpt-6.1-sol"].provider.npm, "@ai-sdk/openai");
  assert.equal(models["gpt-6-astra-cc-format"].provider.npm, "@ai-sdk/anthropic");
});

test("host placeholder SDKs do not override undeclared authenticated GPT and Claude routing", () => {
  const out = buildCatalog([{ id: "gpt-future" }, { id: "claude-future" }], { id: "anyrouter", models: {
    "gpt-future": hostFilled("gpt-future"), "claude-future": hostFilled("claude-future", "@ai-sdk/openai") } }, account);
  assert.equal(out["gpt-future"].api.npm, "@ai-sdk/openai");
  assert.equal(out["claude-future"].api.npm, "@ai-sdk/anthropic");
});

test("declared image/reasoning flags survive a host-filled false capability schema", () => {
  const out = buildCatalog([{ id: "gpt-6.1-sol" }, { id: "claude-3-5-haiku-20241022" }], { models: {
    "gpt-6.1-sol": hostFilled("gpt-6.1-sol"), "claude-3-5-haiku-20241022": hostFilled("claude-3-5-haiku-20241022") } }, account);
  assert.equal(out["gpt-6.1-sol"].capabilities.reasoning, true);
  assert.equal(out["gpt-6.1-sol"].capabilities.input.image, true);
  assert.equal(out["gpt-6.1-sol"].capabilities.output.text, true, "declared models also have an explicit text output capability");
  assert.equal(out["claude-3-5-haiku-20241022"].capabilities.reasoning, false);
  assert.equal(out["claude-3-5-haiku-20241022"].capabilities.input.image, true);
});

test("unknown host-filled false flags are not proof against authenticated or registry capabilities", () => {
  const out = buildCatalog([{ id: "gpt-future", reasoning: true, modalities: { input: ["text", "image"], output: ["text"] } }],
    { models: { "gpt-future": hostFilled("gpt-future") } }, account);
  assert.equal(out["gpt-future"].capabilities.reasoning, true);
  assert.equal(out["gpt-future"].capabilities.input.image, true);
});

test("explicit false and modality lists are authoritative over inherited capabilities", () => {
  const out = buildCatalog([{ id: "gpt-6.1-sol", reasoning: true, attachment: true, modalities: { input: ["text", "image"], output: ["text"] } }], {}, account,
    { models: { alias: { id: "gpt-6.1-sol", provider: { npm: "@ai-sdk/openai-compatible", api: baseURL },
      reasoning: false, attachment: false, tool_call: false, modalities: { input: ["text"], output: [] } } } });
  assert.equal(out.alias.api.npm, "@ai-sdk/openai-compatible");
  assert.equal(out.alias.capabilities.reasoning, false);
  assert.equal(out.alias.capabilities.attachment, false);
  assert.equal(out.alias.capabilities.toolcall, false);
  assert.equal(out.alias.capabilities.input.image, false);
  assert.equal(out.alias.capabilities.output.text, false);
  assert.deepEqual(out.alias.variants, {});
});

test("successful account catalogs include discovered aliases only, not manual or public-only IDs", async () => {
  const load = catalog([{ id: "gpt-future" }, { id: "disabled" }], {
    explicit: () => ({ models: { friendly: { id: "gpt-future", name: "Friendly" }, disabled: { disabled: true }, manual: {} } }),
    site: { request: async () => ({ data: [{ model_name: "public-only" }] }) },
    loadRegistry: async () => ({ openai: { models: { "registry-only": {} } } }),
  });
  const models = await load({ models: { "host-only": hostFilled("host-only") } }, account);
  assert.deepEqual(Object.keys(models), ["friendly"]);
  assert.equal(models.friendly.api.id, "gpt-future");
  assert.equal(models[Symbol.for("magpie.fellBack")], undefined);
});

test("a successful empty catalog stays empty even with manual models, and skips metadata requests", async () => {
  const load = catalog([], { explicit: () => ({ models: { manual: {} } }),
    site: { request: async () => assert.fail("an empty account list needs no public pricing") },
    loadRegistry: async () => assert.fail("an empty account list needs no registry") });
  assert.deepEqual(await load({}, account), {});
});

test("before-login preview remains separate from a balance-only account", async () => {
  const load = catalog([], { fetchImpl: async () => assert.fail("preview and keyless accounts must not reach upstream") });
  const preview = await load({}, null);
  assert.equal(Object.keys(preview).length, DECLARED_MODEL_IDS.length);
  assert.equal(preview["gpt-6.1-sol"].api.npm, "@ai-sdk/openai");
  assert.deepEqual(await load({}, { ...account, hasModelKey: false, key: "" }), {});
});

test("temporary discovery failure returns translated plugin declarations, not arbitrary host defaults", async () => {
  const load = catalog([], { fetchImpl: async () => { throw new Error("offline"); }, explicit: () => ({ models: { manual: { provider: { npm: "@ai-sdk/openai-compatible" } } } }) });
  const models = await load({ models: { "gpt-6.1-sol": hostFilled("gpt-6.1-sol"), "host-only": hostFilled("host-only") } }, account);
  assert.equal(models["gpt-6.1-sol"].api.npm, "@ai-sdk/openai");
  assert.equal(models["claude-opus-4-6"].api.npm, "@ai-sdk/anthropic");
  assert.equal(models.manual.api.npm, "@ai-sdk/openai-compatible");
  assert.equal(models["host-only"], undefined);
  assert.equal(models[Symbol.for("magpie.fellBack")], true);
});

test("HTML WAF 401 and client rejection do not mark a model key expired", async () => {
  const waf = catalog([], { fetchImpl: async () => new Response("<html>verify</html>", { status: 401, headers: { "content-type": "text/html" } }) });
  assert.equal((await waf({}, account))[Symbol.for("magpie.fellBack")], true);
  const client = catalog([], { fetchImpl: async () => Response.json({ error: { message: "unauthorized client detected" } }, { status: 401 }) });
  await assert.rejects(client({}, account), { signIn: "kept" });
});

test("an explicit foreign model origin is rejected before credential-bearing model discovery", async () => {
  let requests = 0;
  const load = catalog([], { explicit: () => ({ api: "https://untrusted.example/v1" }),
    fetchImpl: async () => { requests++; return Response.json({ data: [] }); } });
  await assert.rejects(load({}, { ...account, apiBase: "" }), /受信任/);
  assert.equal(requests, 0);
});

test("config hooks do not reinterpret their own defaults as explicit user overrides", async () => {
  const hooks = await createProvider({}, {}, { fetchImpl: async () => Response.json({ data: [{ id: "gpt-future" }] }),
    loadRegistry: async () => ({}) });
  const cfg = {};
  await hooks.config(cfg); await hooks.config(cfg);
  const models = await hooks.provider.models({ models: { "gpt-future": hostFilled("gpt-future") } }, { auth: { type: "api", key: "sk-synthetic" } });
  assert.equal(models["gpt-future"].api.npm, "@ai-sdk/openai");
});

test("model listing cancellation aborts an in-flight registry fetch and returns promptly", { timeout: 3000 }, async () => {
  const entered = gate();
  let registrySignal;
  const registry = createModelRegistry({ paths: [], timeoutMs: 2000, fetchImpl: async (_url, init) => {
    registrySignal = init.signal; entered.resolve();
    return new Promise((_, reject) => init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true }));
  } });
  const load = catalog([{ id: "gpt-future" }], { loadRegistry: registry });
  const controller = new AbortController();
  const pending = load({}, account, { signal: controller.signal });
  await entered.promise;
  const rejected = assert.rejects(pending, { name: "AbortError" });
  controller.abort();
  assert.equal(registrySignal.aborted, true, "the caller signal must reach the metadata fetch");
  await rejected;
});
