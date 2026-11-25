import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createProvider } from "../lib/provider.mjs";
import { saveAccount } from "../lib/accounts.mjs";
import { prepareRequest } from "../lib/request.mjs";
import { repairSessionResources } from "../lib/session-repair.mjs";

const url = "https://anyrouter.top/v1/responses";
const id = prefix => `${prefix}_0123456789abcdef0123456789abcdef`;
const repairOptions = { portableResponses: false, sessionRepair: true };
const user = () => ({ role: "user", content: "Keep every visible word." });
const assistant = () => ({
  type: "message", id: id("msg"), role: "assistant", status: "completed", phase: "commentary",
  content: [{ type: "output_text", text: "Checking the result.", annotations: [], logprobs: [] }],
});
const history = () => ({
  model: "synthetic-model", stream: true, store: true, previous_response_id: id("resp"),
  input: [user(), assistant(),
    { type: "reasoning", id: id("rs"), summary: [], encrypted_content: "synthetic-sealed" },
    { type: "compaction", id: id("cmp"), encrypted_content: "synthetic-compacted" },
    { type: "item_reference", id: id("msg") },
    { type: "function_call", id: id("fc"), call_id: id("call"), name: "lookup",
      arguments: '{"id":"business-id","encrypted_content":"literal-tool-data"}',
      encrypted_function_args: "synthetic-sealed-args" },
    { type: "function_call_output", id: id("fco"), call_id: id("call"),
      output: [{ type: "input_text", text: "Keep the tool result." }] },
  ],
  tools: [{ type: "function", name: "lookup", parameters: { type: "object", properties: {
    id: { type: "string" }, encrypted_content: { type: "string" },
  } } }],
  metadata: { id: id("meta"), previous_response_id: "business-reference" },
});

async function prepare(body, options = repairOptions, extra = {}) {
  const init = { method: "POST", body: JSON.stringify(body), ...extra };
  return prepareRequest(url, init, options);
}

function account(extra = {}) {
  return saveAccount({
    mode: "password",
    site: "top",
    siteURL: "https://anyrouter.top",
    key: "synthetic-api-key",
    keyId: "7",
    userId: "42",
    username: "alice",
    password: "site-secret",
    session: "session=synthetic-site-cookie",
    accessToken: "synthetic-management-token",
    headers: "",
    checkinEnabled: true,
    ...extra,
  });
}

async function harness(t, options = {}, extra = {}) {
  const calls = [];
  const hooks = await createProvider(
    { magpie: { option: (_provider, key) => key === "send-codex-headers" ? false : options[key] } },
    {},
    {
      fetchImpl: async (input, init) => {
        calls.push({ input, init });
        if (extra.fetch) return extra.fetch(calls.length, input, init);
        return new Response("ok");
      },
    },
  );
  return { hooks, calls };
}

async function capture(t, options = {}, body = history(), input = url, extra = {}) {
  const { hooks, calls } = await harness(t, options, extra);
  const auth = extra.auth ?? account();
  const loader = await hooks.auth.loader(async () => auth, { models: {} });
  const init = { method: "POST", body: JSON.stringify(body, null, 2), ...(extra.init ?? {}) };
  const response = await loader.fetch(input, init);
  return { hooks, loader, init, response, calls };
}

test("provider switches keep Chinese labels, bounded lengths and the lossy cleanup default off", async () => {
  const p = await createProvider();
  const options = Object.fromEntries(p.auth.options.map(({ key, default: value }) => [key, value]));
  assert.equal(options["text-filter"], true);
  assert.equal(options["portable-responses"], true);
  assert.equal(options["send-codex-headers"], true);
  assert.equal(options["claude-code-compat"], true);
  assert.equal(options["codex-session-repair"], false);
  for (const option of p.auth.options) {
    assert.match(option.label, /[\u4e00-\u9fff]/);
    assert.match(option.description, /[\u4e00-\u9fff]/);
    assert.ok(option.key.length <= 40);
    assert.ok(option.label.length <= 60);
    assert.ok(option.description.length <= 300);
    assert.ok((option.confirm?.length ?? 0) <= 300);
  }
  const repair = p.auth.options.find(option => option.key === "codex-session-repair");
  assert.match(repair.label, /有损/);
  assert.match(repair.description, /上下文/);
  assert.match(repair.confirm, /上下文/);
  const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  assert.match(pkg.description, /AnyRouter/);
  assert.ok(pkg.files.includes("lib/*.mjs"));
  assert.equal(pkg.files.includes("lib/"), false, "private runtime JSON must not enter the package");
});

