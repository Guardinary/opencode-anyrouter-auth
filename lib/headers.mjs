export const MODEL_HINT_HEADER = "x-anyrouter-account-model";

const CODEX_UA = "codex_exec/0.144.1 (Linux; x86_64) (codex_exec; 0.144.1)";
const CODEX_UA_RE = /^(?:codex_cli_rs|codex_exec)\//i;
const CLAUDE_UA = "claude-cli/2.1.226 (external, sdk-cli)";
const CLAUDE_BETA = "claude-code-20250219,context-1m-2025-08-07,interleaved-thinking-2025-05-14,thinking-token-count-2026-05-13,context-management-2025-06-27,prompt-caching-scope-2026-01-05,mid-conversation-system-2026-04-07,effort-2025-11-24";

export const BROWSER_HEADERS = Object.freeze({
  "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36",
  "accept": "application/json, text/plain, */*",
  "accept-language": "zh-CN,zh;q=0.9,en;q=0.8",
  "sec-ch-ua": "\"Chromium\";v=\"143\", \"Google Chrome\";v=\"143\", \"Not A(Brand\";v=\"24\"",
  "sec-ch-ua-mobile": "?0",
  "sec-ch-ua-platform": "\"macOS\"",
  "sec-fetch-dest": "empty",
  "sec-fetch-mode": "cors",
  "sec-fetch-site": "same-origin",
  "priority": "u=1, i"
});

export function browserHeaders() {
  return new Headers(BROWSER_HEADERS);
}

const RESERVED = new Set([
  "authorization", "proxy-authorization", "cookie", "set-cookie", "new-api-user",
  "x-api-key", "x-goog-api-key", "host", "content-length", "transfer-encoding", "connection", MODEL_HINT_HEADER
]);

export function customHeaders(value) {
  const result = new Headers();
  if (!value) return result;
  if (typeof value === "string") {
    for (const raw of value.split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith("#")) continue;
      const at = line.indexOf(":");
      if (at < 1) throw new Error("自定义请求头必须每行一条 Name: value。");
      result.set(line.slice(0, at).trim(), line.slice(at + 1).trim());
    }
  } else {
    new Headers(value).forEach((v, k) => result.set(k, v));
  }
  for (const name of result.keys()) {
    if (RESERVED.has(name)) throw new Error(`请求头 ${name} 由所选账号或传输层管理，不能自定义。`);
  }
  return result;
}

export function inferenceHeaders(account, incoming, protocol, compatibility = true) {
  // Model requests pass the gateway's native headers through; compatibility
  // restores the client identity AnyRouter accepts. Account custom headers stay
  // the final override for everything not managed here.
  const headers = new Headers(incoming);
  if (compatibility && protocol === "anthropic") {
    headers.set("user-agent", CLAUDE_UA);
    headers.set("x-app", "cli");
    headers.set("anthropic-version", "2023-06-01");
    headers.set("anthropic-beta", CLAUDE_BETA);
    headers.set("anthropic-dangerous-direct-browser-access", "true");
    headers.set("accept", "application/json");
  }
  if (compatibility && protocol === "responses") {
    if (!CODEX_UA_RE.test(headers.get("user-agent") ?? "")) headers.set("user-agent", CODEX_UA);
    if (!headers.has("originator")) headers.set("originator", "codex_exec");
    if (!headers.has("x-openai-internal-codex-responses-lite")) headers.set("x-openai-internal-codex-responses-lite", "true");
    if (!headers.has("x-codex-beta-features")) headers.set("x-codex-beta-features", "remote_compaction_v2");
    const session = headers.get("x-session-id");
    if (session) {
      if (!headers.has("session-id")) headers.set("session-id", session);
      if (!headers.has("thread-id")) headers.set("thread-id", session);
    }
  }
  customHeaders(account.headers).forEach((value, name) => headers.set(name, value));
  for (const name of ["authorization", "proxy-authorization", "cookie", "set-cookie", "new-api-user", "x-api-key", "x-goog-api-key", MODEL_HINT_HEADER]) {
    headers.delete(name);
  }
  if (protocol === "anthropic") headers.set("authorization", `Bearer ${account.key}`);
  else if (protocol === "gemini") headers.set("x-goog-api-key", account.key);
  else headers.set("authorization", `Bearer ${account.key}`);
  return headers;
}
