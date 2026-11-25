import { readCloneText } from "./body-inspection.mjs";
import { isRecord, redactedMessage, throwIfAborted } from "./safety.mjs";

// Some relays commit HTTP 200 before they know whether a model can answer.
// Inspect only the bounded SSE prelude, before any answer or tool call escapes.
// Success (including its original bytes), unknown events, and late failures pass
// through. Never retry here: magpie owns routing, the caller owns cancellation.
const PRELUDE_BYTES = 64 * 1024;
const PRELUDE_MS = 15_000;
const DEFAULT_RETRY_AFTER_SECONDS = 10;
const TOKEN_RATE_LIMIT = /exceeded\s+token\s+rate\s+limit/i;
const TRANSIENT_STATUSES = [429, 500, 502, 503, 504];
const TRANSIENT_CODES = ["rate_limit_exceeded", "server_error", "overloaded_error", "high_demand"];

const messageText = value => typeof value.message === "string" && value.message
  ? value.message : typeof value.msg === "string" ? value.msg : "";
const numericCode = value => typeof value === "number" ? value
  : typeof value === "string" && /^\d{3}$/.test(value) ? Number(value) : null;

function hasNestedError(value) {
  return value != null && typeof value === "object" && !Array.isArray(value) &&
    ("error" in value || (value.response != null && typeof value.response === "object" && "error" in value.response));
}

function hasErrorDetail(value) {
  return value != null && (messageText(value).trim().length > 0 || value.code === "content-blocked" ||
    [value.status, value.status_code, value.code].some(code => TRANSIENT_STATUSES.includes(numericCode(code))) ||
    [value.code, value.type].some(code => TRANSIENT_CODES.includes(code)));
}

function inheritErrorStatus(ancestor, detail) {
  if (!hasErrorDetail(detail)) return null;
  const status = Object.fromEntries(["status", "status_code", "code"]
    .filter(key => TRANSIENT_STATUSES.includes(numericCode(ancestor[key])))
    .map(key => [key, ancestor[key]]));
  return { ...status, ...detail };
}

function errorDetail(value, depth = 0) {
  if (depth > 4 || value == null) return null;
  if (typeof value === "string") {
    try { return errorDetail(JSON.parse(value), depth + 1); }
    catch { return { message: value }; }
  }
  if (typeof value !== "object" || Array.isArray(value)) return null;
  const message = messageText(value);
  const detail = message ? { ...value, message } : value;
  if (hasNestedError(value)) {
    const nested = errorDetail(value.error ?? value.response?.error, depth + 1);
    return inheritErrorStatus(value, nested);
  }
  if (!message) return detail;
  let encoded;
  try { encoded = JSON.parse(message); } catch { return detail; }
  const nested = errorDetail(encoded, depth + 1);
  // Exhaustion or an invalid encoded detail is not permission to use a partial parent.
  return inheritErrorStatus(value, nested);
}

function streamHeaders(original) {
  const h = new Headers(original);
  for (const k of ["content-length", "content-encoding", "transfer-encoding", "etag", "content-md5", "digest", "content-digest", "repr-digest"]) h.delete(k);
  return h;
}

function changedHeaders(original) {
  const h = new Headers(original);
  h.set("content-type", "application/json");
  // Fetch exposes decoded bytes, and the new body has a different length.
  for (const k of ["content-length", "content-encoding", "transfer-encoding", "etag", "content-md5", "digest", "content-digest", "repr-digest"]) h.delete(k);
  return h;
}

function retrySeconds(value) {
  const seconds = typeof value === "string" && /^[0-9]+$/.test(value.trim()) ? Number(value.trim()) : value;
  return Number.isSafeInteger(seconds) && seconds > 0 ? seconds : DEFAULT_RETRY_AFTER_SECONDS;
}

function rateLimitHeaders(original, retryAfterSeconds) {
  const headers = changedHeaders(original);
  // Explicit upstream waits take precedence, including millisecond hints.
  if (!["retry-after", "retry-after-ms", "x-ms-retry-after-ms"].some(name => headers.has(name))) {
    headers.set("retry-after", String(retryAfterSeconds));
  }
  return headers;
}

