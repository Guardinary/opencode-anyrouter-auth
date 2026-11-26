import { createHash } from "node:crypto";
import { isRecord, redactedMessage } from "./safety.mjs";

const HOUR = 3600000, MAX_CALLS = 512, MAX_SCOPES = 64, FRAME_LIMIT = 65536, READ_LIMIT = 4 * 1024 * 1024;
const count = value => Number.isSafeInteger(value) && value >= 0;
const validModel = value => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,255}$/.test(value);
const scopeOf = account => createHash("sha256").update(JSON.stringify([account.siteURL, account.userId, account.key, account.loginGeneration])).digest("hex");
const fingerprint = call => JSON.stringify([call.model, call.in, call.out, call.cache_read, call.cache_write]);

export function modelForCall(url, body, hint) {
  const native = new URL(url).pathname.match(/\/models\/([^:]+):/);
  if (native) return native[1];
  if (typeof body === "string" && Buffer.byteLength(body) <= FRAME_LIMIT) {
    try { const model = JSON.parse(body).model; if (validModel(model)) return model; } catch {}
  }
  return validModel(hint) ? hint : undefined;
}

function countsFrom(value, protocol, state) {
  if (!isRecord(value)) return null;
  const detail = value.type === "response.completed" ? value.response : value;
  if (value.error || detail?.error || ["incomplete", "failed"].includes(detail?.status) || detail?.incomplete_details != null ||
      ["error", "response.failed", "response.incomplete"].includes(value.type)) { state.failed = true; return null; }
  if (protocol === "anthropic") {
    if (value.type === "message_start") state.anthropic = value.message?.usage;
    if (value.type === "message_delta" && isRecord(state.anthropic)) state.anthropic = { ...state.anthropic, output_tokens: value.usage?.output_tokens };
    if (value.type === "message_stop") state.complete = true;
    const usage = value.type ? state.anthropic : value.usage;
    if (!value.type) state.complete = true;
    if (!isRecord(usage)) return null;
    return [usage.input_tokens, usage.output_tokens, usage.cache_read_input_tokens, usage.cache_creation_input_tokens];
  }
  if (protocol === "gemini") {
    const usage = value.usageMetadata; if (!isRecord(usage)) return null;
    state.complete = true;
    const input = usage.promptTokenCount, cached = usage.cachedContentTokenCount;
    return [count(input) && count(cached) ? input - cached : undefined, usage.candidatesTokenCount, cached, 0];
  }
  const usage = value.type === "response.completed" ? value.response?.usage : value.usage;
  if (!isRecord(usage)) return null;
  state.complete = true;
  const input = usage.input_tokens ?? usage.prompt_tokens, output = usage.output_tokens ?? usage.completion_tokens;
  const cached = usage.input_tokens_details?.cached_tokens ?? usage.prompt_tokens_details?.cached_tokens;
  return [count(input) && count(cached) ? input - cached : undefined, output, cached, 0];
}

