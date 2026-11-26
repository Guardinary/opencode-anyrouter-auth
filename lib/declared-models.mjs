// Models AnyRouter advertises publicly (GET /api/pricing, 2026-11-22) that are
// available to the default group. These are a display/fallback list only: the
// account's own GET /v1/models answer always wins, and a public price row does
// not grant access to an account.
//
// Default model protocols (native Gemini verified 2026-11-26):
//   - Anthropic Messages for claude-* and *-cc-format
//   - OpenAI Responses for gpt-*/codex
//   - Google generateContent/streamGenerateContent for gemini-*; upstream
//     availability remains independent of correct protocol selection.
export const MODEL_SHAPE = {
  limit: { context: 200_000, output: 32_000 },
  capabilities: {
    reasoning: true,
    toolcall: true,
    attachment: true,
    input: { text: true, image: true },
    output: { text: true },
  },
};

const RESPONSES = { npm: "@ai-sdk/openai", url: "https://anyrouter.top/v1" };
const GEMINI = { npm: "@ai-sdk/google", url: "https://anyrouter.top/v1beta" };

const MODELS = {
  "claude-3-5-haiku-20241022": {
    name: "Claude 3.5 Haiku",
    limit: { context: 200_000, output: 8_192 },
    capabilities: { reasoning: false, toolcall: true, attachment: true, input: { text: true, image: true } },
  },
  "claude-3-5-sonnet-20241022": {
    name: "Claude 3.5 Sonnet",
    limit: { context: 200_000, output: 8_192 },
    capabilities: { reasoning: false, toolcall: true, attachment: true, input: { text: true, image: true } },
  },
  "claude-3-7-sonnet-20250219": {
    name: "Claude 3.7 Sonnet",
    limit: { context: 200_000, output: 64_000 },
  },
  "claude-fable-5-2": {
    name: "Claude Fable 5.2",
    limit: { context: 1_000_000, output: 64_000 },
  },
  "claude-opus-4-1-20250805": {
    name: "Claude Opus 4.1",
    limit: { context: 200_000, output: 32_000 },
  },
  "claude-opus-4-20250514": {
    name: "Claude Opus 4",
    limit: { context: 200_000, output: 32_000 },
  },
  "claude-opus-4-5-20251101": {
    name: "Claude Opus 4.5",
    limit: { context: 500_000, output: 32_000 },
  },
  "claude-opus-4-6": {
    name: "Claude Opus 4.6",
    limit: { context: 500_000, output: 32_000 },
  },
  "claude-opus-4-7": {
    name: "Claude Opus 4.7",
    limit: { context: 500_000, output: 32_000 },
  },
  "claude-sonnet-4-20250514": {
    name: "Claude Sonnet 4",
    limit: { context: 500_000, output: 32_000 },
  },
  "claude-sonnet-4-5-20250929": {
    name: "Claude Sonnet 4.5",
    limit: { context: 500_000, output: 32_000 },
  },
  // Publicly listed is not guaranteed available: the native 2.5 route still
  // answered 404 in the 2026-11-26 probe. Preserve that upstream error, not a
  // fabricated successful result or an automatic alternate-protocol retry.
  "gemini-2.5-pro": {
    name: "Gemini 2.5 Pro",
    api: GEMINI,
    limit: { context: 1_000_000, output: 65_536 },
  },
  // Maker registry limits observed locally on 2026-11-26; the account's live
  // list remains authoritative and relay availability is not implied.
  "gemini-4-carbon": {
    name: "Gemini 4 Carbon",
    api: GEMINI,
    limit: { context: 1_048_576, output: 32_768 },
  },
  "gemini-4-neon": {
    name: "Gemini 4 Neon",
    api: GEMINI,
    limit: { context: 1_048_576, output: 65_536 },
  },
  "gpt-5-codex": {
    name: "GPT-5 Codex",
    api: RESPONSES,
    limit: { context: 400_000, output: 128_000 },
  },
  "gpt-6-astra": {
    name: "GPT-6 Astra",
    api: RESPONSES,
    limit: { context: 1_000_000, output: 64_000 },
  },
  "gpt-6-astra-cc-format": {
    name: "GPT-6 Astra (CC Format)",
    limit: { context: 1_000_000, output: 64_000 },
  },
  "gpt-6.1-sol": {
    name: "GPT-6.1 Sol",
    api: RESPONSES,
    limit: { context: 1_000_000, output: 64_000 },
  },
};

export function declaredModels() {
  const out = {};
  for (const [id, model] of Object.entries(MODELS)) {
    out[id] = {
      ...model,
      ...(model.api ? { api: { ...model.api } } : {}),
      limit: { ...MODEL_SHAPE.limit, ...model.limit },
      capabilities: {
        ...MODEL_SHAPE.capabilities,
        ...(model.capabilities ?? {}),
        input: { ...MODEL_SHAPE.capabilities.input, ...(model.capabilities?.input ?? {}) },
        output: { ...MODEL_SHAPE.capabilities.output, ...(model.capabilities?.output ?? {}) },
      },
    };
  }
  return out;
}

// Configuration and runtime model objects have different schemas in magpie.
// Do not feed a runtime api/capabilities object into config(): the host ignores it.
export function declaredConfigModels() {
  const out = {};
  for (const [id, model] of Object.entries(declaredModels())) {
    const cap = model.capabilities;
    out[id] = {
      name: model.name,
      provider: { npm: model.api?.npm ?? "@ai-sdk/anthropic", api: model.api?.url ?? "https://anyrouter.top/v1" },
      limit: { ...model.limit }, reasoning: cap.reasoning, attachment: cap.attachment,
      tool_call: cap.toolcall,
      modalities: { input: Object.keys(cap.input).filter(k => cap.input[k]), output: ["text"] },
    };
  }
  return out;
}

export const DECLARED_MODEL_IDS = Object.freeze(Object.keys(MODELS));