function isBusinessError(e, depth = 0) {
  if (depth > 4 || e == null) return false;
  if (typeof e === "string") {
    try { return isBusinessError(JSON.parse(e), depth + 1); }
    catch { return isBusinessError({ message: e }, depth + 1); }
  }
  if (typeof e !== "object" || Array.isArray(e)) return false;
  if (isBusinessError(e.error ?? e.response?.error, depth + 1)) return true;
  const message = messageText(e);
  if (message) {
    try { if (isBusinessError(JSON.parse(message), depth + 1)) return true; } catch {}
  }
  if ([e.status, e.status_code, e.code].some(value => [401, 402, 403].includes(numericCode(value)))) return true;
  const tags = [e.code, e.type].filter(value => typeof value === "string").join(" ");
  if (/auth|permission|forbidden|invalid_api_key|quota|balance|billing|payment|content[-_]?(policy|filter|blocked)|moderation|safety/i.test(tags)) return true;
  return /invalid.{0,12}api.?key|unauthenticated|unauthorized|authentication|permission denied|forbidden|quota|balance|billing|payment required|content policy|content filter/i.test(message);
}

function diagnosticCode(value, fallback, account) {
  if (typeof value === "string") return redactedMessage(value, account).slice(0, 128);
  return Number.isSafeInteger(value) ? value : fallback;
}

function transientFailureResponse(e, originalHeaders, retryAfterSeconds, account) {
  const numericStatus = [e.status, e.status_code, e.code].map(numericCode).find(value =>
    TRANSIENT_STATUSES.includes(value));
  const code = [e.code, e.type].find(value =>
    TRANSIENT_CODES.includes(value));
  const rateLimited = numericStatus === 429 || code === "rate_limit_exceeded";
  const busy = code === "overloaded_error" || code === "high_demand" ||
    /currently experiencing high demand/i.test(e.message ?? "");
  const status = numericStatus ?? (rateLimited ? 429 : busy ? 503 : code === "server_error" ? 500 : null);
  if (!status) return null;
  return new Response(JSON.stringify({ error: {
    code: diagnosticCode(e.code, status, account),
    type: rateLimited ? "anyrouter_upstream_rate_limit" : busy ? "anyrouter_upstream_busy" : "anyrouter_upstream_error",
    message: rateLimited
      ? "AnyRouter 上游报告了速率限制。请按 Retry-After 或上游等待提示重试；插件未自动重试。"
      : busy ? "AnyRouter 上游当前繁忙。请稍后再试；插件未自动重试。"
        : "AnyRouter 上游报告了暂时性服务错误。请稍后再试；插件未自动重试。",
    upstream: redactedMessage(typeof e.message === "string" ? e.message : "", account),
  } }), { status, headers: status === 429 ? rateLimitHeaders(originalHeaders, retryAfterSeconds) : changedHeaders(originalHeaders) });
}

function failureResponse(value, originalHeaders, retryAfterSeconds, account) {
  const e = hasNestedError(value)
    ? inheritErrorStatus(value, errorDetail(value.error ?? value.response?.error, 1))
    : errorDetail(value);
  if (!e) return null;
  const message = typeof e.message === "string" ? e.message : "";
  const blocked = e.code === "content-blocked";
  const foreignItem = /requested item was created under a different[^.]{0,100}OpenAI resource/i.test(message);
  if (!blocked && !foreignItem && (isBusinessError(value) || isBusinessError(e))) return null;
  const capped = !blocked && !foreignItem && TOKEN_RATE_LIMIT.test(message);
  if (!capped && !blocked && !foreignItem) return transientFailureResponse(e, originalHeaders, retryAfterSeconds, account);
  const headers = capped ? rateLimitHeaders(originalHeaders, retryAfterSeconds) : changedHeaders(originalHeaders);
  const wait = headers.get("retry-after");
  const waitHint = /^[0-9]+$/.test(wait ?? "") ? `${wait} 秒后再试` : "按上游等待提示重试";
  const model = /requests to (\S+) for \S+/i.exec(message)?.[1];
  const id = /request id:\s*([A-Za-z0-9]+)/i.exec(message)?.[1];
  const trace = /trace_id[=:]([A-Za-z0-9_-]{1,128})/.exec(message)?.[1];
  const note = capped
    ? `AnyRouter${model ? ` 的 ${model}` : ""} 达到了上游 token 速率上限。请${waitHint}，不保证届时已恢复。不要立即重发同一请求。`
    : foreignItem
      ? `AnyRouter 的 Responses 历史条目属于另一个 OpenAI 资源${trace ? ` [trace_id=${trace}]` : ""}。请由客户端重发完整内联历史（store:false），或固定到创建该条目的同一上游资源；仅有 previous_response_id / item_reference 或不兼容的加密状态时，插件不能无损恢复。未自动重试。`
      : `AnyRouter 的内容过滤器拒绝了这段请求内容${id ? ` (request id: ${id})` : ""}。请改写被拒的部分，或改用其他服务商。`;
  return new Response(JSON.stringify({ error: {
    code: diagnosticCode(e.code, capped ? "token_rate_limit" : foreignItem ? "resource_mismatch" : "content-blocked", account),
    message: redactedMessage(note, account),
    type: capped ? "anyrouter_token_rate_limit" : foreignItem ? "anyrouter_resource_mismatch" : "anyrouter_content_blocked",
    upstream: redactedMessage(message, account),
  } }), { status: capped ? 429 : 400, headers });
}

