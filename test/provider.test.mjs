import assert from "node:assert/strict";
import test from "node:test";
import plugin from "../index.mjs";
import { createProvider } from "../lib/provider.mjs";
import { PLACEHOLDER_KEY, readAccount, saveAccount } from "../lib/accounts.mjs";
import { DECLARED_MODEL_IDS } from "../lib/declared-models.mjs";

const json = (data, headers = {}) => new Response(JSON.stringify({ success: true, data }), {
  headers: { "content-type": "application/json", ...headers }
});
const rawJson = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), {
  status,
  headers: { "content-type": "application/json", ...headers }
});
const status = (extra = {}) => json({ turnstile_check: false, quota_per_unit: 500000, ...extra });
const key = { id: 7, status: 1, key: "found-model-key", expired_time: -1, unlimited_quota: true };

const account = (extra = {}) => ({
  mode: "session",
  site: "top",
  siteURL: "https://anyrouter.top",
  apiBase: "https://anyrouter.top/v1",
  key: "model-key",
  keyId: "",
  userId: "123",
  username: "alice",
  password: "",
  session: "session=site; acw_tc=waf",
  accessToken: "",
  headers: "",
  checkinEnabled: false,
  loginGeneration: "synthetic-stable-login",
  ...extra
});
const stored = extra => saveAccount(account(extra));
const asAuth = ({ type, ...rest }) => ({ type: "oauth", ...rest });

function harness(steps) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), init });
    const next = steps.shift();
    assert.ok(next, `unexpected extra request: ${new URL(String(url)).pathname}`);
    return typeof next === "function" ? next(url, init) : next;
  };
  return { calls, fetchImpl };
}

// magpie finishes every oauth sign-in through callback(): methods 0 and 4 use
// method "auto" (the host calls callback() itself), methods 1-3 use "code"
// (the user pastes the site session). start() drives that path.
const start = async (hooks, index, inputs = {}) => {
  const flow = await hooks.auth.methods[index].authorize(inputs);
  assert.equal(typeof flow.callback, "function", `method ${index} must provide callback()`);
  return flow.callback();
};

test("six login methods: five oauth site sign-ins and one native API key", async () => {
  const hooks = await createProvider();
  assert.equal(hooks.auth.provider, "anyrouter");
  assert.ok(hooks.auth.icon.startsWith("data:image/png;base64,"));
  // magpie 0.1.4667 finishes an oauth sign-in only through callback(), so all
  // five site sign-ins are oauth; only the host-owned API-key input is "api".
  assert.deepEqual(hooks.auth.methods.map(method => method.type), ["oauth", "oauth", "oauth", "oauth", "oauth", "api"]);
  assert.deepEqual(hooks.auth.methods.map(method => method.keyless), [undefined, undefined, undefined, undefined, undefined, undefined]);

  for (const index of [0, 1, 2, 3, 4]) {
    const method = hooks.auth.methods[index];
    assert.equal(typeof method.authorize, "function", `${method.label} must authorize itself`);
    assert.ok(method.prompts.some(prompt => prompt.key === "modelKey"), `${method.label} offers an optional model key`);
    assert.ok(method.prompts.some(prompt => prompt.key === "keyId"), `${method.label} offers explicit existing-Key selection`);
    assert.ok(!method.prompts.some(prompt => ["apiEndpoint", "site", "advanced"].includes(prompt.key)));
  }

  // Method 5 is the host-owned API-key input: api, no authorize, no callback.
  const api = hooks.auth.methods[5];
  assert.equal(api.type, "api");
  assert.equal(api.authorize, undefined);
  assert.deepEqual(api.prompts.map(prompt => prompt.key), ["email", "headers"]);

  const [password, , , , token] = hooks.auth.methods;
  assert.deepEqual(password.prompts.map(prompt => prompt.key), ["username", "password", "savePassword", "modelKey", "keyId", "headers"]);
  assert.equal(password.prompts.find(prompt => prompt.key === "password").type, "password");
  assert.equal(password.prompts.find(prompt => prompt.key === "savePassword").type, "select");
  assert.deepEqual(password.prompts.find(prompt => prompt.key === "savePassword").options.map(option => option.value), ["no", "yes"]);
  assert.deepEqual(token.prompts.map(prompt => prompt.key), ["accessToken", "userId", "modelKey", "keyId", "headers"]);
  assert.equal(token.prompts.find(prompt => prompt.key === "accessToken").type, "password");
  assert.equal(token.prompts.find(prompt => prompt.key === "userId").validate("0"), "请输入纯数字用户 ID。");
  assert.equal(token.prompts.find(prompt => prompt.key === "userId").validate("123"), undefined);
  for (const method of hooks.auth.methods) {
    assert.equal(method.prompts.find(prompt => prompt.key === "headers").type, "text");
  }
  const modelKey = password.prompts.find(prompt => prompt.key === "modelKey");
  assert.match(modelKey.message, /可选/);
  assert.equal(modelKey.validate(""), undefined);
  assert.equal(modelKey.validate("sk-key"), undefined);
  assert.match(modelKey.validate("sk key with space"), /空白/);
});

