import { randomUUID } from "node:crypto";
import { isRecord, throwIfAborted } from "./safety.mjs";
import { redactResponsesBody } from "./content-filter.mjs";
import { readCloneText } from "./body-inspection.mjs";
import { repairSessionResources } from "./session-repair.mjs";

// Replay complete items inline instead of asking a load-balanced resource to
// retrieve them by an old item ID. Never remove call_id or opaque contents.
function isInlinePart(part) {
  if (!part || typeof part !== "object") return false;
  if (part.type === "input_text") return typeof part.text === "string" &&
    Object.keys(part).every(key => ["type", "text"].includes(key));
  if (part.type === "input_image") return typeof part.image_url === "string" && part.image_url.length > 0 &&
    Object.keys(part).every(key => ["type", "image_url", "detail"].includes(key)) &&
    (part.detail === undefined || ["auto", "low", "high", "original"].includes(part.detail));
  if (part.type === "input_file") return typeof part.file_data === "string" && part.file_data.length > 0 &&
    Object.keys(part).every(key => ["type", "file_data", "filename"].includes(key));
  // File IDs, unknown/signed fragments and audio resource objects are not
  // proven complete portable history. Their containing message stays intact.
  if (part.type !== "output_text" || typeof part.text !== "string") return false;
  // The gateway also emits logprobs: [] on ordinary completed text. Empty
  // probability metadata adds no content; populated or unknown data stays intact.
  return Object.keys(part).every(key => ["type", "text", "annotations", "logprobs"].includes(key)) &&
    (part.annotations == null || Array.isArray(part.annotations) && part.annotations.length === 0) &&
    (!Object.hasOwn(part, "logprobs") || Array.isArray(part.logprobs) && part.logprobs.length === 0);
}

function hasInlineContent(item) {
  if (!item || typeof item !== "object") return false;
  switch (item.type) {
    case undefined:
    case "message":
      return ["user", "assistant", "system", "developer"].includes(item.role) &&
        Object.keys(item).every(key => ["type", "id", "role", "content", "status", "phase"].includes(key)) &&
        (typeof item.content === "string" && item.content.length > 0 ||
          Array.isArray(item.content) && item.content.length > 0 && item.content.every(isInlinePart));
    case "function_call":
      return Object.keys(item).every(key => ["type", "id", "call_id", "name", "arguments", "status", "namespace"].includes(key)) &&
        typeof item.call_id === "string" && item.call_id.length > 0 &&
        typeof item.name === "string" && item.name.length > 0 && typeof item.arguments === "string";
    case "function_call_output":
      return Object.keys(item).every(key => ["type", "id", "call_id", "output", "status"].includes(key)) &&
        typeof item.call_id === "string" && item.call_id.length > 0 &&
        (typeof item.output === "string" || Array.isArray(item.output));
    // Reasoning IDs are required by the published input schema; encrypted
    // state has no cross-resource portability guarantee. Preserve it intact.
    case "reasoning":
      return false;
    default:
      return false;
  }
}

const MAX_BODY = 4 * 1024 * 1024;
const CLAUDE_DEVICE_ID = randomUUID();
const CODEX_INSTALLATION_ID = randomUUID();
const CLAUDE_SYSTEM_INTRO = "You are Claude Code, Anthropic's official CLI for Claude.";
const CLAUDE_AGENT_INTRO = "You are a Claude agent, built on Anthropic's Claude Agent SDK.";

