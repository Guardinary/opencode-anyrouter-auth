import assert from "node:assert/strict";
import test from "node:test";
import { BROWSER_HEADERS, browserHeaders, inferenceHeaders } from "../lib/headers.mjs";

const account = (extra = {}) => ({
  key: "sk-private-model-key",
  headers: "",
  ...extra,
});

test("Anthropic protocol sets Claude Code identity and replaces, then removes, incoming credentials", () => {
  const headers = inferenceHeaders(account(), {
    "x-api-key": "sk-old-key",
    authorization: "Bearer gateway-key",
    cookie: "session=secret",
    "new-api-user": "123",
  }, "anthropic");

  assert.equal(headers.get("authorization"), "Bearer sk-private-model-key");
  assert.equal(headers.has("x-api-key"), false, "x-api-key must not survive the Anthropic path");
  assert.equal(headers.get("cookie"), null);
  assert.equal(headers.get("new-api-user"), null);
  assert.equal(headers.get("user-agent"), "claude-cli/2.1.226 (external, sdk-cli)");
  assert.equal(headers.get("x-app"), "cli");
  assert.equal(headers.get("anthropic-version"), "2023-06-01");
  assert.equal(headers.get("anthropic-dangerous-direct-browser-access"), "true");
  assert.equal(headers.get("accept"), "application/json");

  const beta = headers.get("anthropic-beta");
  assert.match(beta, /(?:^|,)claude-code-20250219(?:,|$)/);
  assert.match(beta, /(?:^|,)context-1m-2025-08-07(?:,|$)/);
  assert.match(beta, /interleaved-thinking-2025-05-14/);
});

test("Responses protocol sets Codex identity, fills Responses Lite flags and mirrors x-session-id", () => {
  const headers = inferenceHeaders(account(), { "x-session-id": "session-42" }, "responses");

  assert.equal(headers.get("authorization"), "Bearer sk-private-model-key");
  assert.equal(headers.get("originator"), "codex_exec");
  assert.match(headers.get("user-agent"), /^codex_exec\/0\.144\.1 /);
  assert.equal(headers.get("x-openai-internal-codex-responses-lite"), "true");
  assert.equal(headers.get("x-codex-beta-features"), "remote_compaction_v2");
  assert.equal(headers.get("session-id"), "session-42");
  assert.equal(headers.get("thread-id"), "session-42");
});

test("Responses protocol preserves a recognized Codex UA and originator", () => {
  const headers = inferenceHeaders(account(), {
    "user-agent": "codex_cli_rs/0.153.0 (Windows 10.0.26100; x86_64) WindowsTerminal",
    originator: "codex_cli_rs",
    "x-session-id": "session-7",
  }, "responses");

  assert.equal(headers.get("user-agent"), "codex_cli_rs/0.153.0 (Windows 10.0.26100; x86_64) WindowsTerminal");
  assert.equal(headers.get("originator"), "codex_cli_rs");
  assert.equal(headers.get("session-id"), "session-7");
  assert.equal(headers.get("thread-id"), "session-7");
});

test("account custom headers override client defaults but cannot replace managed credentials", () => {
  const overridden = inferenceHeaders(account({
    headers: "User-Agent: custom-agent\nX-Account: alice\nOriginator: custom-origin",
  }), {}, "responses");
  assert.equal(overridden.get("user-agent"), "custom-agent");
  assert.equal(overridden.get("x-account"), "alice");
  assert.equal(overridden.get("originator"), "custom-origin");

  const anthropic = inferenceHeaders(account({
    headers: "User-Agent: anthropic-custom\nX-Account: bob",
  }), {}, "anthropic");
  assert.equal(anthropic.get("user-agent"), "anthropic-custom");
  assert.equal(anthropic.get("x-account"), "bob");

  for (const line of [
    "Authorization: Bearer stolen",
    "Cookie: session=stolen",
    "New-Api-User: 123",
    "X-Api-Key: sk-stolen",
  ]) {
    assert.throws(
      () => inferenceHeaders(account({ headers: line }), {}, "anthropic"),
      /由所选账号或传输层管理/,
      `${line} must be rejected rather than accepted as an account override`,
    );
  }
});

test("compatibility=false does not add any client identity on either protocol", () => {
  for (const protocol of ["anthropic", "responses"]) {
    const headers = inferenceHeaders(account(), {}, protocol, false);
    assert.equal(headers.get("user-agent"), null, `${protocol}: no added UA`);
    assert.equal(headers.get("x-app"), null, `${protocol}: no x-app`);
    assert.equal(headers.get("anthropic-version"), null, `${protocol}: no anthropic-version`);
    assert.equal(headers.get("anthropic-beta"), null, `${protocol}: no anthropic-beta`);
    assert.equal(headers.get("originator"), null, `${protocol}: no originator`);
    assert.equal(headers.get("x-openai-internal-codex-responses-lite"), null, `${protocol}: no Responses Lite flag`);
    assert.equal(headers.get("x-codex-beta-features"), null, `${protocol}: no x-codex-beta-features`);
    assert.equal(headers.get("authorization"), "Bearer sk-private-model-key", `${protocol}: credential still comes from account`);
  }
});

test("browserHeaders carries Chrome fingerprint fields but leaves origin/referer to the site client", () => {
  const headers = browserHeaders();

  assert.match(headers.get("user-agent"), /^Mozilla\/5\.0 .*Chrome\/143\.0\.0\.0 Safari\/537\.36$/);
  assert.equal(headers.get("accept"), "application/json, text/plain, */*");
  assert.equal(headers.get("accept-language"), "zh-CN,zh;q=0.9,en;q=0.8");
  assert.match(headers.get("sec-ch-ua"), /Chromium.*Google Chrome/);
  assert.equal(headers.get("sec-ch-ua-mobile"), "?0");
  assert.equal(headers.get("sec-ch-ua-platform"), "\"macOS\"");
  assert.equal(headers.get("sec-fetch-dest"), "empty");
  assert.equal(headers.get("sec-fetch-mode"), "cors");
  assert.equal(headers.get("sec-fetch-site"), "same-origin");
  assert.equal(headers.get("origin"), null);
  assert.equal(headers.get("referer"), null);
  assert.equal(BROWSER_HEADERS["user-agent"].includes("Chrome/143"), true);
});
