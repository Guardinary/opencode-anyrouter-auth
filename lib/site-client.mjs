import { assertSameUser, beijingDay, withSiteIdentity } from "./accounts.mjs";
import { browserHeaders, customHeaders } from "./headers.mjs";
import { restoreSession, importCookieHeader, cookieHeader, applySetCookies, serializeSession, hasSession, mergeCookies } from "./cookies.mjs";
import { ANYROUTER_ORIGIN, deadlineSignal, isRecord, positiveId, redactedMessage, throwIfAborted, trustedURL, usableModelKey } from "./safety.mjs";

export { mergeCookies };
export class SiteError extends Error {
  constructor(kind, message, details = {}) {
    super(message); this.name = "SiteError"; this.kind = kind;
    this.status = details.status ?? 0; this.retryAfterMs = details.retryAfterMs ?? 0;
  }
}
export function quotaNumber(value) {
  if (!(typeof value === "number" || typeof value === "string" && /^-?\d+(?:\.\d+)?$/.test(value.trim()))) return null;
  const number = Number(value); return Number.isFinite(number) ? number : null;
}
function retryAfterMs(headers, now = Date.now()) {
  let wait = 0;
  for (const name of ["retry-after-ms", "x-ms-retry-after-ms"]) {
    const raw = headers?.get?.(name); if (raw != null && /^\d+$/.test(raw)) wait = Math.max(wait, Number(raw));
  }
  const raw = headers?.get?.("retry-after");
  if (raw) { const n = /^\d+$/.test(raw) ? Number(raw) * 1000 : Date.parse(raw) - now; if (Number.isFinite(n)) wait = Math.max(wait, n); }
  return Math.min(Math.max(0, wait), 86400000);
}
const ARG1 = /\b(?:var|let|const)\s+arg1\s*=\s*(['"])([0-9a-fA-F]{40})\1/g;
const UNSBOX = [15,35,29,24,33,16,1,38,10,9,19,31,40,27,22,23,25,13,6,11,39,18,20,8,14,21,32,26,2,30,7,4,17,5,3,28,34,37,12,36];
const XOR = Buffer.from("3000176000856006061501533003690027800375", "hex");
// Untrusted HTML is data only. No VM, eval, Function or remote-script runner.
export function solveWafChallenge(raw) {
  if (typeof raw !== "string" || Buffer.byteLength(raw) > 256 * 1024) return "";
  const matches = [...raw.matchAll(ARG1)];
  if (matches.length !== 1) return "";
  const shuffled = Buffer.from(UNSBOX.map(i => matches[0][2][i - 1]).join(""), "hex");
  for (let i = 0; i < shuffled.length; i++) shuffled[i] ^= XOR[i];
  return `acw_sc__v2=${shuffled.toString("hex")}`;
}
const CAPTCHA_RE = /captcha|turnstile|验证码|人机验证|challenge-platform|cf-chl|aliyun_waf_aa/i;
const FORBIDDEN_RE = /权限不足|封禁|banned|forbidden|permission denied|access denied/i;
const RATE_RE = /请求次数过多|请求过多|限流|too many requests|rate.?limit|负载已饱和|负载已满|系统繁忙|overloaded|server busy/i;
const INACTIVE_RE = /未开启签到|签到.*未开启|签到.*关闭|不支持.*签到|签到.*不支持|活动.*未开启|活动.*结束|not support.*checkin|checkin.*not supported|inactive/i;
const ALREADY_RE = /已签到|已经签到|重复签到|(?:今日|今天)已(?:签|领)|已领取|already (?:signed|checked)|checked.?in today|no.?reward/i;
const CREDENTIAL_RE = /密码错误|用户名或密码|账号或密码|incorrect password|wrong password|未登录|登录已过期|登录失效|(?:access\s*)?token\s*无效|invalid (?:password|credential|token)|unauthorized|not logged/i;
const SITE_HEADER_NAMES = new Set(["user-agent", "accept-language", "accept", "x-requested-with", "sec-ch-ua", "sec-ch-ua-mobile", "sec-ch-ua-platform", "sec-fetch-dest", "sec-fetch-mode", "sec-fetch-site", "priority"]);
function isShieldChallenge(response, raw) {
  return /text\/html/i.test(response?.headers?.get?.("content-type") ?? "") || /^\s*</.test(raw ?? "") || /denied/i.test(response?.headers?.get?.("x-tengine-error") ?? "");
}
export function classifySiteMessage(message, status = 0) {
  const text = String(message || "");
  if (CAPTCHA_RE.test(text)) return "captcha";
  if (CREDENTIAL_RE.test(text) || status === 401 || FORBIDDEN_RE.test(text) || status === 403) return "ineligible";
  if (ALREADY_RE.test(text)) return "done";
  if (INACTIVE_RE.test(text) || status === 404 || status === 405) return "inactive";
  if (status === 429 || RATE_RE.test(text)) return "failed";
  return null;
}
function siteFailure(response, data, raw, operation, account = {}) {
  const status = response?.status ?? 0;
  const message = isRecord(data) ? String(data.message ?? data.error?.message ?? data.msg ?? "") : "";
  const details = { status, retryAfterMs: retryAfterMs(response?.headers) };
  const tengine = response?.headers?.get?.("x-tengine-error") ?? "";
  if (status === 429 || /http_ratelimit/i.test(tengine)) return new SiteError("rate-limit", "AnyRouter 站点请求被限流，请稍后再试。", details);
  if (CAPTCHA_RE.test(message) || CAPTCHA_RE.test(raw ?? "")) return new SiteError("captcha", "站点要求验证码，请在浏览器完成验证。", details);
  if (isShieldChallenge(response, raw) && (status < 500 || /denied/i.test(tengine) || /\barg1\s*=/.test(raw ?? ""))) {
    return new SiteError("waf", "AnyRouter 返回 WAF 验证页；请在相同网络出口的浏览器完成验证后更新会话。", details);
  }
  if (CREDENTIAL_RE.test(message) || status === 401) return new SiteError("credentials", "站点拒绝了登录凭据，请重新连接该账号。", details);
  if (status === 403 || FORBIDDEN_RE.test(message)) return new SiteError("forbidden", "账号没有执行该站点操作的权限。", details);
  if (ALREADY_RE.test(message)) return new SiteError("already", "今天已经签到。", details);
  if (INACTIVE_RE.test(message) || status === 404 || status === 405) return new SiteError("inactive", "站点当前没有可用的签到接口。", details);
  if (status === 429 || RATE_RE.test(message)) return new SiteError("rate-limit", "站点对该操作限流，请稍后再试。", details);
  // Arbitrary upstream text is never an exception message; it may echo a secret.
  return new SiteError("unavailable", `站点未能完成${operation}（HTTP ${status}），请稍后重试。`, details);
}

export async function readBoundedText(response, limit = 2 * 1024 * 1024, { signal, timeoutMs = 30000 } = {}) {
  const budget = deadlineSignal(signal, timeoutMs);
  let reader, abort;
  try {
    throwIfAborted(budget.signal);
    reader = response.body?.getReader(); if (!reader) return "";
    const stopped = new Promise((_, reject) => { abort = () => reject(budget.signal.reason); budget.signal.addEventListener("abort", abort, { once: true }); });
    const decoder = new TextDecoder("utf-8", { fatal: true });
    let bytes = 0, text = "";
    for (;;) {
      throwIfAborted(budget.signal);
      const next = await Promise.race([reader.read(), stopped]);
      if (next.done) return text + decoder.decode();
      bytes += next.value.byteLength;
      if (bytes > limit) throw new SiteError("unavailable", "站点响应超过大小上限。");
      text += decoder.decode(next.value, { stream: true });
    }
  } finally {
    budget.signal.removeEventListener("abort", abort); budget.close();
    if (reader) void reader.cancel().catch(() => {});
  }
}
function safeSiteHeaders(value) {
  if (!value) return {};
  const out = {}; let headers;
  try { headers = new Headers(value); } catch { throw new SiteError("config", "站点请求头格式无效"); }
  for (const name of SITE_HEADER_NAMES) if (headers.has(name)) out[name] = headers.get(name);
  return out;
}
export function parseSessionHandoff(value) {
  if (typeof value !== "string" || Buffer.byteLength(value) > 65536 || !value.trim()) throw new SiteError("credentials", "请粘贴本站 /api/user/self 的 cURL 或 JSON 会话导出。");
  const text = value.trim(); let cookie, userId, siteHeaders = {};
  if (text.startsWith("{")) {
    let data; try { data = JSON.parse(text); } catch { throw new SiteError("credentials", "会话导出不是合法 JSON。"); }
    if (!isRecord(data)) throw new SiteError("credentials", "会话导出必须是对象。");
    cookie = data.cookie ?? data.cookies; userId = positiveId(data.userId ?? data.user_id);
    siteHeaders = safeSiteHeaders(data.siteHeaders ?? data.headers);
  } else {
    if (!/^curl(?:\.exe)?\b/.test(text)) throw new SiteError("credentials", "请粘贴 DevTools 的 cURL 请求文本（不会执行命令）。");
    const match = /(['"])(https:\/\/[^'"\s]+)\1/.exec(text);
    let url; try { url = trustedURL(match?.[2]); } catch {}
    if (!url || url.pathname !== "/api/user/self" || url.search || url.hash) throw new SiteError("credentials", "只能导入 AnyRouter 的 /api/user/self 请求。");
    const h = new Headers();
    for (const m of text.matchAll(/(?:^|\s)(?:-H|--header)\s+(?:'([^'\r\n]*)'|"([^"\r\n]*)")/g)) {
      const raw = m[1] ?? m[2], at = raw.indexOf(":"); if (at < 1) continue;
      const name = raw.slice(0, at).trim().toLowerCase();
      if (["cookie", "new-api-user"].includes(name) || SITE_HEADER_NAMES.has(name)) {
        try { h.set(name, raw.slice(at + 1).trim()); } catch { throw new SiteError("credentials", "站点请求头无效。"); }
      }
    }
    cookie = h.get("cookie") || /(?:^|\s)(?:-b|--cookie)\s+(['"])([^'"\r\n]*)\1/.exec(text)?.[2];
    userId = positiveId(h.get("new-api-user")); siteHeaders = safeSiteHeaders(h);
  }
  let jar; try { jar = importCookieHeader(cookie); } catch { throw new SiteError("credentials", "导出必须包含有效的 Cookie 格式。"); }
  const state = serializeSession(jar);
  if (!userId || !hasSession({ sessionState: state })) throw new SiteError("credentials", "导出必须包含有效的 session Cookie 和正整数 New-Api-User ID。");
  return { session: cookie, userId, siteHeaders, sessionState: state };
}

export function createSiteClient({ fetchImpl = (...args) => fetch(...args), timeoutMs = 30000, now = Date.now } = {}) {
  // The supported console has one fixed origin. All sessions and anonymous
  // pricing share this in-process cooldown; model fetch never uses it.
  let cooldownUntil = 0, blockedStat;
  const statPath = path => path.split("?")[0] === "/api/log/self/stat";
  const cooldownMs = () => Math.max(0, cooldownUntil - now());
  const limited = () => new SiteError("rate-limit", `AnyRouter 站点限流，请至少 ${Math.ceil(cooldownMs() / 1000)} 秒后重试。`, { status: 429, retryAfterMs: cooldownMs() });
  function rememberLimit(response, data) {
    if (response.status !== 429 && !/http_ratelimit/i.test(response.headers.get("x-tengine-error") ?? "") &&
        !(data?.success === false && siteFailure(response, data, "", "账号请求").kind === "rate-limit")) return false;
    cooldownUntil = Math.max(cooldownUntil, now() + Math.max(60000, retryAfterMs(response.headers, now())));
    return true;
  }
  function openSession(initial, { signal, beforeMutation } = {}) {
    if (initial.siteURL !== ANYROUTER_ORIGIN) throw new SiteError("config", "站点接口只支持 anyrouter.top。");
    let account = { ...initial }, jar;
    try { jar = restoreSession(account, now()); } catch { throw new SiteError("config", "Cookie 状态损坏，请重新导入会话。"); }
    const budget = deadlineSignal(signal, timeoutMs);
    let identityMismatch = false;
    const snapshot = () => serializeSession(jar, now());
    const current = () => ({ ...account, sessionState: snapshot(), session: cookieHeader(jar, `${account.siteURL}/api/user/self`, now()) });
    const checkIdentity = user => {
      try { account = withSiteIdentity(account, user); } catch {
        identityMismatch = true; throw new SiteError("identity", "站点返回的用户 ID 不一致，未更新当前账号。");
      }
    };
    async function requestRaw(path, options = {}) {
      throwIfAborted(budget.signal);
      const { body, anonymous = false, navigation = false, allowChallenge = true, operation = "账号请求" } = options;
      if (typeof path !== "string" || !path.startsWith("/") || path.startsWith("//")) throw new SiteError("config", "站点路径无效。");
      const url = trustedURL(account.siteURL + path).href;
      if (body !== undefined) { await beforeMutation?.(); throwIfAborted(budget.signal); }
      const attempts = body === undefined && allowChallenge ? 2 : 1;
      for (let attempt = 0; attempt < attempts; attempt++) {
        throwIfAborted(budget.signal);
        if (cooldownMs() > 0) throw limited();
        if (body === undefined && statPath(path) && blockedStat && now() >= blockedStat.at && now() - blockedStat.at < 900000) {
          throw new SiteError(blockedStat.kind, "统计路径暂不可用，使用完整消费日志回退。", { status: blockedStat.status });
        }
        const headers = browserHeaders();
        headers.set("referer", account.siteURL + (navigation ? "/login" : "/"));
        headers.set("cache-control", "no-store");
        for (const [name, v] of Object.entries(safeSiteHeaders(account.siteHeaders ?? {}))) headers.set(name, v);
        if (navigation) { headers.set("accept", "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"); headers.set("sec-fetch-mode", "navigate"); headers.set("sec-fetch-dest", "document"); }
        const cookies = cookieHeader(jar, url, now()); if (cookies) headers.set("cookie", cookies);
        headers.set("new-api-user", anonymous ? "-1" : account.userId || "-1");
        if (!anonymous && operation !== "每日签到" && account.accessToken) headers.set("authorization", account.accessToken);
        if (body !== undefined) { headers.set("content-type", "application/json"); headers.set("origin", account.siteURL); }
        if (operation === "每日签到") headers.set("x-requested-with", "XMLHttpRequest");
        let response;
        try {
          response = await fetchImpl(url, { method: body === undefined ? "GET" : "POST", headers,
            ...(body !== undefined ? { body: JSON.stringify(body) } : {}), redirect: "manual", signal: budget.signal });
          applySetCookies(jar, response.headers, url, now()); // Cookie state survives a bad/truncated body.
          if (rememberLimit(response)) { void response.body?.cancel().catch(() => {}); throw limited(); }
          const raw = await readBoundedText(response, 2 * 1024 * 1024, { signal: budget.signal, timeoutMs });
          let data; try { data = JSON.parse(raw); } catch {}
          if (rememberLimit(response, data)) throw limited();
          const result = { response, raw, data, status: response.status, cookies: cookieHeader(jar, url, now()), sessionState: snapshot() };
          const tengine = response.headers.get("x-tengine-error") ?? "";
          if (body === undefined && attempt + 1 < attempts && !/http_ratelimit|http_security_level_rule/i.test(tengine) && isShieldChallenge(response, raw)) {
            const solution = solveWafChallenge(raw);
            if (solution) { applySetCookies(jar, new Headers({ "set-cookie": `${solution}; Path=/; Secure; Max-Age=3600` }), url, now()); continue; }
          }
          return result;
        } catch (error) {
          if (budget.signal.aborted) throw budget.signal.reason;
          if (error instanceof SiteError) throw error;
          throw new SiteError("unavailable", "站点请求失败或超时，请检查账号代理与网络。");
        }
      }
    }
    async function request(path, options = {}) {
      const r = await requestRaw(path, options);
      if (!r.response.ok || !isRecord(r.data) || r.data.success !== true || isShieldChallenge(r.response, r.raw)) {
        const failure = siteFailure(r.response, r.data, r.raw, options.operation ?? "账号请求", current());
        if (options.body === undefined && statPath(path) && ["waf", "inactive"].includes(failure.kind)) {
          blockedStat = { at: now(), kind: failure.kind, status: failure.status };
        }
        throw failure;
      }
      if (statPath(path)) blockedStat = undefined;
      return { data: r.data.data, cookies: r.cookies, sessionState: r.sessionState, raw: r.raw, response: r.response };
    }
    async function self() {
      if (!positiveId(account.userId) || !hasSession(current(), now()) && !account.accessToken) throw new SiteError("credentials", "读取账号信息需要本站会话或系统访问令牌及用户 ID。");
      const r = await request("/api/user/self"); checkIdentity(r.data); return r.data;
    }
    async function profile() { const user = await self(); return { user, account: current(), profileVerified: true }; }
    async function login() {
      if (!account.username || !account.password) throw new SiteError("credentials", "需要 AnyRouter 站点用户名和密码。");
      // Bootstrap the known WAF read-only. Both login and sign_in POSTs are single-shot.
      let info;
      try { info = await request("/api/status", { anonymous: true }); }
      catch (error) {
        if (error.kind !== "waf") throw error;
        await requestRaw("/login", { anonymous: true, navigation: true });
        info = await request("/api/status", { anonymous: true });
      }
      if (!isRecord(info.data) || typeof info.data.turnstile_check !== "boolean") throw new SiteError("unavailable", "站点没有返回明确的登录验证配置。");
      if (info.data.turnstile_check) throw new SiteError("captcha", "AnyRouter 开启了 Turnstile，请在浏览器登录后导入本站会话。");
      const r = await request("/api/user/login?turnstile=", { anonymous: true, body: { username: account.username, password: account.password }, operation: "密码登录" });
      checkIdentity(r.data);
      return { user: r.data, status: info.data, account: current() };
    }
    async function selectKey(selection = "") {
      const id = selection === "" ? "" : positiveId(selection);
      if (selection !== "" && !id) throw new SiteError("selection", "模型 Key ID 必须是正整数。");
      const r = await request(id ? `/api/token/${id}` : "/api/token/?p=0&size=100", { operation: "读取已有模型 Key" });
      const items = id ? [r.data] : Array.isArray(r.data) ? r.data : r.data?.items;
      if (!Array.isArray(items) || items.some(x => !isRecord(x))) throw new SiteError("selection", "站点没有返回有效的模型 Key 列表。");
      const total = Array.isArray(r.data) ? undefined : r.data?.total;
      if (!id && (total !== undefined ? !Number.isSafeInteger(total) || total < items.length || total > items.length : items.length >= 100)) throw new SiteError("selection", "模型 Key 列表可能不完整，请填写目标 Key ID 或直接填写模型 Key。");
      const active = items.filter(x => {
        const exp = quotaNumber(x.expired_time), remain = quotaNumber(x.remain_quota);
        return x.status === 1 && positiveId(x.id) && (x.user_id === undefined || positiveId(x.user_id) === account.userId) &&
          usableModelKey(x.key) && (exp === -1 || exp !== null && exp > now() / 1000) &&
          (x.unlimited_quota === true || remain !== null && remain > 0);
      });
      if (id && (active.length !== 1 || String(active[0].id) !== id)) throw new SiteError("selection", "目标 Key 不可用或不属于当前账号。");
      if (active.length !== 1) throw new SiteError("selection", active.length ? "存在多把有效 Key，请填写目标 Key ID 或直接填写模型 Key。" : "没有可用模型 Key；账号仍可用于余额与签到。");
      const item = active[0];
      // New API stores token.key without the prefix; inference expects sk-.
      const rawKey = item.key.trim();
      const key = rawKey.startsWith("sk-") ? rawKey : `sk-${rawKey}`;
      return { key, keyId: String(item.id ?? "") };
    }
    async function signIn() {
      if (!hasSession(current(), now(), `${account.siteURL}/api/user/sign_in`)) throw new SiteError("credentials", "每日签到需要对签到路径有效的站点会话 Cookie。");
      const r = await requestRaw("/api/user/sign_in", { body: {}, operation: "每日签到" });
      if (!r.response.ok || !isRecord(r.data) || typeof r.data.success !== "boolean" || isShieldChallenge(r.response, r.raw)) throw siteFailure(r.response, r.data, r.raw, "每日签到", current());
      return { success: r.data.success, message: redactedMessage(r.data.message ?? "", current()), data: r.data.data, cookies: r.cookies, sessionState: snapshot(), status: r.status };
    }
    return { requestRaw, request, login, self, profile, selectKey, signIn, snapshot, account: current,
      safeToPersist: () => !identityMismatch, signal: budget.signal,
      status: () => request("/api/status", { anonymous: true }), close: () => budget.close() };
  }
  async function run(account, signal, call) { const op = openSession(account, { signal }); try { return await call(op); } finally { op.close(); } }
  function checkinResult(result) {
    const message = result.message || "";
    const classified = classifySiteMessage(message, result.status);
    const outcome = ["captcha", "ineligible", "inactive"].includes(classified) ? classified :
      result.success ? !message || classified === "done" ? "done" : "claimed" : classified ?? "failed";
    const lastCheckin = { outcome, message: message || (outcome === "done" ? "今日已签到，没有新的可领取额度。" : "站点未确认签到成功。") };
    if (outcome === "claimed") {
      const direct = quotaNumber(result.data?.reward ?? result.data?.credit);
      const match = /(?:获得|奖励|领取|received|awarded|earned)\s*[$＄]\s*(\d+(?:\.\d+)?)/i.exec(message);
      const reward = direct !== null && direct > 0 ? direct : match ? Number(match[1]) : NaN;
      if (Number.isFinite(reward) && reward > 0) lastCheckin.credit = reward;
    }
    return { lastCheckinDay: beijingDay(now()), lastCheckin };
  }
  return { openSession, checkinResult, cooldownMs,
    request: (a, p, o = {}) => run(a, o.signal, op => op.request(p, o)),
    requestRaw: (a, p, o = {}) => run(a, o.signal, op => op.requestRaw(p, o)),
    status: (a, signal) => run(a, signal, op => op.status()), login: (a, signal) => run(a, signal, op => op.login()),
    self: (a, signal) => run(a, signal, op => op.self()), profile: (a, signal) => run(a, signal, op => op.profile()),
    selectKey: (a, selection, signal) => run(a, signal, op => op.selectKey(selection)), signIn: (a, signal) => run(a, signal, op => op.signIn()),
    importSession: (a, value, signal) => { const handoff = parseSessionHandoff(value); if (a.userId && a.userId !== handoff.userId) throw new SiteError("identity", "导入会话属于另一个账号。"); return run({ ...a, ...handoff, accessToken: "", password: "" }, signal, op => op.profile()); },
  };
}
export const _internal = { classifySiteMessage, isShieldChallenge, retryAfterMs, siteFailure, solveWafChallenge };