test("resource repair is off by default even when the existing options are on", async t => {
  const { init, calls } = await capture(t);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].init.body, init.body);
});

for (const value of [false, undefined, null, "true", 1]) {
  test("only explicit boolean true enables lossy cleanup: " + String(value), async t => {
    const { init, calls } = await capture(t, { "codex-session-repair": value });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].init.body, init.body);
  });
}

test("older hosts without an option reader never enable resource repair", async t => {
  const calls = [];
  const hooks = await createProvider({}, {}, {
    fetchImpl: async (input, init) => { calls.push({ input, init }); return new Response("ok"); },
  });
  const auth = account();
  const loader = await hooks.auth.loader(async () => auth, { models: {} });
  const body = JSON.stringify(history(), null, 2);
  await loader.fetch(url, { method: "POST", body });
  assert.equal(calls.length, 1);
  // Codex request normalization is not the lossy session repair: it may add
  // prompt_cache_key/client_metadata, but it must keep every resource binding.
  const sent = JSON.parse(calls[0].init.body);
  assert.equal(sent.previous_response_id, id("resp"));
  assert.deepEqual(sent.input.map(item => item.type), [undefined, "message", "reasoning", "compaction", "item_reference", "function_call", "function_call_output"]);
  assert.equal(sent.input[1].id, id("msg"));
  assert.equal(sent.input[2].encrypted_content, "synthetic-sealed");
  assert.deepEqual(sent.metadata, history().metadata);
});

test("repair removes old bindings and opaque history without changing tool data or caller history", async () => {
  const before = history();
  const original = structuredClone(before);
  const result = JSON.parse((await prepare(before)).body);
  const expectedAssistant = assistant(); delete expectedAssistant.id; delete expectedAssistant.status;
  const expectedCall = structuredClone(before.input[5]); delete expectedCall.id; delete expectedCall.encrypted_function_args;
  const expectedOutput = structuredClone(before.input[6]); delete expectedOutput.id;
  assert.deepEqual(result, {
    model: before.model, stream: true, store: false,
    input: [user(), expectedAssistant, expectedCall, expectedOutput],
    tools: before.tools, metadata: before.metadata,
  });
  assert.deepEqual(before, original);
});

test("the cleanup module uses copies and keeps untouched item and tool identities", () => {
  const item = Object.freeze(assistant());
  const untouched = Object.freeze(user());
  const tools = Object.freeze(history().tools);
  const body = Object.freeze({ store: true, input: Object.freeze([untouched, item]), tools });
  const result = repairSessionResources(body);
  assert.equal(result.changed, true);
  assert.notEqual(result.body, body);
  assert.notEqual(result.body.input, body.input);
  assert.equal(result.body.input[0], untouched);
  assert.notEqual(result.body.input[1], item);
  assert.equal(result.body.input[1].content, item.content);
  assert.equal(result.body.tools, tools);
  assert.equal(item.id, id("msg"));
  assert.equal(item.status, "completed");
});

test("Codex custom tool calls keep free-form input, namespace and the paired result", async () => {
  const input = [user(), {
    type: "custom_tool_call", id: id("ctc"), call_id: id("call"), name: "exec", namespace: "functions",
    input: `text({ id: "${id("msg")}", encrypted_content: "literal data" });`,
    encrypted_function_args: "synthetic-sealed-input",
  }, {
    type: "custom_tool_call_output", id: id("ctco"), call_id: id("call"), output: "Keep the complete custom result.",
    encrypted_content: "synthetic-sealed-output",
  }];
  const result = JSON.parse((await prepare({ input })).body);
  const call = { ...input[1] }; delete call.id; delete call.encrypted_function_args;
  const output = { ...input[2] }; delete output.id; delete output.encrypted_content;
  assert.deepEqual(result, { input: [user(), call, output], store: false });
});

