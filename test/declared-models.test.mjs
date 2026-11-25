import assert from "node:assert/strict";
import test from "node:test";
import { DECLARED_MODEL_IDS, MODEL_SHAPE, declaredModels } from "../lib/declared-models.mjs";

const RESPONSES_MODELS = ["gemini-2.5-pro", "gpt-5-codex", "gpt-6-astra", "gpt-6.1-sol"];
const CLAUDE_IDS = DECLARED_MODEL_IDS.filter(id => id.startsWith("claude-"));

test("declaredModels returns the 16 default-group models with complete model shapes", () => {
  const models = declaredModels();
  assert.equal(Object.keys(models).length, 16);
  assert.deepEqual(Object.keys(models).sort(), [...DECLARED_MODEL_IDS].sort());

  for (const id of DECLARED_MODEL_IDS) {
    const model = models[id];
    assert.equal(typeof model.name, "string", `${id}: name`);
    assert.ok(model.name.length > 0, `${id}: non-empty name`);
    assert.ok(Number.isInteger(model.limit.context) && model.limit.context > 0, `${id}: context`);
    assert.ok(Number.isInteger(model.limit.output) && model.limit.output > 0, `${id}: output`);
    assert.equal(typeof model.capabilities.reasoning, "boolean", `${id}: reasoning`);
    assert.equal(typeof model.capabilities.toolcall, "boolean", `${id}: toolcall`);
    assert.equal(typeof model.capabilities.attachment, "boolean", `${id}: attachment`);
    assert.equal(model.capabilities.input.text, true, `${id}: text input`);
    assert.equal(typeof model.capabilities.input.image, "boolean", `${id}: image input`);
  }
});

test("GPT/Gemini entries use the Responses API; Claude and cc-format inherit Anthropic", () => {
  const models = declaredModels();

  for (const id of RESPONSES_MODELS) {
    assert.deepEqual(models[id].api, {
      npm: "@ai-sdk/openai",
      url: "https://anyrouter.top/v1",
    }, `${id}: Responses API override`);
  }

  for (const id of CLAUDE_IDS) {
    assert.equal(Object.hasOwn(models[id], "api"), false, `${id}: must inherit provider Anthropic API`);
  }

  assert.equal(Object.hasOwn(models["gpt-6-astra-cc-format"], "api"), false,
    "gpt-6-astra-cc-format speaks Anthropic Messages and must inherit the provider API");
  assert.ok(models["gpt-6-astra-cc-format"].name.includes("CC"), "cc-format display name is distinct");
});

test("declaredModels returns fresh top-level and nested limit/capability objects each call", () => {
  const first = declaredModels();
  assert.notEqual(first, declaredModels(), "top-level object must be new");
  assert.notEqual(first["claude-opus-4-6"].limit, declaredModels()["claude-opus-4-6"].limit,
    "limit object must be new");

  first["claude-opus-4-6"].limit.context = 1;
  first["claude-opus-4-6"].capabilities.reasoning = false;
  delete first["claude-opus-4-6"];

  const fresh = declaredModels();
  assert.equal(fresh["claude-opus-4-6"].limit.context, 500_000);
  assert.equal(fresh["claude-opus-4-6"].capabilities.reasoning, true);
  assert.equal(MODEL_SHAPE.limit.context, 200_000, "shared shape constants are not mutated");
  assert.equal(MODEL_SHAPE.limit.output, 32_000);
  assert.equal(MODEL_SHAPE.capabilities.reasoning, true);
});

test("declaredModels keeps per-model api objects independent across calls", () => {
  const first = declaredModels();
  const baseline = declaredModels()["gpt-6-astra"].api.npm;

  first["gpt-6-astra"].api.npm = "mutated-by-test";

  assert.equal(declaredModels()["gpt-6-astra"].api.npm, baseline,
    "mutating one model's api must not leak into a later declaredModels() call");
  assert.notEqual(first["gpt-6-astra"].api, first["gpt-5-codex"].api,
    "each Responses model should own its api object");
});
