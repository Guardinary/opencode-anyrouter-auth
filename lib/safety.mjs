export const ANYROUTER_ORIGIN = "https://anyrouter.top";
export const isRecord = value => value !== null && typeof value === "object" && !Array.isArray(value);

export function positiveId(value) {
  const id = typeof value === "string" || typeof value === "number" ? String(value).trim() : "";
  return /^[1-9]\d{0,15}$/.test(id) && Number.isSafeInteger(Number(id)) ? id : "";
}

export function usableModelKey(value) {
  if (typeof value !== "string" || value.length > 4096) return false;
  const key = value.trim();
  return !!key && !/[^\x21-\x7e]|[*<>]|\.\.\./.test(key) &&
    !["anyrouter", "your_api_key", "your-api-key", "opencode2-v1-key"].includes(key.toLowerCase());
}

export function trustedURL(value, { model = false, base = false } = {}) {
  let url;
  try { url = new URL(value instanceof Request ? value.url : value); } catch { throw new Error("AnyRouter 请求地址无效"); }
  if (url.origin !== ANYROUTER_ORIGIN || url.username || url.password || url.hash ||
      /%2f|%5c|%2e/i.test(url.pathname)) throw new Error("已阻止向非受信任地址发送 AnyRouter 凭据");
  if (base && (url.search || !["/", "/v1", "/v1/", "/v1beta", "/v1beta/"].includes(url.pathname))) {
    throw new Error("AnyRouter 模型基础地址必须为官方 /v1 地址");
  }
  if (model && !/^\/v1\/(?:responses(?:\/compact)?|chat\/completions|messages(?:\/count_tokens)?|models(?:\/[^/]+)?|dashboard\/billing\/(?:usage|subscription))\/?$/.test(url.pathname)) {
    throw new Error("已阻止向未知接口发送模型 API Key");
  }
  return url;
}

export function throwIfAborted(signal) {
  if (signal?.aborted) throw signal.reason ?? new DOMException("请求已取消", "AbortError");
}

export function deadlineSignal(signal, timeoutMs = 30000) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 600000) throw new Error("请求超时配置无效");
  throwIfAborted(signal);
  const controller = new AbortController();
  const abort = () => controller.abort(signal.reason);
  signal?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(() => controller.abort(new DOMException("请求超时", "TimeoutError")), timeoutMs);
  return { signal: controller.signal, close() { clearTimeout(timer); signal?.removeEventListener("abort", abort); } };
}

export function redactedMessage(value, account = {}, extra = []) {
  let text = typeof value === "string" ? value : "请求未能完成";
  const secrets = [account.key, account.accessToken, account.password, account.session, ...extra].filter(v => typeof v === "string" && v);
  for (const c of account.sessionState?.jar?.cookies ?? []) if (typeof c.value === "string" && c.value) secrets.push(c.value);
  for (const pair of String(account.session ?? "").split(";")) {
    const at = pair.indexOf("="); if (at > 0 && pair.slice(at + 1).trim()) secrets.push(pair.slice(at + 1).trim());
  }
  for (const secret of [...new Set(secrets)].sort((a, b) => b.length - a.length)) {
    text = text.split(secret).join("[REDACTED]");
    const encoded = encodeURIComponent(secret); if (encoded !== secret) text = text.split(encoded).join("[REDACTED]");
  }
  return text.replace(/\bsk-[A-Za-z0-9_-]{8,}/g, "[REDACTED]").replace(/[\x00-\x1f\x7f]/g, " ").slice(0, 500);
}