test("password and access-token hand off with method 'auto'; GitHub/LinuxDO/session need a pasted code", async () => {
  const hooks = await createProvider();
  // 0 password and 4 access-token do their work in callback() with no code.
  for (const index of [0, 4]) {
    const flow = await hooks.auth.methods[index].authorize({ username: "a", password: "b", accessToken: "t", userId: "1" });
    assert.equal(flow.method, "auto", `method ${index} needs no user-pasted code`);
    assert.equal(flow.url, "", `method ${index} opens no page; its callback does the work`);
    assert.equal(typeof flow.callback, "function");
    assert.match(flow.instructions, /正在|登录/, `method ${index} explains what it is doing`);
  }
  // 1-3 hand off to the browser and finish from a pasted /api/user/self cURL.
  for (const index of [1, 2, 3]) {
    const flow = await hooks.auth.methods[index].authorize({});
    assert.equal(flow.method, "code", `method ${index} finishes through the pasted handoff`);
    assert.equal(flow.url, "https://anyrouter.top/login");
    assert.equal(typeof flow.callback, "function");
    assert.match(flow.instructions, /api\/user\/self/, `method ${index} asks for the session cURL`);
  }
});

test("provider defaults to the AnyRouter Anthropic base with 16 declared models and no fcapp endpoint", async () => {
  const hooks = await createProvider();
  const cfg = {};
  await hooks.config(cfg);
  const provider = cfg.provider.anyrouter;
  assert.equal(provider.name, "AnyRouter");
  assert.equal(provider.npm, "@ai-sdk/anthropic");
  assert.equal(provider.api, "https://anyrouter.top/v1");
  assert.equal(Object.keys(provider.models).length, 16);
  assert.deepEqual(Object.keys(provider.models), DECLARED_MODEL_IDS);
  assert.equal(provider.models["claude-opus-4-6"].api, undefined, "Claude inherits the provider's Anthropic SDK");
  assert.equal(provider.models["gpt-6-astra-cc-format"].api, undefined, "cc-format speaks Anthropic Messages");
  assert.deepEqual(provider.models["gpt-5-codex"].provider, { npm: "@ai-sdk/openai", api: "https://anyrouter.top/v1" });
  assert.deepEqual(provider.models["gemini-2.5-pro"].provider, { npm: "@ai-sdk/google", api: "https://anyrouter.top/v1beta" });
  assert.deepEqual(provider.models["claude-opus-4-6"].provider, { npm: "@ai-sdk/anthropic", api: "https://anyrouter.top/v1" });
  assert.equal(provider.models["gpt-5-codex"].api, undefined, "config must not contain runtime API objects");
  assert.equal(provider.models["gpt-5-codex"].capabilities, undefined, "config must use top-level capabilities/modalities");
});

test("an existing provider configuration is preserved, not overwritten", async () => {
  const hooks = await createProvider();
  const existing = { name: "Mine", npm: "@ai-sdk/openai-compatible", api: "https://custom.example/v1", models: { custom: { id: "remote" } } };
  const cfg = { provider: { anyrouter: existing, other: { name: "Other" } } };
  await hooks.config(cfg);
  assert.equal(cfg.provider.anyrouter, existing);
  assert.deepEqual(Object.keys(cfg.provider).sort(), ["anyrouter", "other"]);
});