function emptyResponse(headers) {
  return new Response(JSON.stringify({ error: {
    code: "empty_response",
    type: "anyrouter_empty_response",
    message: "AnyRouter 返回了空的完成事件（没有输出且用量为零），本次没有得到有效回答。",
  } }), { status: 502, headers: changedHeaders(headers) });
}

function hasArrayOutput(value) {
  return value !== undefined && (!Array.isArray(value) || value.length > 0);
}

function hasStringOutput(value) {
  return value !== undefined && (typeof value !== "string" || value.length > 0);
}

function hasPartOutput(part) {
  if (!part || typeof part !== "object") return true;
  if (!["output_text", "summary_text", "refusal"].includes(part.type)) return true;
  if (Object.keys(part).some(key => !["type", "text", "refusal", "annotations", "logprobs"].includes(key))) return true;
  return hasStringOutput(part.text) || hasStringOutput(part.refusal) ||
    hasArrayOutput(part.annotations) || hasArrayOutput(part.logprobs);
}

function hasOutput(item) {
  if (!item || typeof item !== "object") return true;
  if (item.type !== "message" && item.type !== "reasoning") return true;
  if (Object.keys(item).some(key => !["type", "id", "role", "status", "content", "summary"].includes(key))) return true;
  for (const key of ["content", "summary"]) {
    if (item[key] !== undefined && (!Array.isArray(item[key]) || item[key].some(hasPartOutput))) return true;
  }
  return false;
}

function hasChatOutput(choice) {
  if (!choice || typeof choice !== "object") return true;
  if (Object.keys(choice).some(key => !["index", "delta", "message", "finish_reason", "logprobs"].includes(key))) return true;
  const delta = choice.delta ?? choice.message ?? {};
  if (!delta || typeof delta !== "object" || Array.isArray(delta)) return true;
  if (Object.keys(delta).some(key => !["role", "content", "refusal", "reasoning", "reasoning_content", "tool_calls", "function_call"].includes(key))) return true;
  return (delta.role !== undefined && delta.role !== "assistant") ||
    [delta.content, delta.refusal, delta.reasoning, delta.reasoning_content].some(hasStringOutput) ||
    hasArrayOutput(delta.tool_calls) || (delta.function_call !== undefined && delta.function_call !== null) ||
    (choice.finish_reason !== undefined && choice.finish_reason !== null && choice.finish_reason !== "") ||
    (choice.logprobs !== undefined && choice.logprobs !== null);
}

