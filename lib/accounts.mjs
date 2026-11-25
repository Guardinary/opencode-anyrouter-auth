import { createHash, randomUUID } from "node:crypto";
import { cookieHeader, hasSession, restoreSession, serializeSession } from "./cookies.mjs";
import { ANYROUTER_ORIGIN, isRecord, positiveId, trustedURL, usableModelKey } from "./safety.mjs";

export const PROVIDER = "anyrouter";
export const SITES = Object.freeze({ top: ANYROUTER_ORIGIN });
export const API_ENDPOINTS = SITES;
export const PLACEHOLDER_KEY = "anyrouter";
const MODES = new Set(["api-key", "access-token", "password", "github", "linuxdo", "session", "legacy-session"]);
const CHECKIN_MODES = new Set(["password", "github", "linuxdo", "session", "legacy-session"]);
const text = v => typeof v === "string" || typeof v === "number" ? String(v).trim() : "";
const emailText = v => /^[^\s@]+@[^\s@]+$/.test(text(v)) ? text(v) : "";
const optedIn = v => v === true || v === "true" || v === "yes";

export function normalizeBase(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error("端点地址无效"); }
  if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error("端点必须是不含凭据、查询或片段的 http(s) 基础地址。");
  }
  return url.href.replace(/\/+$/, "");
}
export function siteChoice(value = "top") {
  if (!Object.hasOwn(SITES, value)) throw new Error("只支持 AnyRouter 官方站点 anyrouter.top。");
  return value;
}
export function apiEndpointChoice(value = "top") { if (!Object.hasOwn(API_ENDPOINTS, value)) throw new Error("API 端点只支持 anyrouter.top"); return value; }
export function protocolBase(base, protocol = "responses") {
  const normalized = normalizeBase(base);
  const version = protocol === "gemini" ? "v1beta" : "v1";
  return /\/(?:v1|v1beta)$/.test(normalized) ? normalized.replace(/\/(?:v1|v1beta)$/, `/${version}`) : `${normalized}/${version}`;
}
export function normalizeApiBase(value) {
  try { trustedURL(value, { base: true }); } catch { throw new Error("API 端点只支持不含凭据的 anyrouter.top/v1 地址"); }
  return protocolBase(normalizeBase(value));
}
const legacyValue = (auth, key) => auth?.[key] ?? auth?.metadata?.[key];
function savedState(auth) {
  if (auth?.type !== "oauth") return {};
  let state;
  try { state = JSON.parse(auth.refresh); } catch {}
  if (!isRecord(state) || state.provider !== PROVIDER || state.schema !== 2 || !MODES.has(state.mode)) {
    throw new Error("无法识别的 AnyRouter 账号格式，请重新连接该账号。");
  }
  return state;
}

export function readAccount(auth, provider = {}, now = Date.now()) {
  if (!auth) return null;
  if (!["api", "oauth"].includes(auth.type)) throw new Error("不支持的 AnyRouter 认证类型");
  const saved = savedState(auth);
  const get = key => auth.type === "oauth" ? saved[key] : legacyValue(auth, key);
  const username = text(get("username"));
  const pass = typeof get("password") === "string" ? get("password") : "";
  const rawSession = text(get("session") || get("cookie"));
  const accessToken = text(get("accessToken"));
  const mode = saved.mode ?? (username && pass ? "password" : accessToken ? "access-token" : rawSession || get("sessionState") ? "legacy-session" : "api-key");
  const site = siteChoice(text(get("site") || provider.site) || "top");
  const siteURL = normalizeBase(text(get("siteURL") || provider.siteURL) || SITES[site]);
  if (siteURL !== ANYROUTER_ORIGIN) throw new Error("AnyRouter 登录和站点接口只支持 anyrouter.top，请重新连接该账号。");
  const apiBase = get("apiBase") || get("endpoint") || provider.endpoint;
  const endpoint = text(get("apiEndpoint"));
  const key = text(auth.type === "oauth" ? auth.access : auth.key);
  const checkinEnabled = CHECKIN_MODES.has(mode) && optedIn(get("checkinEnabled"));
  const account = {
    ...saved, schema: 2, provider: PROVIDER, mode, site, siteURL,
    apiBase: apiBase ? normalizeApiBase(apiBase) : endpoint ? protocolBase(API_ENDPOINTS[apiEndpointChoice(endpoint)]) : "",
    key: key === PLACEHOLDER_KEY ? "" : key,
    hasModelKey: saved.hasModelKey !== false && usableModelKey(key),
    keyId: text(get("keyId")), userId: text(get("userId")), username,
    email: emailText(get("email")), label: text(get("label")) || (!saved.mode && !emailText(get("email")) ? text(get("email")) : ""),
    session: mode === "api-key" ? "" : rawSession,
    sessionState: mode === "api-key" ? undefined : get("sessionState"),
    accessToken: mode === "api-key" ? "" : accessToken,
    headers: get("headers") ?? "", siteHeaders: get("siteHeaders") ?? "",
    retryAfterSeconds: get("retryAfterSeconds"),
    checkinEnabled, password: mode === "password" && checkinEnabled ? pass : "",
    loginGeneration: text(get("loginGeneration")),
    lastCheckinDay: text(get("lastCheckinDay")), lastCheckin: get("lastCheckin") ?? null,
  };
  if (account.sessionState !== undefined) {
    // Convenience header is computed in memory only; the serialized jar remains
    // authoritative and raw Cookie values are never duplicated in persistence.
    account.session = cookieHeader(restoreSession(account, now), `${siteURL}/api/user/self`, now);
  }
  if (mode !== "api-key" && !positiveId(account.userId)) throw new Error("站点用户 ID 无效，请重新连接该账号");
  return account;
}