test("the plugin exposes the six provider options and no legacy retry filter switch", async () => {
  const hooks = await createProvider();
  assert.deepEqual(hooks.auth.options.map(option => option.key), [
    "send-codex-headers",
    "claude-code-compat",
    "portable-responses",
    "text-filter",
    "codex-session-repair",
    "request-diagnostics"
  ]);
  assert.equal(hooks.auth.options.find(option => option.key === "codex-session-repair").default, false);
  assert.equal(hooks.auth.options.find(option => option.key === "codex-session-repair").confirm !== undefined, true);
  assert.equal(hooks.auth.options.some(option => option.key === "conditional-history-filter"), false);
});

test("password login reads status, logs in and verifies the profile before saving", async () => {
  const h = harness([
    status({}, { "set-cookie": "acw_tc=waf-pass; Path=/" }),
    json({ id: 123, username: "alice" }, { "set-cookie": "session=signed-in; HttpOnly" }),
    json({ id: 123, username: "alice", email: "alice@example.test" }),
    json({ items: [], total: 0 })
  ]);
  const hooks = await createProvider({}, {}, { fetchImpl: h.fetchImpl });
  const result = await start(hooks, 0, { username: "alice", password: "site-secret", savePassword: "no", modelKey: "" });
  assert.equal(result.type, "success", result.error);
  const saved = readAccount(asAuth(result));
  assert.equal(saved.mode, "password");
  assert.equal(saved.userId, "123");
  assert.equal(saved.email, "alice@example.test");
  assert.equal(saved.checkinEnabled, false);
  assert.equal(saved.password, "");
  assert.equal(saved.key, "", "no model key is not a login failure");
  assert.equal(saved.hasModelKey, false);
  assert.equal(result.access, PLACEHOLDER_KEY);
  assert.equal(result.uid, "anyrouter:123");
  assert.equal(result.accountId, "alice@example.test");
  assert.deepEqual(h.calls.map(call => new URL(call.url).pathname), ["/api/status", "/api/user/login", "/api/user/self", "/api/token/"]);
  assert.equal(h.calls[1].init.headers.has("authorization"), false);
  assert.ok(h.calls.every(call => new URL(call.url).origin === "https://anyrouter.top"));
});

test("a provided model key is stored directly; an existing site key is read when omitted", async () => {
  const explicit = harness([
    status(),
    json({ id: 123, username: "alice" }, { "set-cookie": "session=signed-in" }),
    json({ id: 123, username: "alice", email: "alice@example.test" })
  ]);
  const hooks = await createProvider({}, {}, { fetchImpl: explicit.fetchImpl });
  const result = await start(hooks, 0, { username: "alice", password: "site-secret", savePassword: "no", modelKey: "typed-model-key" });
  assert.equal(result.type, "success", result.error);
  assert.equal(result.access, "typed-model-key");
  assert.equal(readAccount(asAuth(result)).hasModelKey, true);
  assert.deepEqual(explicit.calls.map(call => new URL(call.url).pathname), ["/api/status", "/api/user/login", "/api/user/self"]);

  const discovered = harness([
    status(),
    json({ id: 123, username: "alice" }, { "set-cookie": "session=signed-in" }),
    json({ id: 123, username: "alice" }),
    json({ items: [key], total: 1 })
  ]);
  const hooks2 = await createProvider({}, {}, { fetchImpl: discovered.fetchImpl });
  const found = await start(hooks2, 0, { username: "alice", password: "site-secret", savePassword: "no" });
  assert.equal(found.type, "success", found.error);
  assert.equal(found.access, "sk-found-model-key");
  assert.equal(readAccount(asAuth(found)).keyId, "7");
  assert.equal(discovered.calls.at(-1).url, "https://anyrouter.top/api/token/?p=0&size=100");
});

