import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { beijingDay, readAccount, saveAccount } from "../lib/accounts.mjs";
import { DECLARED_MODEL_IDS } from "../lib/declared-models.mjs";
import { apiKey, existingProgram, openOfflineFixture, responseBody, root, runProgram, startHost } from "./fixtures/offline-host.mjs";

// Explicit opt-in: all credential records and caches belong to temporary HOME,
// and every plugin HTTP request is intercepted before reaching the network.
// MAGPIE_TEST_HOST, MAGPIE_TEST_BINARY, MAGPIE_TEST_BUN must be native absolute
// paths (C:/... on Windows). No dependency installation or live sign-in occurs.
const hostPath = process.env.MAGPIE_TEST_HOST;
const binary = process.env.MAGPIE_TEST_BINARY;
const bun = process.env.MAGPIE_TEST_BUN;
const hostSkip = !hostPath || !bun ? "Set MAGPIE_TEST_HOST and MAGPIE_TEST_BUN for isolated loopback RPC verification." : false;

async function withHost(work, config = {}) {
  const executable = await existingProgram(bun), script = await existingProgram(hostPath);
  const fixture = await openOfflineFixture(executable);
  const host = startHost(executable, script, fixture);
  try {
    const loaded = await host.rpc("init", { directory: fixture.home, authPath: fixture.authPath, modelsDevPath: fixture.modelsDevPath,
      config, plugins: [{ spec: root, target: root, options: { modelsRegistryPath: fixture.modelsDevPath } }] });
    assert.equal(loaded.result.plugins.length, 1);
    assert.equal(loaded.result.plugins[0].error, undefined);
    assert.deepEqual(loaded.result.plugins[0].provides, ["anyrouter"]);
    return await work(host, fixture);
  } finally { await host.close(); await fixture.close(); }
}
const storedAuth = async fixture => JSON.parse(await readFile(fixture.authPath, "utf8"));
const providerRow = async host => (await host.rpc("providers")).result.find(row => row.id === "anyrouter");
const head = reply => reply.events.find(event => event.event === "head");
async function modelFetch(host, model, npm, url, body) {
  return host.rpc("fetch", { provider: "anyrouter", account: "anyrouter", model, npm, url, method: "POST",
    body: Buffer.from(JSON.stringify(body)).toString("base64"), session: "synthetic-session", proxy: "direct" });
}