test("the installed loader can switch cleanup on and off between requests without re-login", async t => {
  const options = { "codex-session-repair": true, "portable-responses": false, "text-filter": false };
  const { loader, init, calls, response } = await capture(t, options);
  assert.equal(response.status, 200);
  assert.equal(JSON.parse(calls[0].init.body).previous_response_id, undefined);
  assert.deepEqual(JSON.parse(calls[0].init.body).input.map(item => item.type), [undefined, "message", "function_call", "function_call_output"]);
  options["codex-session-repair"] = false;
  await loader.fetch(url, init);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].init.body, init.body);
  options["codex-session-repair"] = true;
  await loader.fetch(url, init);
  assert.equal(calls.length, 3);
  assert.equal(calls[2].init.body, calls[0].init.body);
  const headers = new Headers(calls[0].init.headers);
  assert.equal(headers.get("authorization"), "Bearer synthetic-api-key");
  assert.equal(headers.has("cookie"), false);
  for (const secret of ["synthetic-site-cookie", "synthetic-management-token"]) {
    assert.equal(JSON.stringify(calls).includes(secret), false);
  }
});

test("repair preserves the caller signal, session identity and other headers while removing stale integrity headers", async () => {
  const controller = new AbortController();
  const result = await prepare(history(), repairOptions, { signal: controller.signal, headers: {
    "content-type": "application/json", "content-length": "123", "content-md5": "old",
    digest: "old", "content-digest": "old", "x-session-id": "synthetic-session", "x-custom": "keep",
  } });
  const headers = new Headers(result.headers);
  for (const name of ["content-length", "content-md5", "digest", "content-digest"]) assert.equal(headers.has(name), false);
  assert.equal(headers.get("x-session-id"), "synthetic-session");
  assert.equal(headers.get("x-custom"), "keep");
  assert.equal(result.signal, controller.signal);
});

test("cloned Request cleanup leaves the original request readable and byte-identical", async () => {
  const body = JSON.stringify(history(), null, 2);
  const request = new Request(url, { method: "POST", body, headers: { "content-type": "application/json" } });
  const result = await prepareRequest(request, {}, repairOptions);
  assert.equal(JSON.parse(result.body).previous_response_id, undefined);
  assert.equal(await request.text(), body);
});

test("cleanup only touches server-shaped top-level IDs, not business IDs or nested attachments", async () => {
  const input = [user(), ...[id("msg"), "MSG_0123456789ABCDEF", "business-id", "msg_short", "msg_0123456789abcdef-not-an-id"].map(value => ({
    type: "message", id: value, role: "assistant", status: "completed",
    content: [{ type: "output_text", text: value, annotations: [{ id: id("citation") }] }],
  })), { role: "user", content: [{ type: "input_file", file_id: id("file") }] }];
  const result = JSON.parse((await prepare({ input })).body);
  for (let index = 1; index <= 2; index++) {
    assert.equal(result.input[index].id, undefined);
    assert.equal(result.input[index].status, undefined);
    assert.deepEqual(result.input[index].content, input[index].content);
  }
  assert.deepEqual(result.input.slice(3), input.slice(3));
});

test("encrypted message fragments are dropped but readable text, refusal and phase stay intact", async () => {
  const part = { type: "output_text", text: "Visible", annotations: [{ type: "url_citation", url: "https://example.test" }], logprobs: [] };
  const refusal = { type: "refusal", refusal: "Keep this refusal." };
  const item = { ...assistant(), encrypted_content: "synthetic-sealed", previous_response_id: id("resp"),
    content: [{ type: "encrypted_content", encrypted_content: "synthetic-fragment" }, part, refusal] };
  const opaque = { type: "message", role: "assistant", content: [{ type: "encrypted_content", encrypted_content: "synthetic-opaque" }] };
  const result = JSON.parse((await prepare({ input: [user(), item, opaque] })).body);
  assert.deepEqual(result.input, [user(), { type: "message", role: "assistant", phase: "commentary", content: [part, refusal] }]);
});

test("resource-bound reasoning is dropped rather than forwarding an invalid reasoning item without its required ID", async () => {
  const visible = { type: "reasoning", id: id("rs"), summary: [{ type: "summary_text", text: "Synthetic summary" }] };
  const unknown = { type: "reasoning", id: "local-reasoning", summary: [], future_state: { id: id("rs") } };
  const result = JSON.parse((await prepare({ input: [user(), visible, unknown] })).body);
  assert.deepEqual(result.input, [user(), unknown]);
});