test("password login persists the password only when check-in is explicitly enabled", async () => {
  for (const savePassword of ["no", "yes"]) {
    const h = harness([
      status(),
      json({ id: 123, username: "alice" }, { "set-cookie": "session=signed-in" }),
      json({ id: 123, username: "alice" }),
      json({ items: [key], total: 1 })
    ]);
    const hooks = await createProvider({}, {}, { fetchImpl: h.fetchImpl });
    const result = await start(hooks, 0, { username: "alice", password: "site-secret", savePassword });
    assert.equal(result.type, "success", result.error);
    const saved = readAccount(asAuth(result));
    assert.equal(saved.checkinEnabled, savePassword === "yes");
    assert.equal(saved.password, savePassword === "yes" ? "site-secret" : "");
  }
});

test("Turnstile blocks password login without sending credentials", async () => {
  const h = harness([status({ turnstile_check: true, turnstile_site_key: "site-key" })]);
  const hooks = await createProvider({}, {}, { fetchImpl: h.fetchImpl });
  const result = await start(hooks, 0, { username: "alice", password: "site-secret" });
  assert.equal(result.type, "failed");
  assert.match(result.error, /Turnstile/);
  assert.equal(h.calls.length, 1);
  assert.equal(new URL(h.calls[0].url).pathname, "/api/status");
});

test("access-token login is read-only, verifies the UID and never opts into check-in", async () => {
  const h = harness([
    json({ id: 123, username: "alice", email: "alice@example.test" }),
    json({ items: [key], total: 1 })
  ]);
  const hooks = await createProvider({}, {}, { fetchImpl: h.fetchImpl });
  const result = await start(hooks, 4, { accessToken: "system-token", userId: "123", savePassword: "yes" });
  assert.equal(result.type, "success", result.error);
  const saved = readAccount(asAuth(result));
  assert.equal(saved.mode, "access-token");
  assert.equal(saved.checkinEnabled, false);
  assert.equal(saved.accessToken, "system-token");
  assert.equal(saved.key, "sk-found-model-key");
  assert.ok(h.calls.every(call => call.init.method === "GET"));
  assert.equal(h.calls[0].init.headers.get("authorization"), "system-token");
  assert.equal(h.calls[0].init.headers.get("new-api-user"), "123");
});

test("GitHub, LinuxDO and browser-session handoffs import a session instead of replaying an OAuth code", async t => {
  for (const index of [1, 2, 3]) {
    await t.test(String(index), async () => {
      const h = harness([
        json({ id: 123, username: "alice", email: "alice@example.test" }),
        json({ items: [key], total: 1 })
      ]);
      const hooks = await createProvider({}, {}, { fetchImpl: h.fetchImpl });
      const flow = await hooks.auth.methods[index].authorize({});
      assert.equal(flow.url, "https://anyrouter.top/login");
      assert.equal(flow.method, "code");
      assert.equal(h.calls.length, 0);
      const result = await flow.callback('{"cookie":"session=site-only; acw_tc=waf","userId":"123"}');
      assert.equal(result.type, "success", result.error);
      const saved = readAccount(asAuth(result));
      assert.equal(saved.mode, ["github", "linuxdo", "session"][index - 1]);
      assert.equal(saved.checkinEnabled, true);
      assert.equal(saved.key, "sk-found-model-key");
      assert.deepEqual(saved.session.split("; ").sort(), ["session=site-only", "acw_tc=waf"].sort(), "persisted jars may canonicalize distinct-name cookie order");
      assert.equal(saved.password, "");
      assert.deepEqual(h.calls.map(call => new URL(call.url).pathname), ["/api/user/self", "/api/token/"]);
      const reused = await flow.callback('{"cookie":"session=site-only","userId":"123"}');
      assert.equal(reused.type, "failed");
    });
  }
});

