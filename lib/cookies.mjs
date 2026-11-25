import { Cookie, CookieJar } from "tough-cookie";
import { ANYROUTER_ORIGIN, isRecord, trustedURL } from "./safety.mjs";

const MAX_STATE_BYTES = 128 * 1024;
const MAX_COOKIES = 256;
const COOKIE_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const COOKIE_VALUE = /^[\x21\x23-\x2b\x2d-\x3a\x3c-\x5b\x5d-\x7e]*$/;
const invalid = () => new Error("保存的 Cookie 状态或导入格式无效，请重新导入本站会话");
const freshJar = () => new CookieJar(undefined, { prefixSecurity: "strict", allowSpecialUseDomain: false });

// Freeze Max-Age at receipt time. tough-cookie uses lastAccessed as its relative
// anchor; normalizing to Expires prevents reads/restarts from extending lifetime.
function absoluteExpiry(cookie, receivedAt) {
  if (cookie.maxAge != null) {
    if (cookie.maxAge === "Infinity") cookie.expires = "Infinity";
    else cookie.expires = new Date(Number(cookie.maxAge) <= 0 ? 0 : receivedAt + Number(cookie.maxAge) * 1000);
    cookie.maxAge = null;
  }
  return cookie;
}

export function importCookieHeader(raw, origin = ANYROUTER_ORIGIN, now = Date.now()) {
  trustedURL(origin);
  if (origin !== ANYROUTER_ORIGIN || typeof raw !== "string" || Buffer.byteLength(raw) > MAX_STATE_BYTES || /[\r\n]/.test(raw)) throw invalid();
  const jar = freshJar();
  const parts = raw.trim().replace(/^Cookie:\s*/i, "").split(";").map(v => v.trim()).filter(Boolean);
  if (parts.length > MAX_COOKIES) throw invalid();
  for (const pair of parts) {
    const at = pair.indexOf("=");
    const key = pair.slice(0, at), value = pair.slice(at + 1);
    if (at < 1 || !COOKIE_NAME.test(key) || !COOKIE_VALUE.test(value)) throw invalid();
    const c = Cookie.parse(pair);
    if (!c) throw invalid();
    c.path = "/"; c.secure = true;
    jar.setCookieSync(c, `${origin}/`, { now: new Date(now) });
  }
  return jar;
}

export function restoreSession(account = {}, now = Date.now()) {
  const origin = account.siteURL ?? ANYROUTER_ORIGIN;
  if (origin !== ANYROUTER_ORIGIN) throw invalid();
  if (account.sessionState !== undefined) {
    const state = account.sessionState;
    if (!isRecord(state) || state.version !== 1 || state.origin !== origin || !isRecord(state.jar) ||
        !Array.isArray(state.jar.cookies) || state.jar.cookies.length > MAX_COOKIES || Buffer.byteLength(JSON.stringify(state)) > MAX_STATE_BYTES) throw invalid();
    const jar = freshJar();
    for (const raw of state.jar.cookies) {
      if (!isRecord(raw) || raw.domain !== "anyrouter.top" || typeof raw.path !== "string" || !raw.path.startsWith("/") ||
          typeof raw.key !== "string" || !COOKIE_NAME.test(raw.key) || typeof raw.value !== "string" || !COOKIE_VALUE.test(raw.value)) throw invalid();
      for (const field of ["expires", "creation", "lastAccessed"]) {
        const value = raw[field];
        if (value !== undefined && !(field === "expires" && value === "Infinity") &&
            (!(typeof value === "string" || typeof value === "number") || !Number.isFinite(new Date(value).getTime()))) throw invalid();
      }
      if (raw.maxAge !== undefined && raw.maxAge !== null && raw.maxAge !== "Infinity" && raw.maxAge !== "-Infinity" &&
          !Number.isSafeInteger(raw.maxAge)) throw invalid();
      const c = Cookie.fromJSON(raw);
      if (!c) throw invalid();
      const anchor = c.lastAccessed?.getTime() ?? c.creation?.getTime() ?? now;
      absoluteExpiry(c, anchor);
      // Setting into a fresh trusted jar rechecks prefixes, domain and path.
      // A persisted host-only cookie has a domain for storage, not a Domain
      // attribute; clear it before prefix validation (__Host-* forbids Domain).
      if (raw.hostOnly === true) c.domain = undefined;
      jar.setCookieSync(c, `${origin}${c.path}`, { now: c.creation ?? new Date(now) });
    }
    return jar;
  }
  return importCookieHeader(account.session ?? account.cookie ?? "", origin, now);
}

export function cookieHeader(jar, url, now = Date.now()) {
  trustedURL(url);
  return jar.getCookiesSync(url, { expire: false, sameSiteContext: "strict" })
    .filter(c => (c.expiryTime() ?? Infinity) > now).map(c => c.cookieString()).join("; ");
}

export function hasSession(account, now = Date.now(), url = `${ANYROUTER_ORIGIN}/api/user/self`) {
  try {
    trustedURL(url);
    const jar = restoreSession(account, now);
    return jar.getCookiesSync(url, { expire: false, sameSiteContext: "strict" })
      .some(c => c.key === "session" && c.value && (c.expiryTime() ?? Infinity) > now);
  } catch { return false; }
}

export function applySetCookies(jar, headers, url, now = Date.now()) {
  trustedURL(url);
  const separate = headers?.getSetCookie?.() ?? [];
  const lines = separate.length ? separate : (headers?.get?.("set-cookie") ?? "").split(/,(?=\s*[^;,=\s]+=)/);
  for (const line of lines) {
    if (Buffer.byteLength(String(line)) > 8192) continue;
    const c = Cookie.parse(String(line));
    if (!c || !COOKIE_NAME.test(c.key) || !COOKIE_VALUE.test(c.value)) continue;
    absoluteExpiry(c, now);
    try { jar.setCookieSync(c, url, { now: new Date(now) }); } catch { /* Ignore invalid/foreign server cookies, never log their values. */ }
  }
  const state = jar.serializeSync();
  if (state.cookies.length > MAX_COOKIES || Buffer.byteLength(JSON.stringify(state)) > MAX_STATE_BYTES) throw invalid();
}

export function serializeSession(jar, now = Date.now()) {
  const state = jar.serializeSync();
  state.cookies = state.cookies.filter(raw => {
    const c = Cookie.fromJSON(raw); return c && (c.expiryTime() ?? Infinity) > now;
  }).map(raw => { const copy = { ...raw }; delete copy.lastAccessed; return copy; });
  state.cookies.sort((a, b) => `${a.domain}\n${a.path}\n${a.key}`.localeCompare(`${b.domain}\n${b.path}\n${b.key}`));
  return { version: 1, origin: ANYROUTER_ORIGIN, jar: state };
}

// Compatibility helper for integrations that need only the current header.
// Persistence must use serializeSession so expiry and scope are not discarded.
export function mergeCookies(previous, headers, url = `${ANYROUTER_ORIGIN}/api/user/self`) {
  const jar = importCookieHeader(previous ?? "");
  applySetCookies(jar, headers, url);
  return cookieHeader(jar, url);
}