test("unknown history kinds keep their IDs and opaque fields instead of guessing their schema", async () => {
  const unknown = { type: "future_item", id: id("future"), encrypted_content: "synthetic-future", nested: { previous_response_id: id("resp") } };
  const result = JSON.parse((await prepare({ input: [assistant(), unknown] })).body);
  assert.deepEqual(result.input[1], unknown);
});

test("an explicit server-side conversation is not detached or cleaned", async () => {
  const init = { method: "POST", body: JSON.stringify({ ...history(), conversation: id("conv") }, null, 2) };
  assert.equal(await prepareRequest(url, init, repairOptions), init);
});

test("string input can detach an old response while literal IDs in its text remain unchanged", async () => {
  const body = { previous_response_id: id("resp"), input: `Keep ${id("msg")} in the text.` };
  assert.deepEqual(JSON.parse((await prepare(body)).body), { input: body.input, store: false });
});

test("a request with nothing to repair keeps its exact original bytes and store value", async () => {
  const init = { method: "POST", body: JSON.stringify({ store: true, input: [user()] }, null, 2) };
  assert.equal(await prepareRequest(url, init, repairOptions), init);
});

test("repaired request preparation is idempotent", async () => {
  const once = await prepare(history());
  assert.equal(await prepareRequest(url, once, repairOptions), once);
});

for (const input of [
  [{ type: "compaction", encrypted_content: "synthetic-private" }],
  [{ type: "item_reference", id: id("msg") }],
  [{ type: "reasoning", id: id("rs"), encrypted_content: "synthetic-private" }],
  [{ type: "message", role: "assistant", encrypted_content: "synthetic-private", content: [] }],
  [{ type: "message", id: id("msg"), role: "assistant", content: [] }],
  [{ type: "message", id: id("msg"), role: "assistant" }],
]) test("empty repaired input is rejected locally without sending or retrying: " + input[0].type, async t => {
  const { response, calls } = await capture(t, { "codex-session-repair": true }, { input });
  assert.equal(calls.length, 0);
  assert.equal(response.status, 400);
  const result = await response.json();
  assert.equal(result.error.code, "anyrouter_session_repair_empty_input");
  assert.equal(JSON.stringify(result).includes("synthetic-private"), false);
});

test("a missing model key is rejected before attempting even explicitly enabled cleanup", async t => {
  const auth = account({ key: "", hasModelKey: false });
  const { hooks, calls } = await harness(t, { "codex-session-repair": true });
  const loader = await hooks.auth.loader(async () => auth, { models: {} });
  const response = await loader.fetch(url, { method: "POST", body: JSON.stringify({ input: [{ type: "compaction" }] }) });
  assert.equal(calls.length, 0);
  assert.equal(response.status, 400);
  assert.equal((await response.json()).error.code, "anyrouter_missing_api_key");
});

test("cleanup preserves abort handling when only the new request transformation is enabled", { timeout: 3000 }, async t => {
  const controller = new AbortController();
  const request = new Request(url, { method: "POST", body: new ReadableStream({ start() {} }), duplex: "half" });
  t.after(() => { void request.body.cancel().catch(() => {}); });
  const init = { signal: controller.signal };
  const pending = prepareRequest(request, init, repairOptions);
  const timer = setTimeout(() => controller.abort(), 10);
  t.after(() => clearTimeout(timer));
  await assert.rejects(pending, { name: "AbortError" });
  assert.equal(request.bodyUsed, false);
});

test("cleanup retains the two-second Request inspection deadline", { timeout: 7000 }, async t => {
  const request = new Request(url, { method: "POST", body: new ReadableStream({ start() {} }), duplex: "half" });
  t.after(() => { void request.body.cancel().catch(() => {}); });
  const init = {};
  assert.equal(await prepareRequest(request, init, repairOptions), init);
  assert.equal(request.bodyUsed, false);
});