test("a wrong or unavailable profile fails closed before key lookup or persistence", async t => {
  for (const failure of ["wrong-user", "unavailable"]) {
    await t.test(failure, async () => {
      const h = harness([
        status(),
        json({ id: 123, username: "alice" }, { "set-cookie": "session=verified" }),
        failure === "wrong-user"
          ? json({ id: 456, username: "bob", email: "other@example.test" })
          : new Response("Unavailable", { status: 503 })
      ]);
      const hooks = await createProvider({}, {}, { fetchImpl: h.fetchImpl });
      const result = await start(hooks, 0, { username: "alice", password: "site-secret" });
      assert.equal(result.type, "failed");
      assert.equal(result.access, undefined);
      assert.equal(result.refresh, undefined);
      assert.deepEqual(h.calls.map(call => new URL(call.url).pathname), ["/api/status", "/api/user/login", "/api/user/self"]);
      assert.doesNotMatch(result.error, /site-secret|session=verified|other@example/);
    });
  }
});

test("the API-key method never calls the site", async () => {
  const hooks = await createProvider({}, {}, {
    fetchImpl: () => { throw new Error("the API-key method must not call the site"); }
  });
  assert.equal(hooks.auth.methods[5].authorize, undefined);
  assert.equal((await hooks.auth.checkin(async () => ({ type: "api", key: "sk-model" }), {})).outcome, "ineligible");
});

test("loader rejects a site-only account locally with 400 anyrouter_missing_api_key", async () => {
  const auth = stored({ key: "", session: "session=site" });
  let upstream = 0;
  const hooks = await createProvider({}, {}, { fetchImpl: async () => { upstream++; return Response.json({}); } });
  const loaded = await hooks.auth.loader(async () => auth, { models: {} });
  assert.equal(loaded.apiKey, PLACEHOLDER_KEY);
  const response = await loaded.fetch("https://anyrouter.top/v1/messages", { method: "POST", body: "{}" });
  assert.equal(response.status, 400);
  const body = await response.json();
  assert.equal(body.error.code, "anyrouter_missing_api_key");
  assert.match(body.error.message, /模型 API Key/);
  assert.equal(upstream, 0);
});

test("loader blocks a request whose account changed mid-flight with 409 anyrouter_account_changed", async () => {
  let auth = stored();
  let upstream = 0;
  const hooks = await createProvider({}, {}, {
    fetchImpl: async () => { upstream++; return Response.json({ ok: true }); }
  });
  const loaded = await hooks.auth.loader(async () => auth, { models: {} });
  auth = stored({ userId: "456", username: "bob", key: "other-key" });
  const response = await loaded.fetch("https://anyrouter.top/v1/messages", { method: "POST", body: "{}" });
  assert.equal(response.status, 409);
  assert.equal((await response.json()).error.code, "anyrouter_account_changed");
  assert.equal(upstream, 0);
});

test("loader sends the model key per protocol and never forwards site credentials", async () => {
  for (const [protocol, url, expected] of [
    ["anthropic", "https://anyrouter.top/v1/messages", { authorization: "Bearer model-key" }],
    ["responses", "https://anyrouter.top/v1/responses", { authorization: "Bearer model-key" }],
    ["chat", "https://anyrouter.top/v1/chat/completions", { authorization: "Bearer model-key" }]
  ]) {
    const calls = [];
    const hooks = await createProvider({ magpie: { option: () => false } }, {}, {
      fetchImpl: async (target, init) => {
        calls.push({ target, init });
        return Response.json({ ok: true });
      }
    });
    const loaded = await hooks.auth.loader(async () => stored(), { models: {} });
    await loaded.fetch(url, {
      method: "POST",
      body: JSON.stringify({ model: "gpt-5-codex", input: "hello" }),
      headers: { cookie: "session=never", "new-api-user": "123", "x-account": "kept" }
    });
    assert.equal(calls.length, 1);
    const headers = calls[0].init.headers;
    for (const [name, value] of Object.entries(expected)) assert.equal(headers.get(name), value, protocol);
    assert.equal(headers.get("cookie"), null, protocol);
    assert.equal(headers.get("new-api-user"), null, protocol);
    assert.equal(headers.get("x-account"), "kept", protocol);
  }
});