test("installed host RPC: login prompts, jar persistence, rotation/check-in, missing-key guard and one fetch per request", {
  skip: hostSkip, timeout: 60000,
}, async t => withHost(async (host, fixture) => {
  const { rpc } = host;
  const preview = await providerRow(host);
  assert.equal(preview.methods.length, 6);
  assert.equal(preview.methods.filter(method => method.type === "oauth").length, 5);
  assert.deepEqual(preview.models.map(model => model.id), DECLARED_MODEL_IDS);
  assert.equal(preview.models.find(model => model.id === "gpt-6.1-sol").npm, "@ai-sdk/openai");
  assert.equal(preview.models.find(model => model.id === "gpt-6-astra-cc-format").npm, "@ai-sdk/anthropic");
  assert.equal(preview.models.find(model => model.id === "gpt-6.1-sol").image, true);
  await assert.rejects(rpc("apiKey", { provider: "anyrouter", method: 0, key: "", inputs: {} }), /not an API key method/);

  const answers = { username: "alice", password: "site-password", savePassword: "no", modelKey: "", keyId: "", headers: "" };
  const asked = [], filled = {};
  for (;;) {
    const { result } = await rpc("prompt", { provider: "anyrouter", method: 0, inputs: filled });
    if (!result.prompt) break;
    asked.push(`${result.prompt.key}:${result.prompt.type}`);
    assert.ok(Object.hasOwn(answers, result.prompt.key));
    if (result.prompt.key === "savePassword") assert.deepEqual(result.prompt.options.map(item => item.value), ["no", "yes"]);
    filled[result.prompt.key] = answers[result.prompt.key];
  }
  assert.deepEqual(asked, ["username:text", "password:password", "savePassword:select", "modelKey:password", "keyId:text", "headers:text"]);
  const passwordStart = await rpc("authorize", { provider: "anyrouter", method: 0, inputs: answers, proxy: "direct" });
  assert.equal(passwordStart.result.ok, true);
  assert.equal(passwordStart.result.method, "auto");
  const passwordDone = await rpc("callback", { session: passwordStart.result.session });
  assert.equal(passwordDone.result.ok, true, passwordDone.result.error);
  const passwordRecord = (await storedAuth(fixture))[passwordDone.result.account];
  assert.equal(passwordRecord.accountId, "alice@example.test");
  assert.equal(passwordRecord.uid, "anyrouter:123");
  const passwordState = JSON.parse(passwordRecord.refresh);
  assert.equal(passwordState.mode, "password");
  assert.equal(passwordState.checkinEnabled, false);
  assert.equal(passwordState.password, undefined);
  assert.equal(passwordState.session, undefined);
  assert.equal(passwordState.sessionState.version, 1);
  assert.ok(passwordState.loginGeneration);

  const sessionStart = await rpc("authorize", { provider: "anyrouter", method: 3, inputs: { modelKey: "", keyId: "", headers: "" }, proxy: "direct" });
  assert.equal(sessionStart.result.method, "code");
  const sessionDone = await rpc("callback", { session: sessionStart.result.session, code: JSON.stringify({ cookie: "session=s123", userId: "123" }) });
  assert.equal(sessionDone.result.ok, true, sessionDone.result.error);
  assert.equal(sessionDone.result.account, passwordDone.result.account, "verified UID reuses one host account");
  assert.equal(sessionDone.result.account, "anyrouter");
  const saved = await storedAuth(fixture), account = saved[sessionDone.result.account];
  assert.equal(Object.keys(saved).length, 1);
  assert.equal(account.access, "anyrouter");
  assert.equal(readAccount(account).session, "session=s123");
  assert.notEqual(readAccount(account).loginGeneration, passwordState.loginGeneration);
  assert.equal(JSON.parse(account.refresh).session, undefined);
  const beforeNoKey = fixture.requests.filter(req => req.path.startsWith("/v1/")).length;
  assert.deepEqual((await providerRow(host)).models, []);
  const guarded = await modelFetch(host, "fixture-responses", "@ai-sdk/openai", "https://anyrouter.top/v1/responses", { model: "fixture-responses", input: "hello" });
  assert.equal(head(guarded).status, 400);
  assert.match(responseBody(guarded.events), /anyrouter_missing_api_key/);
  assert.equal(fixture.requests.filter(req => req.path.startsWith("/v1/")).length, beforeNoKey);

  saved.anyrouter = { ...account, metadata: { hostOwned: true }, hostExtension: "preserve" };
  await writeFile(fixture.authPath, JSON.stringify(saved));
  const beforeDefaultUsage = fixture.requests.length;
  const balanceOnly = await rpc("usage", { provider: "anyrouter", account: "anyrouter", proxy: "direct" });
  assert.deepEqual(balanceOnly.result.windows.map(window => window.name), ["累计消耗", "余额"]);
  assert.equal(fixture.requests.length - beforeDefaultUsage, 1);
  assert.equal(balanceOnly.result.balance, "$24.691356");
  const cachedBalance = await rpc("usage", { provider: "anyrouter", account: "anyrouter", proxy: "direct" });
  assert.equal(fixture.requests.length - beforeDefaultUsage, 1, "host quota refresh must reuse the actual short sample");
  assert.match(cachedBalance.result.windows[1].display, /缓存.*采样/);
  assert.equal(cachedBalance.result.windows[1].balance, 24.691356);
  fixture.state.selfRotation = true;
  await rpc("setProviderOptions", { options: { anyrouter: { "site-today-spend": true } } });
  const usage = await rpc("usage", { provider: "anyrouter", account: "anyrouter", proxy: "direct" });
  assert.equal(usage.result.error, "");
  assert.equal(usage.result.signIn, "kept");
  assert.equal(usage.result.balance, "$24.691356");
  assert.deepEqual(usage.result.windows.map(window => window.name), ["累计消耗", "余额", "今日消耗"]);
  assert.equal(usage.result.windows[1].balance, 24.691356);
  assert.equal(usage.result.windows[1].unit, "USD");
  assert.match(usage.result.windows[2].display, /^\$2\.00.*消费日志汇总.*北京时间/);
  const rotated = (await storedAuth(fixture)).anyrouter;
  assert.match(readAccount(rotated).session, /s123-rotated/);
  assert.deepEqual(rotated.metadata, { hostOwned: true });
  assert.equal(rotated.hostExtension, "preserve");
  assert.equal(readAccount(rotated).loginGeneration, readAccount(account).loginGeneration);
  const afterRotation = fixture.requests.length;
  const cachedRotated = await rpc("usage", { provider: "anyrouter", account: "anyrouter", proxy: "direct" });
  assert.equal(fixture.requests.length, afterRotation, "persisted cookie rotation must not discard the fresh cache");
  assert.match(cachedRotated.result.windows[1].display, /缓存.*采样/);
  fixture.state.selfRotation = false;
  const checked = await rpc("checkin", { provider: "anyrouter", account: "anyrouter", proxy: "direct" });
  assert.equal(checked.result.outcome, "claimed");
  assert.equal(checked.result.credit, 5);
  const posted = fixture.requests.filter(req => req.path === "/api/user/sign_in");
  assert.equal(posted.length, 1);
  assert.match(posted[0].headers.cookie, /s123-rotated/);
  assert.equal(posted[0].headers.authorization, undefined);
  assert.equal(readAccount((await storedAuth(fixture)).anyrouter).lastCheckinDay, beijingDay());
  assert.equal((await rpc("checkin", { provider: "anyrouter", account: "anyrouter", proxy: "direct" })).result.outcome, "done");
  assert.equal(fixture.requests.filter(req => req.path === "/api/user/sign_in").length, 1);

  const next = saveAccount({ ...readAccount(rotated), key: apiKey, keyId: "7", loginGeneration: "synthetic-relogin" }, rotated);
  await rpc("import", { provider: "anyrouter", key: "anyrouter", auth: next });
  await rpc("reload", { provider: "anyrouter", account: "anyrouter" });
  const models = (await providerRow(host)).models;
  assert.deepEqual(models.map(model => model.id), ["fixture-responses", "fixture-messages"]);
  assert.equal(models[0].npm, "@ai-sdk/openai");
  assert.equal(models[1].npm, "@ai-sdk/anthropic");
  const before = fixture.requests.filter(req => req.path === "/v1/responses").length;
  const response = await modelFetch(host, "fixture-responses", "@ai-sdk/openai", "https://anyrouter.top/v1/responses", { model: "fixture-responses", input: "hello", stream: true });
  assert.equal(head(response).status, 200);
  assert.match(responseBody(response.events), /safe-result/);
  const sent = fixture.requests.filter(req => req.path === "/v1/responses");
  assert.equal(sent.length - before, 1);
  assert.equal(sent.at(-1).headers.authorization, `Bearer ${apiKey}`);
  assert.equal(sent.at(-1).headers.cookie, undefined);
  assert.equal(sent.at(-1).headers["new-api-user"], undefined);
  assert.match(sent.at(-1).headers["user-agent"], /^codex_exec\//);
  assert.equal(JSON.parse(sent.at(-1).body).prompt_cache_key, "synthetic-session");
  assert.doesNotMatch(JSON.stringify(host.events.filter(event => event.event === "log")), /site-password|sk-synthetic-offline-model|session=s123/);
  const timestamp = Math.floor(Date.now() / 1000) - 1;
  fixture.state.tokens = [{ id: 8, user_id: 123, key: "synthetic-external-only" }];
  fixture.state.logs = [
    { id: 9001, type: 2, user_id: 123, token_id: 8, created_at: timestamp, model_name: "gpt-future", prompt_tokens: 100, completion_tokens: 20, quota: 1000000, other: '{"cache_tokens":30}', content: "private external prompt" },
    { id: 9002, type: 2, user_id: 123, token_id: 7, created_at: timestamp, content: "already gateway known" },
  ];
  fixture.state.selfRotation = true;
  const beforeCalls = fixture.requests.length;
  const external = (await rpc("calls", { provider: "anyrouter", account: "anyrouter", since: timestamp * 1000 })).result;
  assert.deepEqual(external.calls, [{ rid: "anyrouter:123:log:9001", t: timestamp * 1000, model: "gpt-future", in: 70, out: 20, cache_read: 30, cache_write: 0, cost: 2, session: "" }]);
  const repeated = (await rpc("calls", { provider: "anyrouter", account: "anyrouter", since: timestamp * 1000 })).result;
  assert.deepEqual(repeated.calls, external.calls, "Repeated reads preserve the host's stable deduplication identity");
  assert.equal(fixture.requests.slice(beforeCalls).every(req => req.method === "GET"), true);
  assert.equal(fixture.requests.filter(req => req.path === "/api/user/sign_in").length, 1);
  assert.match(readAccount((await storedAuth(fixture)).anyrouter).session, /rotated-rotated/);
  assert.equal(JSON.stringify(await storedAuth(fixture)).includes("synthetic-external-only"), false);
  fixture.state.logs[0].user_id = 124;
  await assert.rejects(rpc("calls", { provider: "anyrouter", account: "anyrouter", since: timestamp * 1000 }), /身份|日志/);
  t.diagnostic("Isolated host RPC: account lifecycle, one inference fetch and external-only Key log normalization/deduplication/identity rejection verified.");
}, { provider: { anyrouter: { externalUsageKeyIds: [8] } } }));

test("installed host RPC: authoritative account models, config/runtime SDKs, fallback/empty lists and independent switches", {
  skip: hostSkip, timeout: 60000,
}, async t => withHost(async (host, fixture) => {
  const { rpc } = host;
  fixture.state.rows = [
    { id: "gpt-6.1-sol" }, { id: "claude-opus-4-6" }, { id: "claude-3-5-haiku-20241022" },
    { id: "gpt-future", reasoning: true, modalities: { input: ["text", "image"], output: ["text"] }, context_length: 10000, max_output_tokens: 1000 },
    { id: "claude-future", reasoning: true, supported_endpoint_types: ["anthropic"] },
    { id: "gpt-override", reasoning: true }, { id: "disabled" },
    { id: "gemini-4-carbon" }, { id: "gemini-4-neon" },
  ];
  fixture.state.prices = [
    { model_name: "gemini-4-neon", quota_type: 0, model_ratio: 1, completion_ratio: 5, enable_groups: ["default"] },
    { model_name: "gemini-4-carbon", quota_type: 0, model_ratio: 2, completion_ratio: 5, enable_groups: ["default"] },
    { model_name: "not-accessible", quota_type: 0, model_ratio: 1, completion_ratio: 5, enable_groups: ["default"] },
  ];
  await rpc("import", { provider: "anyrouter", key: "anyrouter", auth: { type: "api", key: apiKey } });
  const success = await providerRow(host), byId = Object.fromEntries(success.models.map(row => [row.id, row]));
  assert.deepEqual(Object.keys(byId), ["gpt-6.1-sol", "claude-opus-4-6", "claude-3-5-haiku-20241022", "gpt-future", "claude-future", "friendly", "gemini-4-carbon", "gemini-4-neon"]);
  for (const id of ["gemini-4-carbon", "gemini-4-neon"]) {
    assert.equal(byId[id].npm, "@ai-sdk/google");
    assert.equal(byId[id].url, "https://anyrouter.top/v1beta");
  }
  assert.equal(success.fellBack, false);
  assert.deepEqual(byId["gemini-4-neon"].cost, { input: 2, output: 10 });
  assert.deepEqual(byId["gemini-4-carbon"].cost, { input: 4, output: 20 });
  assert.equal(byId["gpt-future"].cost, undefined);
  assert.deepEqual(byId.friendly.cost, { input: 0, output: 3 });
  assert.equal(byId["not-accessible"], undefined);
  const pricesBeforeReload = fixture.requests.filter(req => req.path === "/api/pricing").length;
  const modelsBeforeReload = fixture.requests.filter(req => req.path === "/v1/models").length;
  await rpc("reload", { provider: "anyrouter", account: "anyrouter" });
  const recatalog = await providerRow(host);
  assert.ok(fixture.requests.filter(req => req.path === "/v1/models").length > modelsBeforeReload, "model permissions must still be refreshed");
  assert.equal(fixture.requests.filter(req => req.path === "/api/pricing").length, pricesBeforeReload, "host refresh must reuse anonymous pricing");
  assert.deepEqual(recatalog.models.find(model => model.id === "gemini-4-neon").cost, { input: 2, output: 10 });
  for (const sent of fixture.requests.filter(req => req.path === "/api/pricing")) {
    assert.equal(sent.headers.cookie, undefined); assert.equal(sent.headers.authorization, undefined);
    assert.equal(sent.headers["new-api-user"], "-1");
  }
  assert.equal(byId["gpt-future"].npm, "@ai-sdk/openai");
  assert.equal(byId["gpt-future"].reasoning, true);
  assert.equal(byId["gpt-future"].image, true);
  assert.equal(byId["gpt-future"].context, 10000);
  assert.equal(byId["claude-future"].npm, "@ai-sdk/anthropic");
  assert.equal(byId["gpt-6.1-sol"].image, true);
  assert.deepEqual(byId["gpt-6.1-sol"].outputs, ["text"]);
  assert.equal(byId["claude-3-5-haiku-20241022"].reasoning, false);
  assert.equal(byId.friendly.apiId, "gpt-override");
  assert.equal(byId.friendly.npm, "@ai-sdk/openai-compatible");
  assert.equal(byId.friendly.reasoning, false);
  assert.equal(byId.friendly.image, false);
  assert.equal(byId.manual, undefined);
  assert.equal(byId["registry-only"], undefined);

  for (const mode of ["failure", "waf"]) {
    fixture.state.listMode = mode;
    await rpc("reload", { provider: "anyrouter", account: "anyrouter" });
    const fallback = await providerRow(host);
    assert.equal(fallback.fellBack, true);
    assert.equal(fallback.models.find(row => row.id === "gpt-6.1-sol").npm, "@ai-sdk/openai");
    assert.equal(fallback.models.find(row => row.id === "claude-opus-4-6").npm, "@ai-sdk/anthropic");
    assert.equal(fallback.models.some(row => row.id === "manual"), true);
    assert.equal(fallback.models.some(row => row.id === "registry-only"), false);
    assert.deepEqual(fallback.models.find(row => row.id === "friendly").cost, { input: 0, output: 3 });
    assert.equal(fallback.models.find(row => row.id === "gemini-4-neon").cost, undefined);
    assert.equal((await storedAuth(fixture)).anyrouter.key, apiKey);
  }
  fixture.state.listMode = "empty";
  await rpc("reload", { provider: "anyrouter", account: "anyrouter" });
  const empty = await providerRow(host);
  assert.deepEqual(empty.models, []);
  assert.equal(empty.fellBack, false);
  fixture.state.listMode = "success";
  await rpc("reload", { provider: "anyrouter", account: "anyrouter" });

  for (const codex of [false, true]) for (const claude of [false, true]) {
    await rpc("setProviderOptions", { options: { anyrouter: { "send-codex-headers": codex, "claude-code-compat": claude } } });
    const prior = fixture.requests.filter(req => req.path === "/v1/messages").length;
    const response = await modelFetch(host, "claude-future", "@ai-sdk/anthropic", "https://anyrouter.top/v1/messages", { model: "claude-future", system: "synthetic system", messages: [], max_tokens: 16 });
    assert.equal(head(response).status, 200);
    assert.match(responseBody(response.events), /safe-claude-result/);
    const messages = fixture.requests.filter(req => req.path === "/v1/messages");
    assert.equal(messages.length - prior, 1);
    assert.equal(Boolean(messages.at(-1).headers["anthropic-beta"]), claude);
    assert.equal(messages.at(-1).query.includes("beta=true"), claude);
    assert.equal(Array.isArray(JSON.parse(messages.at(-1).body).system), claude);
    const gpt = await modelFetch(host, "gpt-future", "@ai-sdk/openai", "https://anyrouter.top/v1/responses", { model: "gpt-future", input: "synthetic" });
    assert.equal(head(gpt).status, 200);
    const sent = fixture.requests.filter(req => req.path === "/v1/responses").at(-1);
    assert.equal(Boolean(JSON.parse(sent.body).client_metadata), codex);
    assert.equal(Boolean(sent.headers.originator), codex);
  }
  for (const action of ["generateContent", "streamGenerateContent", "countTokens"]) {
    const body = { contents: [{ role: "user", parts: [{ text: "synthetic", thoughtSignature: "retain-synthetic-signature" }] }], generationConfig: { maxOutputTokens: 16 } };
    const before = fixture.requests.length;
    const result = await modelFetch(host, "gemini-4-neon", "@ai-sdk/google", `https://anyrouter.top/v1beta/models/gemini-4-neon:${action}?alt=sse`, body);
    assert.equal(head(result).status, 200);
    if (action === "countTokens") assert.equal(JSON.parse(responseBody(result.events)).totalTokens, 5);
    else assert.match(responseBody(result.events), /safe-gemini-result/);
    assert.equal(fixture.requests.length - before, 1);
    const sent = fixture.requests.at(-1);
    assert.equal(sent.path, `/v1beta/models/gemini-4-neon:${action}`);
    assert.equal(sent.headers["x-goog-api-key"], apiKey);
    assert.equal(sent.headers.authorization, undefined);
    assert.equal(sent.headers.cookie, undefined);
    assert.deepEqual(JSON.parse(sent.body), body);
  }
  const beforeDisabledCalls = fixture.requests.length;
  assert.deepEqual((await rpc("calls", { provider: "anyrouter", account: "anyrouter", since: 0 })).result.calls, []);
  assert.equal(fixture.requests.length, beforeDisabledCalls);
  const timestamp = Math.floor(Date.now() / 1000) - 1;
  fixture.state.tokens = [{ id: 7, user_id: 123, key: apiKey }, { id: 8, user_id: 123, key: "synthetic-other-client" }];
  fixture.state.logs = [7, 8].map((token_id, index) => ({ id: 9301 + index, type: 2, user_id: 123, token_id, created_at: timestamp,
    model_name: "gpt-future", prompt_tokens: 100, completion_tokens: 20, other: '{"cache_tokens":0}' }));
  const sessionAuth = saveAccount({ mode: "session", site: "top", siteURL: "https://anyrouter.top", userId: "123", key: apiKey, keyId: "7", session: `session=${fixture.state.cookie}`, loginGeneration: "synthetic-host-auto" });
  await rpc("import", { provider: "anyrouter", key: "anyrouter", auth: sessionAuth });
  await rpc("setProviderOptions", { options: { anyrouter: { "site-external-usage": true } } });
  const autoCalls = (await rpc("calls", { provider: "anyrouter", account: "anyrouter", since: timestamp * 1000 })).result.calls;
  assert.deepEqual(autoCalls.map(call => call.rid), ["anyrouter:123:log:9302"]);
  assert.equal(JSON.stringify(await storedAuth(fixture)).includes("synthetic-other-client"), false);
  t.diagnostic("Real host normalization: native Gemini, authoritative models, pricing cache, independent switches and GUI automatic current-Key exclusion verified.");
}, { provider: { anyrouter: { npm: "@ai-sdk/anthropic", api: "https://anyrouter.top/v1", pricingGroup: "default", models: {
  friendly: { id: "gpt-override", cost: { input: 0, output: 3 }, provider: { npm: "@ai-sdk/openai-compatible", api: "https://anyrouter.top/v1" }, reasoning: false, attachment: false, tool_call: false, modalities: { input: ["text"], output: ["text"] } },
  disabled: { disabled: true }, manual: { provider: { npm: "@ai-sdk/openai" } },
} } } }));

test("isolated real Magpie CLI: verified Bun fence, plugin add/list, native-key login and offline quota", {
  skip: !binary || !bun ? "Set MAGPIE_TEST_BINARY and MAGPIE_TEST_BUN for a test-local offline CLI session." : false, timeout: 180000,
}, async t => {
  const executable = await existingProgram(binary), runtime = await existingProgram(bun);
  const fixture = await openOfflineFixture(runtime);
  let sequence = 0;
  const cli = async (argv, input = "") => {
    const fence = path.join(fixture.home, `offline-fence-${++sequence}.json`);
    const result = await runProgram(executable, argv, { cwd: fixture.home, env: { ...fixture.env, MAGPIE_TEST_FENCE_FILE: fence }, input });
    assert.equal(result.code, 0, "The isolated Magpie command must exit successfully.");
    const marker = JSON.parse(await readFile(fence, "utf8"));
    assert.equal(marker.origin, fixture.origin, "The actual CLI-spawned host must load the offline fence.");
    return result;
  };
  try {
    const probe = await runProgram(runtime, ["--eval", "console.log(JSON.stringify(globalThis.__ANYROUTER_OFFLINE_FIXTURE__));"], { cwd: fixture.home, env: fixture.env, timeoutMs: 5000 });
    assert.equal(probe.code, 0);
    assert.equal(JSON.parse(probe.stdout).origin, fixture.origin, "Verify the Bun preload before invoking any credential-bearing CLI operation.");
    const added = await cli(["plugin", "add", root.replace(/[\\/]+$/, "")]);
    assert.match(added.stdout, /added /);
    const listed = JSON.parse((await cli(["plugin", "list", "--json"])).stdout);
    assert.equal(listed.loaded.length, 1);
    assert.equal(listed.loaded[0].error, undefined);
    const provider = listed.providers.find(row => row.id === "anyrouter");
    assert.equal(provider.methods.length, 6);
    assert.deepEqual(provider.models.map(row => row.id), DECLARED_MODEL_IDS);
    assert.equal(provider.models.find(row => row.id === "gpt-6.1-sol").npm, "@ai-sdk/openai");
    assert.equal(provider.models.find(row => row.id === "gpt-6.1-sol").image, true);
    const index = provider.methods.findIndex(method => method.type === "api") + 1;
    const fakeKey = "sk-sandbox-host-integration-key";
    const login = await cli(["plugin", "login", "anyrouter", String(index)], `\n\n${fakeKey}\n`);
    assert.match(login.stdout, /signed in to AnyRouter/);
    const auth = await storedAuth(fixture);
    assert.equal(auth.anyrouter.type, "api");
    assert.equal(auth.anyrouter.key, fakeKey);
    assert.equal(typeof auth.anyrouter.metadata, "object");
    const quota = await cli(["quota", "anyrouter", "--json"]);
    const row = JSON.parse(quota.stdout).find(item => item.provider === "anyrouter");
    assert.equal(row.plan, "API Key（仅推理）");
    assert.equal(row.windows.find(window => window.name === "累计消耗").display, "$12.34");
    assert.equal(fixture.requests.some(req => req.path === "/v1/dashboard/billing/usage"), true);

    fixture.state.selfRotation = true;
    await writeFile(fixture.authPath, JSON.stringify({ anyrouter: saveAccount({ mode: "session", site: "top", siteURL: "https://anyrouter.top", apiBase: "https://anyrouter.top/v1",
      userId: "123", username: "alice", email: "alice@example.test", key: apiKey, session: "session=s123", checkinEnabled: false, loginGeneration: "synthetic-cli-session" }) }));
    const sessionQuota = JSON.parse((await cli(["quota", "anyrouter", "--json"])).stdout).find(item => item.provider === "anyrouter");
    assert.equal(sessionQuota.balance, "$24.691356");
    assert.equal(sessionQuota.windows.find(window => window.name === "余额").balance, 24.691356);
    assert.equal(readAccount((await storedAuth(fixture)).anyrouter).session, "session=s123-rotated");
    assert.equal(fixture.requests.every(req => req.headers["x-test-upstream-origin"] === "https://anyrouter.top"), true);
    assert.equal(fixture.requests.filter(req => req.path === "/api/user/sign_in").length, 0, "The CLI test must not even simulate an unsolicited sign-in.");
    t.diagnostic(`Actual CLI verified with ${sequence} fenced host launches; all plugin HTTP traffic was handled by the loopback fixture.`);
  } finally { await fixture.close(); }
});