async function inspectedJSON(input, init, path) {
  const request = input instanceof Request ? input : null;
  const signal = init.signal ?? request?.signal;
  throwIfAborted(signal);
  let url;
  try { url = new URL(request ? request.url : input); } catch { return null; }
  if (!path.test(url.pathname) || (init.method ?? request?.method ?? "GET").toUpperCase() !== "POST") return null;
  const headers = new Headers(request?.headers);
  new Headers(init.headers ?? {}).forEach((v, k) => headers.set(k, v));
  if (headers.has("content-encoding") && headers.get("content-encoding").toLowerCase() !== "identity") return null;
  const type = headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase();
  if (type && type !== "application/json" && !type.endsWith("+json")) return null;
  let text = init.body;
  if (text == null && request) text = await readCloneText(request, { maxBytes: MAX_BODY, timeoutMs: 2000, signal });
  throwIfAborted(signal);
  if (typeof text !== "string" || text.length > MAX_BODY || new TextEncoder().encode(text).byteLength > MAX_BODY) return null;
  let body;
  try { body = JSON.parse(text); } catch { return null; }
  return isRecord(body) ? { body, url, headers, signal } : null;
}
function changedBodyHeaders(headers) {
  for (const name of ["content-length", "content-md5", "digest", "content-digest"]) headers.delete(name);
}
export async function prepareAnthropicRequest(input, init = {}, { compatibility = true } = {}) {
  if (!compatibility) return init;
  const parsed = await inspectedJSON(input, init, /\/messages\/?$/);
  if (!parsed) return init;
  const { body, url, headers } = parsed;
  if (body.metadata !== undefined && !isRecord(body.metadata)) return init;
  let changed = false;
  if (typeof body.system === "string" && body.system.trim()) {
    body.system = [
      { type: "text", text: CLAUDE_SYSTEM_INTRO },
      { type: "text", text: CLAUDE_AGENT_INTRO, cache_control: { type: "ephemeral" } },
      { type: "text", text: body.system, cache_control: { type: "ephemeral" } },
    ]; changed = true;
  }
  const sessionId = headers.get("x-claude-code-session-id") || headers.get("x-session-id") || randomUUID();
  headers.set("x-claude-code-session-id", sessionId);
  if (body.context_management === undefined) { body.context_management = { edits: [{ type: "clear_thinking_20251015", keep: "all" }] }; changed = true; }
  if (body.metadata === undefined) body.metadata = {};
  if (body.metadata.user_id === undefined) { body.metadata.user_id = JSON.stringify({ device_id: CLAUDE_DEVICE_ID, account_uuid: "", session_id: sessionId }); changed = true; }
  const original = url.href;
  if (!url.searchParams.has("beta")) url.searchParams.set("beta", "true");
  if (changed) changedBodyHeaders(headers);
  return { ...init, headers, ...(changed ? { body: JSON.stringify(body) } : {}), ...(url.href !== original ? { url: url.href } : {}) };
}

export async function prepareCodexRequest(input, init = {}) {
  const parsed = await inspectedJSON(input, init, /\/responses$/);
  if (!parsed) return init;
  const { body, headers } = parsed;
  if (body.client_metadata !== undefined && !isRecord(body.client_metadata)) return init;
  let changed = false;
  const sessionId = headers.get("session-id") || headers.get("x-session-id") || body.prompt_cache_key || randomUUID();
  const threadId = headers.get("thread-id") || sessionId, turnId = randomUUID();
  const windowId = headers.get("x-codex-window-id") || `${sessionId}:0`;
  const turnMetadata = headers.get("x-codex-turn-metadata") || JSON.stringify({
    installation_id: CODEX_INSTALLATION_ID, session_id: sessionId, thread_id: threadId, turn_id: turnId,
    window_id: windowId, request_kind: "turn", thread_source: "user", turn_started_at_unix_ms: Date.now(),
  });
  if (typeof body.input === "string") {
    body.input = [{ type: "message", role: "user", content: [{ type: "input_text", text: body.input }] }]; changed = true;
  } else if (Array.isArray(body.input)) {
    for (const item of body.input) {
      if (!isRecord(item) || item.type !== undefined && item.type !== "message" ||
          Object.keys(item).some(key => !["type", "id", "role", "content", "phase", "status"].includes(key)) ||
          !["user", "assistant", "developer", "system"].includes(item.role) || typeof item.content !== "string") continue;
      item.content = item.role === "assistant" ? [{type:"output_text",text:item.content,annotations:[]}] : [{type:"input_text",text:item.content}]; changed = true;
    }
  }
  const fill = (key, value) => { if (!Object.hasOwn(body, key)) { body[key] = value; changed = true; } };
  fill("prompt_cache_key", sessionId);
  fill("client_metadata", { session_id:sessionId, thread_id:threadId, turn_id:turnId,
    "x-codex-installation-id":CODEX_INSTALLATION_ID, "x-codex-window-id":windowId, "x-codex-turn-metadata":turnMetadata });
  // Never invent a reasoning effort or overwrite an explicit reasoning object.
  fill("stream", true); fill("store", false); fill("tool_choice", "auto"); fill("parallel_tool_calls", false);
  fill("text", {verbosity:"low"}); fill("include", ["reasoning.encrypted_content"]);
  if (!Object.hasOwn(body, "max_output_tokens") && Number.isSafeInteger(body.max_tokens) && body.max_tokens > 0) {
    body.max_output_tokens = body.max_tokens; delete body.max_tokens; changed = true;
  }
  for (const [name,value] of Object.entries({"x-codex-window-id":windowId,"x-codex-turn-metadata":turnMetadata,"x-client-request-id":sessionId,"session-id":sessionId,"thread-id":threadId})) {
    if (!headers.has(name)) headers.set(name, value);
  }
  if (changed) changedBodyHeaders(headers);
  return { ...init, headers, ...(changed ? {body:JSON.stringify(body)} : {}) };
}