test("loader blocks unknown Gemini actions before transmitting any key", async () => {
  let calls = 0;
  const hooks = await createProvider({}, {}, { fetchImpl: async () => { calls++; return Response.json({}); } });
  const auth = stored();
  const loaded = await hooks.auth.loader(async () => auth);
  const result = await loaded.fetch("https://anyrouter.top/v1beta/models/gemini-2.5-pro:delete", { method: "POST", body: "{}" });
  assert.equal(result.status, 400);
  assert.equal((await result.json()).error.code, "anyrouter_untrusted_destination");
  assert.equal(calls, 0);
});

test("loader maps a model's declared Responses base and adds beta only when Claude compatibility is enabled", async () => {
  const calls = [];
  const hooks = await createProvider({ magpie: { option: (_provider, key) => key === "claude-code-compat" } }, {}, {
    fetchImpl: async (target, init) => { calls.push({ target: String(target), init }); return Response.json({ ok: true }); }
  });
  const provider = {
    models: {
      claude: { api: { id: "claude-opus-4-6", url: "https://anyrouter.top/v1", npm: "@ai-sdk/anthropic" } },
      gpt: { api: { id: "gpt-5-codex", url: "https://anyrouter.top/v1", npm: "@ai-sdk/openai" } }
    }
  };
  const loaded = await hooks.auth.loader(async () => stored(), provider);
  await loaded.fetch("https://anyrouter.top/v1/messages", {
    method: "POST",
    body: JSON.stringify({ model: "claude-opus-4-6", max_tokens: 16 }),
    headers: { "x-anyrouter-account-model": "claude" }
  });
  assert.equal(calls[0].target, "https://anyrouter.top/v1/messages?beta=true");
  await loaded.fetch("https://anyrouter.top/v1/responses", {
    method: "POST",
    body: JSON.stringify({ model: "gpt-5-codex", input: "hi" }),
    headers: { "x-anyrouter-account-model": "gpt" }
  });
  assert.equal(calls[1].target, "https://anyrouter.top/v1/responses");
});

test("loader performs exactly one upstream fetch and never retries internally", async () => {
  let upstream = 0;
  const hooks = await createProvider({ magpie: { option: () => false } }, {}, {
    fetchImpl: async () => { upstream++; return rawJson({ error: { code: "server_error", message: "busy" } }, 500); }
  });
  const loaded = await hooks.auth.loader(async () => stored(), { models: {} });
  const response = await loaded.fetch("https://anyrouter.top/v1/messages", { method: "POST", body: "{}" });
  assert.equal(response.status, 500);
  assert.equal(upstream, 1, "no internal retry: one host fetch is one upstream fetch");
});

test("request diagnostics can be switched off and pass the upstream answer through", async () => {
  const answer = rawJson({ error: { code: "rate_limit_exceeded", message: "slow down" } }, 429, { "retry-after": "7" });
  const hooks = await createProvider({ magpie: { option: (provider, key) => key !== "request-diagnostics" } }, {}, {
    fetchImpl: async () => answer.clone()
  });
  const loaded = await hooks.auth.loader(async () => stored(), { models: {} });
  const response = await loaded.fetch("https://anyrouter.top/v1/messages", { method: "POST", body: "{}" });
  assert.equal(response.status, 429);
  assert.equal(response.headers.get("retry-after"), "7");
});

test("chat.headers adds the model hint and a Claude session id only for Anthropic models", async () => {
  const hooks = await createProvider();
  const output = { headers: {} };
  await hooks["chat.headers"]({ model: { id: "claude-opus-4-6", providerID: "anyrouter", api: { npm: "@ai-sdk/anthropic" } }, sessionID: "s1" }, output);
  assert.equal(output.headers["x-anyrouter-account-model"], "claude-opus-4-6");
  assert.equal(output.headers["x-session-id"], "s1");
  assert.equal(output.headers["x-claude-code-session-id"], "s1");

  const other = { headers: {} };
  await hooks["chat.headers"]({ model: { id: "gpt-5-codex", providerID: "anyrouter", api: { npm: "@ai-sdk/openai" } }, sessionID: "s2" }, other);
  assert.equal(other.headers["x-session-id"], "s2");
  assert.equal(other.headers["x-claude-code-session-id"], undefined);

  const foreign = { headers: {} };
  await hooks["chat.headers"]({ model: { id: "x", providerID: "other" } }, foreign);
  assert.deepEqual(foreign.headers, {});
});