export function accountCapabilities(account, now = Date.now()) {
  const session = account && hasSession(account, now);
  const mode = account?.mode;
  return {
    inference: !!(account?.hasModelKey && usableModelKey(account.key)),
    usage: !!(account && mode !== "api-key" && positiveId(account.userId) && (session || account.accessToken)),
    checkin: !!(CHECKIN_MODES.has(mode) && positiveId(account?.userId) && (session || mode === "password" && account?.username && account?.password)),
  };
}

export function saveAccount(account, previous = {}, now = Date.now()) {
  if (!MODES.has(account.mode)) throw new Error("无法识别的 AnyRouter 账号模式。");
  const hasModelKey = usableModelKey(account.key);
  if (account.mode === "api-key" && !hasModelKey) throw new Error("模型 API Key 账号必须有推理 key。");
  if (account.mode !== "api-key" && !positiveId(account.userId)) throw new Error("站点没有提供有效账号 ID。");
  const old = previous.type === "oauth" ? savedState(previous) : {};
  const state = { ...old, ...account, schema: 2, provider: PROVIDER, hasModelKey,
    loginGeneration: account.loginGeneration || old.loginGeneration || randomUUID(),
    checkinEnabled: CHECKIN_MODES.has(account.mode) && account.checkinEnabled === true };
  delete state.key;
  if (account.mode !== "api-key") state.sessionState = serializeSession(restoreSession(account, now), now);
  else { delete state.sessionState; delete state.accessToken; }
  for (const name of ["session", "cookie", "cookies"]) delete state[name];
  if (!state.checkinEnabled || account.mode !== "password") delete state.password;
  const result = { ...previous, type: "oauth", access: hasModelKey ? account.key : PLACEHOLDER_KEY,
    refresh: JSON.stringify(state), expires: 0,
    accountId: text(previous.accountId ?? previous.metadata?.email ?? previous.email) || emailText(account.email) || text(account.username) || `AnyRouter ${account.userId}`,
    ...(account.userId ? { uid: `${PROVIDER}:${account.userId}` } : {}) };
  // Known legacy credential aliases must not leave duplicate secrets outside refresh.
  for (const name of ["key", "session", "cookie", "cookies", "sessionState", "accessToken", "password", "loginGeneration"]) delete result[name];
  if (isRecord(result.metadata)) {
    result.metadata = { ...result.metadata };
    for (const name of ["session", "cookie", "cookies", "sessionState", "accessToken", "password", "loginGeneration"]) delete result.metadata[name];
  }
  return result;
}

// Updates only fields owned by the site operation; unrelated host and refresh
// fields always come from the latest raw auth, never from the old operation.
export function patchAccountAuth(latest, patch, now = Date.now()) {
  const account = readAccount(latest, {}, now);
  if (!account) throw new Error("账号已移除");
  const allowed = new Set(["sessionState", "lastCheckinDay", "lastCheckin", "username", "email"]);
  for (const name of Object.keys(patch)) if (!allowed.has(name)) throw new Error("不允许的账号状态修改");
  return saveAccount({ ...account, ...patch }, latest, now);
}

export function credentialSnapshot(auth) {
  if (!auth) return "logged-out";
  // Full refresh captures credential/settings changes while outer host-only
  // changes remain preservable by patchAccountAuth. Hashes never contain secrets.
  const legacy = Object.fromEntries(["site", "siteURL", "userId", "endpoint", "apiBase", "apiEndpoint", "session", "cookie", "sessionState", "accessToken", "password", "headers", "checkinEnabled", "loginGeneration"].map(k => [k, legacyValue(auth, k)]));
  return createHash("sha256").update(JSON.stringify([auth.type, auth.key, auth.access, auth.refresh, legacy])).digest("hex");
}
export function withSiteIdentity(account, user) {
  const userId = assertSameUser(account, user);
  return { ...account, userId, username: text(user.username ?? account.username), email: emailText(user.email ?? account.email) };
}
export function assertSameUser(account, user) {
  const id = positiveId(user?.id);
  if (!id || account?.userId && id !== account.userId) throw new Error("站点返回的用户 ID 不一致或缺失，未替换账号凭据。");
  return id;
}
export function beijingDay(now = Date.now()) { return new Date(now + 8 * 3600000).toISOString().slice(0, 10); }
export function isKnownSite(value) { try { return trustedURL(value).origin === ANYROUTER_ORIGIN; } catch { return false; } }