export async function prepareResponsesRequest(input, init = {}) {
  return prepareRequest(input, init);
}

export async function prepareRequest(input, init = {}, { portableResponses = true, textFilter = null, sessionRepair = false } = {}) {
  throwIfAborted(init.signal ?? (input instanceof Request ? input.signal : undefined));
  if (!portableResponses && !textFilter && !sessionRepair) return init;
  const request = input instanceof Request ? input : null;
  let pathname;
  try { pathname = new URL(request ? request.url : input).pathname; } catch { return init; }
  if (!pathname.endsWith("/responses") || (init.method ?? request?.method ?? "GET").toUpperCase() !== "POST") return init;
  const headers = new Headers(request?.headers);
  new Headers(init.headers ?? {}).forEach((v, k) => headers.set(k, v));
  if (headers.has("content-encoding") && headers.get("content-encoding").toLowerCase() !== "identity") return init;
  const mediaType = headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase();
  if (mediaType && mediaType !== "application/json" && !mediaType.endsWith("+json")) return init;
  let text = init.body;
  if (text == null && request) text = await readCloneText(request, {
    maxBytes: MAX_BODY, timeoutMs: 2000, signal: init.signal ?? request.signal,
  });
  throwIfAborted(init.signal ?? request?.signal);
  if (typeof text !== "string" || text.length > MAX_BODY || new TextEncoder().encode(text).byteLength > MAX_BODY) return init;
  let body;
  try { body = JSON.parse(text); } catch { return init; }
  if (!body || typeof body !== "object" || Array.isArray(body)) return init;
  const repaired = sessionRepair === true ? repairSessionResources(body) : { body, changed: false };
  body = repaired.body;
  const filtered = redactResponsesBody(body, textFilter);
  body = filtered.body;
  const replayed = portableResponses && replayInline(body);
  if (!repaired.changed && !filtered.replacements && !replayed) return init;
  if (repaired.changed || replayed) body.store = false;
  for (const name of ["content-length", "content-md5", "digest", "content-digest"]) headers.delete(name);
  return { ...init, body: JSON.stringify(body), headers };
}

function replayInline(body) {
  // Pointers carry context we cannot retrieve. Filtering visible prose must not
  // silently discard that context or turn a continuation into a new conversation.
  if (!Array.isArray(body.input) || body.previous_response_id || body.conversation ||
      body.input.some(item => item?.type === "item_reference")) return false;
  let changed = false;
  for (const item of body.input) {
    if (!hasInlineContent(item) || !Object.hasOwn(item, "id")) continue;
    delete item.id;
    if (item.type === "message" || item.type == null) {
      // Output-message input objects require an ID. Convert to the supported
      // EasyInputMessage form, preserving phase and every actual text segment.
      // Assistant history keeps output_text and its metadata; other roles use input_text.
      delete item.status;
      if (item.role !== "assistant" && Array.isArray(item.content)) item.content = item.content.map(part =>
        part.type === "output_text" ? { type: "input_text", text: part.text } : part);
    }
    changed = true;
  }
  return changed;
}