for (const item of [
  { type: "function_call", id: id("fc"), call_id: "keep", name: "lookup", encrypted_function_args: "synthetic-private" },
  { type: "function_call_output", id: id("fco"), call_id: "keep", encrypted_content: "synthetic-private" },
  { type: "function_call", id: id("fc"), call_id: "keep", name: "lookup" },
  { type: "function_call_output", id: id("fco"), call_id: "keep" },
  { type: "function_call", id: id("fc"), name: "lookup", arguments: "{}" },
  { type: "function_call_output", id: id("fco"), output: "Keep" },
  { type: "custom_tool_call", id: id("ctc"), call_id: "keep", name: "exec", encrypted_function_args: "synthetic-private" },
  { type: "custom_tool_call_output", id: id("ctco"), call_id: "keep", encrypted_content: "synthetic-private" },
]) test("tool data and associations cannot be silently discarded: " + item.type, async t => {
  const { response, calls } = await capture(t, { "codex-session-repair": true }, { input: [user(), item] });
  assert.equal(calls.length, 0);
  assert.equal(response.status, 400);
  const result = await response.json();
  assert.equal(result.error.code, "anyrouter_session_repair_opaque_tool");
  assert.equal(JSON.stringify(result).includes("synthetic-private"), false);
});

test("resource rejection after cleanup still produces just one upstream request", async t => {
  let attempts = 0;
  const { hooks, calls } = await harness(t, { "codex-session-repair": true }, {
    fetch: () => {
      attempts++;
      return Response.json({ error: { message: "The requested item was created under a different Azure OpenAI resource." } }, { status: 400 });
    },
  });
  const auth = account();
  const loader = await hooks.auth.loader(async () => auth, { models: {} });
  const response = await loader.fetch(url, { method: "POST", body: JSON.stringify(history()) });
  assert.equal(attempts, 1);
  assert.equal(calls.length, 1);
  assert.equal(response.status, 400);
  assert.equal((await response.json()).error.type, "anyrouter_resource_mismatch");
});

for (const path of ["/v1/responses/compact", "/v1/chat/completions", "/v1/models"]) {
  test("cleanup does not change other endpoints: " + path, async () => {
    const init = { method: "POST", body: JSON.stringify(history()) };
    assert.equal(await prepareRequest("https://anyrouter.top" + path, init, repairOptions), init);
  });
}

for (const init of [
  { method: "GET", body: JSON.stringify(history()) },
  { method: "POST", body: "{malformed" },
  { method: "POST", body: JSON.stringify(history()), headers: { "content-type": "text/plain" } },
  { method: "POST", body: JSON.stringify(history()), headers: { "content-encoding": "gzip" } },
  { method: "POST", body: JSON.stringify({ previous_response_id: id("resp"), input: [null] }) },
]) test("unsupported bodies remain byte-identical with cleanup enabled: " + JSON.stringify(init.headers ?? init.method), async () => {
  assert.equal(await prepareRequest(url, init, repairOptions), init);
});

test("cleanup retains the existing four MiB UTF-8 inspection bound", async () => {
  const init = { method: "POST", body: JSON.stringify({ ...history(), extra: "\u4e2d".repeat(1_500_000) }) };
  assert.ok(init.body.length < 4 * 1024 * 1024);
  assert.equal(await prepareRequest(url, init, repairOptions), init);
});

test("cleanup and portable replay stay independently configurable through the provider loader", async t => {
  const options = {};
  const { hooks, calls } = await harness(t, options);
  const auth = account();
  const body = { store: true, input: [assistant(), { type: "reasoning", id: id("rs"), encrypted_content: "synthetic-opaque" }] };
  for (const repair of [false, true]) for (const portable of [false, true]) {
    Object.assign(options, { "codex-session-repair": repair, "portable-responses": portable, "text-filter": false });
    const loader = await hooks.auth.loader(async () => auth, { models: {} });
    await loader.fetch(url, { method: "POST", body: JSON.stringify(body) });
    const sent = calls.at(-1).init.body;
    const result = JSON.parse(sent);
    assert.equal(result.input.length, repair ? 1 : 2);
    assert.equal(result.input[0].id, repair || portable ? undefined : body.input[0].id);
    assert.equal(result.input[0].content[0].type, "output_text");
    assert.equal(result.input[0].content[0].text, "Checking the result.");
    assert.equal(result.store, !(repair || portable));
    if (!repair) assert.deepEqual(result.input[1], body.input[1]);
    assert.equal(body.input[0].content[0].text, "Checking the result.");
  }
});