// Observes only bytes requested by the consumer: no tee, eager drain or replay.
// Unknown/oversized metadata stops observation but leaves every byte unchanged.
function observe(response, protocol, onCounts) {
  const type = response.headers.get("content-type") ?? "", sse = /^text\/event-stream(?:;|$)/i.test(type);
  if (response.status !== 200 || !response.body || response.body.locked || !sse && !/^application\/(?:[\w.+-]*\+)?json(?:;|$)/i.test(type)) return response;
  const reader = response.body.getReader(), decoder = new TextDecoder("utf-8", { fatal: true });
  const state = { complete: false, failed: false }; let buffer = "", inspected = 0, active = true, closed = false, latest;
  const inspect = text => {
    let value; try { value = JSON.parse(text); } catch { return; }
    const counts = countsFrom(value, protocol, state);
    if (counts?.every(count)) latest = counts;
    else if (counts) { latest = undefined; state.failed = true; }
  };
  const feed = chunk => {
    if (!active) return;
    inspected += chunk.byteLength;
    if (inspected > READ_LIMIT || chunk.byteLength > FRAME_LIMIT) { active = false; buffer = ""; return; }
    try { buffer += decoder.decode(chunk, { stream: true }); } catch { active = false; buffer = ""; return; }
    if (sse) {
      let delimiter;
      while ((delimiter = /\r?\n\r?\n/.exec(buffer))) {
        const block = buffer.slice(0, delimiter.index); buffer = buffer.slice(delimiter.index + delimiter[0].length);
        if (Buffer.byteLength(block) > FRAME_LIMIT) { active = false; buffer = ""; return; }
        const data = block.split(/\r?\n/).filter(line => line.startsWith("data:")).map(line => line.slice(5).trimStart()).join("\n");
        inspect(data);
      }
    }
    if (Buffer.byteLength(buffer) > FRAME_LIMIT) { active = false; buffer = ""; }
  };
  const stream = new ReadableStream({
    async pull(controller) {
      try {
        const next = await reader.read(); if (closed) return;
        if (!next.done) { feed(next.value); controller.enqueue(next.value); return; }
        closed = true;
        if (active) {
          try { buffer += decoder.decode(); if (!sse) inspect(buffer); else if (buffer.trim()) state.failed = true; } catch { state.failed = true; }
          if (latest && state.complete && !state.failed) onCounts(latest);
        }
        buffer = ""; reader.releaseLock(); controller.close();
      } catch (error) { closed = true; buffer = ""; controller.error(error); }
    },
    cancel(reason) { closed = true; buffer = ""; void reader.cancel(reason).catch(() => {}); },
  }, { highWaterMark: 0 });
  const wrapped = new Response(stream, { status: response.status, statusText: response.statusText, headers: response.headers });
  for (const field of ["url", "redirected", "type"]) Object.defineProperty(wrapped, field, { value: response[field] });
  return wrapped;
}

export function createCallJournal({ now = Date.now } = {}) {
  const scopes = new Map(); let entries = [];
  const begin = account => {
    const scope = scopeOf(account), time = now();
    for (const [key, state] of scopes) if (time - state.last >= HOUR || state.last > time) scopes.delete(key);
    if (!scopes.has(scope)) {
      scopes.set(scope, { last: time, since: Math.floor(time / 1000) * 1000 });
      if (scopes.size > MAX_SCOPES) scopes.delete(scopes.keys().next().value);
    }
    scopes.get(scope).last = time;
    entries = entries.filter(entry => scopes.has(entry.scope) && time - entry.end < HOUR && entry.end <= time);
    return { scope, start: time };
  };
  return {
    begin,
    watch(response, { account, model, protocol, started, signal }) {
      if (!validModel(model) || redactedMessage(model, account) !== model) return response;
      return observe(response, protocol, counts => {
        const end = now();
        if (signal?.aborted || !scopes.has(started.scope) || end < started.start || end - started.start >= HOUR) return;
        entries.push({ scope: started.scope, start: started.start, end, fingerprint: JSON.stringify([model, ...counts]) });
        if (entries.length > MAX_CALLS) entries.shift();
      });
    },
    filter(account, calls) {
      const { scope } = begin(account), time = now(), lower = Math.max(scopes.get(scope).since, time - HOUR);
      const recent = calls.filter(call => call.t >= lower);
      const local = entries.filter(entry => entry.scope === scope);
      const candidates = recent.map(call => local.filter(entry => entry.fingerprint === fingerprint(call) && call.t >= entry.start - 5000 && call.t <= entry.end + 5000));
      // Mutual uniqueness only; identical concurrent calls stay ambiguous. This
      // remains best effort: a unique external collision can still be omitted.
      return recent.filter((_call, index) => candidates[index].length !== 1 || candidates.filter(list => list.includes(candidates[index][0])).length !== 1);
    },
  };
}