test("the published plugin entry builds the same provider without an internal retry filter", async () => {
  const hooks = await plugin.server({ magpie: { option: () => true } }, {});
  assert.equal(hooks.auth.provider, "anyrouter");
  assert.equal(hooks.auth.methods.length, 6);
  assert.deepEqual(hooks.auth.options.map(option => option.key), [
    "send-codex-headers",
    "claude-code-compat",
    "portable-responses",
    "text-filter",
    "codex-session-repair",
    "request-diagnostics"
  ]);
  let upstream = 0;
  const loaded = await hooks.auth.loader(async () => stored(), { models: {} });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { upstream++; return rawJson({ error: { code: "server_error" } }, 503); };
  try {
    const response = await loaded.fetch("https://anyrouter.top/v1/messages", { method: "POST", body: "{}" });
    assert.equal(response.status, 503);
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(upstream, 1, "the entry must not install a retrying fetch wrapper");
});

test("send-codex-headers controls the Codex client identity and body adaptation", async () => {
  const body = { model: "gpt-5-codex", input: [{ type: "message", id: "msg_1", role: "user", content: "hi" }] };
  const run = async enabled => {
    const calls = [];
    const hooks = await createProvider({ magpie: { option: (provider, key) => key !== "send-codex-headers" || enabled } }, {}, {
      fetchImpl: async (target, init) => { calls.push({ target, init }); return Response.json({ ok: true }); }
    });
    const loaded = await hooks.auth.loader(async () => stored(), { models: {} });
    await loaded.fetch("https://anyrouter.top/v1/responses", {
      method: "POST",
      body: JSON.stringify(body),
      headers: { "x-session-id": "sess-1" }
    });
    return calls[0];
  };

  const on = await run(true);
  assert.match(on.init.headers.get("user-agent"), /^codex_exec\//);
  assert.equal(on.init.headers.get("originator"), "codex_exec");
  assert.equal(on.init.headers.get("x-openai-internal-codex-responses-lite"), "true");
  assert.equal(on.init.headers.get("session-id"), "sess-1");
  assert.equal(on.init.headers.get("thread-id"), "sess-1");
  const onBody = JSON.parse(on.init.body);
  assert.equal(onBody.store, false);
  assert.ok(onBody.client_metadata.session_id);
  assert.equal(onBody.prompt_cache_key, "sess-1");

  const off = await run(false);
  assert.equal(off.init.headers.get("user-agent"), null);
  assert.equal(off.init.headers.get("originator"), null);
  assert.equal(off.init.headers.get("x-openai-internal-codex-responses-lite"), null);
  const offBody = JSON.parse(off.init.body);
  assert.equal(offBody.client_metadata, undefined);
  assert.equal(offBody.prompt_cache_key, undefined);
  assert.equal(offBody.reasoning, undefined);
  assert.equal(offBody.text, undefined);
  assert.equal(offBody.include, undefined);
});

test("claude-code-compat controls the Anthropic system, metadata and context-management shape", async () => {
  const body = { model: "claude-opus-4-6", system: "S", max_tokens: 8, messages: [] };
  const run = async enabled => {
    const calls = [];
    const hooks = await createProvider({ magpie: { option: (provider, key) => key !== "claude-code-compat" || enabled } }, {}, {
      fetchImpl: async (target, init) => { calls.push({ target, init }); return Response.json({ ok: true }); }
    });
    const loaded = await hooks.auth.loader(async () => stored(), { models: {} });
    await loaded.fetch("https://anyrouter.top/v1/messages", { method: "POST", body: JSON.stringify(body) });
    return calls[0];
  };

  const on = JSON.parse((await run(true)).init.body);
  assert.equal(Array.isArray(on.system), true);
  assert.match(on.system[0].text, /Claude Code/);
  assert.ok(on.context_management.edits.length);
  assert.ok(on.metadata.user_id);

  const off = JSON.parse((await run(false)).init.body);
  assert.equal(off.system, "S");
  assert.equal(off.metadata, undefined);
  assert.equal(off.context_management, undefined);
});

test("portable-responses inlines portable history and preserves opaque references", async () => {
  const run = async (portable, input) => {
    const calls = [];
    const hooks = await createProvider({ magpie: { option: (provider, key) => key === "portable-responses" ? portable : false } }, {}, {
      fetchImpl: async (target, init) => { calls.push({ target, init }); return Response.json({ ok: true }); }
    });
    const loaded = await hooks.auth.loader(async () => stored(), { models: {} });
    const response = await loaded.fetch("https://anyrouter.top/v1/responses", {
      method: "POST",
      body: JSON.stringify({ model: "gpt-5-codex", input })
    });
    return { response, body: calls.length ? JSON.parse(calls[0].init.body) : null };
  };
  const portable = [{ type: "message", id: "msg_1", role: "user", content: "hi" }];
  const on = await run(true, portable);
  assert.equal(on.body.input[0].id, undefined);
  assert.equal(on.body.store, false);
  const off = await run(false, portable);
  assert.equal(off.body.input[0].id, "msg_1", "the original body is preserved when inlining is off");
  const reference = [{ type: "item_reference", id: "item_1" }];
  const kept = await run(true, reference);
  assert.equal(kept.body.input[0].type, "item_reference", "references are preserved, not silently dropped");
});

test("codex-session-repair only strips resource bindings when explicitly enabled", async () => {
  const input = [{ type: "message", id: "msg_1", role: "user", content: "hi" }];
  const run = async repair => {
    const calls = [];
    const hooks = await createProvider({ magpie: { option: (provider, key) => key === "codex-session-repair" ? repair : true } }, {}, {
      fetchImpl: async (target, init) => { calls.push({ target, init }); return Response.json({ ok: true }); }
    });
    const loaded = await hooks.auth.loader(async () => stored(), { models: {} });
    const response = await loaded.fetch("https://anyrouter.top/v1/responses", {
      method: "POST",
      body: JSON.stringify({ model: "gpt-5-codex", input, previous_response_id: "resp_old" })
    });
    return { response, body: calls.length ? JSON.parse(calls[0].init.body) : null };
  };
  const off = await run(false);
  assert.equal(off.body.previous_response_id, "resp_old");
  assert.equal(off.body.input[0].id, "msg_1", "no inlining while a server reference is present");
  const on = await run(true);
  assert.equal(on.body.previous_response_id, undefined);
  assert.equal(on.body.store, false);

  const opaque = await (async () => {
    const calls = [];
    const hooks = await createProvider({ magpie: { option: (provider, key) => key === "codex-session-repair" } }, {}, {
      fetchImpl: async (target, init) => { calls.push({ target, init }); return Response.json({ ok: true }); }
    });
    const loaded = await hooks.auth.loader(async () => stored(), { models: {} });
    const response = await loaded.fetch("https://anyrouter.top/v1/responses", {
      method: "POST",
      body: JSON.stringify({ model: "gpt-5-codex", input: [{ type: "item_reference", id: "item_1" }] })
    });
    return { response, calls };
  })();
  assert.equal(opaque.response.status, 400);
  assert.equal((await opaque.response.json()).error.code, "anyrouter_session_repair_empty_input");
  assert.equal(opaque.calls.length, 0, "an unrecoverable repair fails locally instead of sending a truncated body");
});

test("text-filter stays inert without a local word list and never rewrites ordinary prose", async () => {
  const calls = [];
  const hooks = await createProvider({ magpie: { option: () => true } }, {}, {
    fetchImpl: async (target, init) => { calls.push({ target, init }); return Response.json({ ok: true }); }
  });
  const loaded = await hooks.auth.loader(async () => stored(), { models: {} });
  const body = { model: "gpt-5-codex", input: [{ type: "message", role: "user", content: "keep this text" }] };
  await loaded.fetch("https://anyrouter.top/v1/responses", { method: "POST", body: JSON.stringify(body) });
  const sent = JSON.parse(calls[0].init.body);
  assert.equal(JSON.stringify(sent).includes("keep this text"), true);
  assert.equal(JSON.stringify(sent).includes("content-filter.local.json"), false);
});