function hasAnthropicOutput(block) {
  if (!isRecord(block)) return true;
  if (block.type !== "text" && block.type !== "thinking") return true;
  const field = block.type === "text" ? "text" : "thinking";
  if (Object.keys(block).some(k => !["type", field, "signature"].includes(k))) return true;
  return typeof block[field] !== "string" || block[field].length > 0 || hasStringOutput(block.signature);
}
function hasSemanticOutput(value, depth = 0) {
  // Unknown wrapper depth is not proof of an empty result. Release it without
  // recursively walking an attacker-controlled tree up to the call-stack limit.
  if (depth > 8) return true;
  if (!isRecord(value)) return false;
  for (const key of ["output", "content", "choices", "candidates"]) {
    if (!Object.hasOwn(value, key)) continue;
    const data = value[key];
    if (!Array.isArray(data)) return true;
    if (key === "output" ? data.some(hasOutput) : key === "choices" ? data.some(hasChatOutput) : key === "content" ? data.some(hasAnthropicOutput) : data.length > 0) return true;
  }
  if (isRecord(value.response) && hasSemanticOutput(value.response, depth + 1)) return true;
  if (isRecord(value.message) && hasSemanticOutput(value.message, depth + 1)) return true;
  if (Object.hasOwn(value, "content_block") && hasAnthropicOutput(value.content_block)) return true;
  return false;
}
const onlyKeys = (value, keys) => isRecord(value) && Object.keys(value).every(key => keys.includes(key));
const count = value => Number.isSafeInteger(value) && value >= 0;
function provenUsage(value) {
  if (value === undefined || value === null) return true;
  const counts = ["input_tokens", "output_tokens", "total_tokens", "cache_creation_input_tokens", "cache_read_input_tokens"];
  if (!onlyKeys(value, [...counts, "input_tokens_details", "output_tokens_details", "cache_creation", "server_tool_use", "service_tier"])) return false;
  if (counts.some(key => value[key] !== undefined && !count(value[key]))) return false;
  for (const [name, fields] of Object.entries({ input_tokens_details: ["cached_tokens"], output_tokens_details: ["reasoning_tokens"],
    cache_creation: ["ephemeral_5m_input_tokens", "ephemeral_1h_input_tokens"], server_tool_use: ["web_search_requests", "web_fetch_requests"] })) {
    const nested = value[name];
    if (nested !== undefined && (!onlyKeys(nested, fields) || Object.values(nested).some(v => !count(v)))) return false;
  }
  return value.service_tier === undefined || typeof value.service_tier === "string";
}
function provenEmptyUsage(value) {
  if (!provenUsage(value) || value?.input_tokens !== 0 || value?.output_tokens !== 0) return false;
  return Object.entries(value).every(([name, data]) => name === "service_tier" || data === 0 ||
    isRecord(data) && Object.values(data).every(n => n === 0));
}
function provenResponsePrelude(type, value) {
  const keys = {
    "response.created": ["type", "response", "sequence_number"],
    "response.in_progress": ["type", "response", "sequence_number"],
    "response.completed": ["type", "response", "sequence_number"],
    "response.output_item.added": ["type", "item", "output_index", "sequence_number"],
    "response.output_item.done": ["type", "item", "output_index", "sequence_number"],
    "response.content_part.added": ["type", "part", "item_id", "output_index", "content_index", "sequence_number"],
  }[type];
  if (!keys || !onlyKeys(value, keys) || value.sequence_number !== undefined && !count(value.sequence_number)) return false;
  if (["response.created", "response.in_progress", "response.completed"].includes(type)) {
    const r = value.response;
    if (!onlyKeys(r, ["id", "object", "created_at", "status", "error", "incomplete_details", "instructions", "max_output_tokens", "model", "output", "parallel_tool_calls", "previous_response_id", "reasoning", "store", "temperature", "text", "tool_choice", "tools", "top_p", "truncation", "usage", "user", "metadata"])) return false;
    if (!Array.isArray(r.output) || r.output.some(hasOutput) || r.error != null || r.incomplete_details != null || !provenUsage(r.usage)) return false;
    const stringOrNull = data => data == null || typeof data === "string";
    for (const name of ["id", "model", "instructions", "previous_response_id", "user", "truncation"]) if (!stringOrNull(r[name])) return false;
    if (r.object != null && r.object !== "response" || r.created_at != null && !count(r.created_at)) return false;
    for (const name of ["parallel_tool_calls", "store"]) if (r[name] != null && typeof r[name] !== "boolean") return false;
    if (r.max_output_tokens != null && !count(r.max_output_tokens)) return false;
    for (const name of ["temperature", "top_p"]) if (r[name] != null && (typeof r[name] !== "number" || !Number.isFinite(r[name]))) return false;
    // Complex/future config shapes are not proof of an empty prelude. Releasing
    // them is safer than discarding a signed state disguised as a known field.
    if (r.tools != null && (!Array.isArray(r.tools) || r.tools.length)) return false;
    if (r.tool_choice != null && !["auto", "none", "required"].includes(r.tool_choice)) return false;
    if (r.metadata != null && (!isRecord(r.metadata) || Object.keys(r.metadata).length)) return false;
    if (r.reasoning != null && (!onlyKeys(r.reasoning, ["effort", "summary"]) || !Object.values(r.reasoning).every(stringOrNull))) return false;
    if (r.text != null) {
      if (!onlyKeys(r.text, ["format", "verbosity"]) || !stringOrNull(r.text.verbosity)) return false;
      if (r.text.format != null && (!onlyKeys(r.text.format, ["type"]) || r.text.format.type !== "text")) return false;
    }
    return r.status === undefined || (type === "response.completed" ? ["completed"] : ["queued", "in_progress"]).includes(r.status);
  }
  if (value.output_index !== undefined && !count(value.output_index) || value.content_index !== undefined && !count(value.content_index)) return false;
  return type === "response.content_part.added" ? isRecord(value.part) && !hasPartOutput(value.part) : isRecord(value.item) && !hasOutput(value.item);
}
function provenAnthropicPrelude(type, value) {
  const allowed = {
    message_start: ["type", "message"], ping: ["type"],
    content_block_start: ["type", "index", "content_block"], content_block_stop: ["type", "index"],
    message_delta: ["type", "delta", "usage"],
  }[type];
  if (!allowed || Object.keys(value).some(k => !allowed.includes(k))) return false;
  if (type === "message_start") {
    const m = value.message;
    return isRecord(m) && Array.isArray(m.content) && m.content.length === 0 &&
      Object.keys(m).every(k => ["id", "type", "role", "content", "model", "stop_reason", "stop_sequence", "usage"].includes(k)) &&
      (m.type === undefined || m.type === "message") && (m.role === undefined || m.role === "assistant") &&
      !m.stop_reason && !m.stop_sequence && provenUsage(m.usage);
  }
  if (type === "content_block_start") return count(value.index) && !hasAnthropicOutput(value.content_block);
  if (type === "message_delta") return onlyKeys(value.delta, ["stop_reason", "stop_sequence"]) &&
    !value.delta.stop_reason && !value.delta.stop_sequence && provenUsage(value.usage);
  return type !== "content_block_stop" || count(value.index);
}

// null means proven harmless prelude; true means release unchanged; Response is
// an explicit early failure. Semantic or opaque contents win over error rewriting.
function inspectEvent(frame, headers, retryAfterSeconds, account) {
  const lines = frame.split(/\r\n|\n|\r/);
  let name;
  const dataLines = [];
  for (const line of lines) {
    const colon = line.indexOf(":");
    const field = colon < 0 ? line : line.slice(0, colon);
    const value = colon < 0 ? "" : line.slice(colon + 1).replace(/^ /, "");
    if (field === "event") name = value; // SSE uses the last field, including an empty one.
    if (field === "data") dataLines.push(value);
  }
  const data = dataLines.join("\n");
  if (!data) return lines.every(line => !line || line.startsWith(":")) ? null : true;
  if (data === "[DONE]") return true;
  let j;
  try { j = JSON.parse(data); } catch { return true; }
  if (!j || typeof j !== "object") return true;
  const type = j.type ?? name;
  const knownTypes = ["message", "error", "response.failed", "response.completed", "response.created", "response.in_progress", "response.output_item.added", "response.output_item.done", "response.content_part.added",
    "message_start", "content_block_start", "content_block_delta", "content_block_stop", "message_delta", "message_stop", "ping"];
  const namedFailure = name === "error" || name === "response.failed";
  if (name && !knownTypes.includes(name)) return true;
  if (!namedFailure && type && !knownTypes.includes(type)) return true;
  if (hasSemanticOutput(j)) return true;
  if (typeof j.delta === "string" && j.delta) return true;
  // Anthropic content_block_delta carries an object, not a string.
  if (j.type === "content_block_delta" && j.delta && typeof j.delta === "object" &&
      (typeof j.delta.text === "string" || typeof j.delta.thinking === "string" ||
       typeof j.delta.partial_json === "string" || typeof j.delta.signature === "string")) return true;
  if (j.item && hasOutput(j.item)) return true;
  if (j.part && hasPartOutput(j.part)) return true;
  if (Array.isArray(j.response?.output) && j.response.output.some(hasOutput)) return true;
  if (Array.isArray(j.choices) && j.choices.some(hasChatOutput)) return true;
  const error = j.error ?? j.response?.error ?? ((type === "error" || type === "response.failed" || name === "error" || name === "response.failed") ? j : null);
  if (error) return failureResponse(j, headers, retryAfterSeconds, account) ?? true;
  if (type === "response.completed") {
    const r = j.response;
    if (provenResponsePrelude(type, j) && r?.status === "completed" && r.output.length === 0 &&
        provenEmptyUsage(r.usage)) return emptyResponse(headers);
    return true;
  }
  if (Array.isArray(j.choices) && onlyKeys(j, ["id", "object", "created", "model", "choices", "usage", "system_fingerprint", "service_tier"]) && provenUsage(j.usage)) return null;
  if (provenAnthropicPrelude(type, j) || provenResponsePrelude(type, j)) return null;
  return true; // unknown protocol or event: fail open, not data loss
}

// CR ends a line immediately; a following LF (even in the next chunk) belongs
// to that same ending. This also handles legal mixed newline event separators.
function eventScanner(headers, retryAfterSeconds, account) {
  let line = "", lines = [], afterCR = false;
  return text => {
    for (const char of text) {
      if (afterCR && char === "\n") { afterCR = false; continue; }
      afterCR = false;
      if (char !== "\r" && char !== "\n") { line += char; continue; }
      afterCR = char === "\r";
      if (line) { lines.push(line); line = ""; continue; }
      const result = inspectEvent(lines.join("\n"), headers, retryAfterSeconds, account);
      lines = [];
      if (result !== null) return result;
    }
    return null;
  };
}

async function inspectStream(res, retryAfterSeconds, signal, account) {
  throwIfAborted(signal);
  if (!res.body) return res;
  const reader = res.body.getReader();
  const chunks = [];
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const scan = eventScanner(res.headers, retryAfterSeconds, account);
  let bytes = 0, inflight, timer;
  const expired = new Promise(resolve => { timer = setTimeout(() => resolve(null), PRELUDE_MS); });
  let transferred = false, onAbort;
  const cleanup = () => signal?.removeEventListener("abort", onAbort);
  const cancel = reason => { cleanup(); void reader.cancel(reason).catch(() => {}); };
  const stopped = new Promise((_, reject) => {
    onAbort = () => { cancel(signal.reason); reject(signal.reason); };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
  // Keep the in-flight read if the inspection deadline expires. A fresh read
  // would skip that chunk; a tee/clone would buffer an unbounded unused branch.
  try {
    while (true) {
      inflight = reader.read();
      const next = await Promise.race([inflight, expired, stopped]);
      throwIfAborted(signal);
      if (next === null) break;
      inflight = null;
      if (next.done) break;
      chunks.push(next.value);
      bytes += next.value.byteLength;
      if (bytes > PRELUDE_BYTES) break;
      let text;
      try { text = decoder.decode(next.value, { stream: true }); }
      catch { return replay(); } // Invalid encoding is unknown data, not a synthetic error.
      const result = scan(text);
      if (result instanceof Response) { cancel("early upstream failure"); return result; }
      if (result === true) return replay();
    }
    return replay();
  } catch (error) {
    cancel(error);
    throw error;
  } finally {
    clearTimeout(timer);
    if (!transferred) cleanup();
  }

  function replay() {
    transferred = true;
    let i = 0;
    return new Response(new ReadableStream({
      async pull(controller) {
        try {
          throwIfAborted(signal);
          if (i < chunks.length) { controller.enqueue(chunks[i++]); return; }
          const next = await Promise.race([inflight ?? reader.read(), stopped]);
          throwIfAborted(signal);
          inflight = null;
          if (next.done) { cleanup(); reader.releaseLock(); controller.close(); }
          else controller.enqueue(next.value);
        } catch (error) { cancel(error); controller.error(error); }
      },
      cancel,
    }), { status: res.status, statusText: res.statusText, headers: streamHeaders(res.headers) });
  }
}

export async function explainResponse(res, { retryAfterSeconds, signal, account } = {}) {
  throwIfAborted(signal);
  if (!res) return res;
  const waitSeconds = retrySeconds(retryAfterSeconds);
  const redactionAccount = isRecord(account) ? account : {};
  const type = res.headers.get("content-type") ?? "";
  if (res.status === 200 && /text\/event-stream/i.test(type)) return inspectStream(res, waitSeconds, signal, redactionAccount);
  if (![200, 400, 429].includes(res.status)) return res;
  // Only generated diagnostics are redacted. Semantic/opaque responses remain
  // upstream bytes: silently scrubbing model output would violate preservation.
  if (res.status === 200 && !/\bjson\b/i.test(type)) return res;
  const text = await readCloneText(res, { maxBytes: 64 * 1024, timeoutMs: 2000, signal });
  throwIfAborted(signal);
  if (text === null) return res;
  let j;
  try { j = JSON.parse(text); } catch { return res; }
  if (hasSemanticOutput(j)) return res;
  const error = j?.error ?? j?.response?.error ??
    ((res.status >= 400 || j?.type === "error" || j?.type === "response.failed") ? j : null);
  return error ? failureResponse(j, res.headers, waitSeconds, redactionAccount) ?? res : res;
}
