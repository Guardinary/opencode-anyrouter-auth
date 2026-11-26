import { quotaNumber, readBoundedText } from "./site-client.mjs";
import { deadlineSignal, isRecord, redactedMessage, throwIfAborted, trustedURL } from "./safety.mjs";

export function quotaRate(value = 500000) {
  const rate = typeof value === "string" && /^\d+$/.test(value) ? Number(value) : value;
  if (!Number.isSafeInteger(rate) || rate <= 0) throw new Error("quotaPerUnit 必须是正的安全整数");
  return rate;
}
export function formatUSD(quota, quotaPerUnit = 500000) {
  if (typeof quota !== "bigint" && !Number.isSafeInteger(quota)) throw new Error("额度必须是安全整数");
  const rate = BigInt(quotaRate(quotaPerUnit)), n = BigInt(quota), abs = n < 0n ? -n : n;
  let remainder = abs % rate, fraction = "";
  // Exact for standard site quota rates. Unusual rates use an 18-place
  // truncated expansion: safe-integer rates cannot hide a whole quota as zero.
  for (let i = 0; remainder && i < 18; i++) { remainder *= 10n; fraction += String(remainder / rate); remainder %= rate; }
  fraction = fraction.replace(/0+$/, "").padEnd(2, "0");
  return `${n < 0n ? "-" : ""}$${abs / rate}.${fraction}`;
}
export function beijingDayRange(now = Date.now()) {
  const endTimestamp = Math.floor(now / 1000), offset = 8 * 3600;
  const startTimestamp = Math.floor((endTimestamp + offset) / 86400) * 86400 - offset;
  return { startTimestamp, endTimestamp, date: new Date((startTimestamp + offset) * 1000).toISOString().slice(0,10) };
}
const LOG_PAGE_SIZE = 100, MAX_LOG_PAGES = 20;
const bound = site => typeof site.snapshot === "function";
const request = (site, account, path, signal) => bound(site) ? site.request(path) : site.request(account, path, { signal });
function dailyQuota(data) {
  const n = quotaNumber(data?.data?.quota);
  if (data?.success !== true || n === null || !Number.isSafeInteger(n)) throw new Error("消费统计缺少有效 quota，不显示估算值");
  return n;
}
async function sumTodayFromLogs(site, account, range, signal) {
  let total = 0n, seen = 0, expected;
  const ids = new Set(), pages = new Set();
  for (let page = 1; page <= MAX_LOG_PAGES; page++) {
    throwIfAborted(signal);
    const result = await request(site, account, `/api/log/self?p=${page}&page_size=${LOG_PAGE_SIZE}&type=2&start_timestamp=${range.startTimestamp}&end_timestamp=${range.endTimestamp}`, signal);
    const data = result?.data;
    if (!isRecord(data) || !Array.isArray(data.items) || !Number.isSafeInteger(data.total) || data.total < 0 || data.items.length > LOG_PAGE_SIZE ||
        data.page !== undefined && data.page !== page || data.page_size !== undefined && data.page_size !== LOG_PAGE_SIZE) throw new Error("消费日志分页格式无效");
    if (expected === undefined) expected = data.total;
    if (expected !== data.total) throw new Error("消费日志分页总数变化");
    if (!data.items.length && seen < expected) throw new Error("消费日志分页提前结束");
    const signature = JSON.stringify(data.items);
    if (data.items.length && pages.has(signature)) throw new Error("消费日志分页重复，无法完整汇总");
    pages.add(signature);
    for (const item of data.items) {
      if (!isRecord(item)) throw new Error("消费日志条目格式无效");
      if (item.id !== undefined) {
        if (!Number.isSafeInteger(item.id) || item.id < 1 || ids.has(item.id)) throw new Error("消费日志 ID 无效或重复");
        ids.add(item.id);
      }
      if (item.type !== undefined && item.type !== 2) continue;
      const n = quotaNumber(item.quota);
      if (n === null || !Number.isSafeInteger(n)) throw new Error("消费日志条目缺少有效 quota");
      if (item.created_at !== undefined && (!Number.isSafeInteger(item.created_at) || item.created_at < range.startTimestamp || item.created_at > range.endTimestamp)) throw new Error("消费日志时间超出今日范围");
      if (item.user_id !== undefined && String(item.user_id) !== account.userId) throw new Error("消费日志用户与账号不一致");
      total += BigInt(n);
    }
    seen += data.items.length;
    if (seen >= expected) break;
    if (page === MAX_LOG_PAGES) throw new Error("今日消费日志超过 2000 条，无法完整汇总");
  }
  if (seen !== expected || total > BigInt(Number.MAX_SAFE_INTEGER) || total < BigInt(Number.MIN_SAFE_INTEGER)) throw new Error("今日消费日志未完整汇总，不显示估算值");
  return Number(total);
}
export async function readTodaySpend(site, account, now = Date.now, signal) {
  const range = beijingDayRange(now());
  try {
    throwIfAborted(signal);
    const result = await request(site, account, `/api/log/self/stat?type=2&start_timestamp=${range.startTimestamp}&end_timestamp=${range.endTimestamp}`, signal);
    return { ...range, quota: dailyQuota({success:true,data:result.data}), source: "stat" };
  } catch (error) {
    throwIfAborted(signal);
    if (error?.kind === "rate-limit" || error?.status === 429) {
      const wait = Number.isSafeInteger(error.retryAfterMs) && error.retryAfterMs > 0 ? error.retryAfterMs : 60000;
      return { ...range, error: `站点限流，请至少 ${Math.ceil(wait / 1000)} 秒后刷新；未继续请求消费日志`, kind: "rate-limit", retryAfterMs: wait };
    }
    if (error?.kind === "credentials" || error?.kind === "identity") return { ...range, error: "本站会话失效或账号不匹配，请更新会话；模型 Key 状态不受影响", kind: "console-expired" };
    try { return { ...range, quota: await sumTodayFromLogs(site, account, range, signal), source: "logs" }; }
    catch (fallback) {
      throwIfAborted(signal);
      return { ...range, error: `${redactedMessage(fallback?.message ?? "消费日志汇总失败", account)}（仅影响今日消耗；余额与签到不受影响，可稍后重试）`, kind: "kept" };
    }
  }
}
function userBalance(user) {
  const quota = quotaNumber(user?.quota), used = quotaNumber(user?.used_quota);
  if (!Number.isSafeInteger(quota) || !Number.isSafeInteger(used)) throw new Error("余额接口缺少有效的 quota/used_quota，不显示估算值");
  return { quota, used };
}
async function keySpend(apiBase, key, fetchImpl = globalThis.fetch, signal) {
  if (!key) return null;
  const budget = deadlineSignal(signal);
  try {
    const url = trustedURL(`${(apiBase || "https://anyrouter.top/v1").replace(/\/+$/, "")}/dashboard/billing/usage`, { model: true });
    const response = await fetchImpl(url.href, { headers: { Authorization:`Bearer ${key}`, Accept:"application/json" }, redirect:"manual", signal:budget.signal });
    throwIfAborted(budget.signal);
    if (!response.ok) { void response.body?.cancel().catch(()=>{}); return null; }
    const data = JSON.parse(await readBoundedText(response, 65536, {signal:budget.signal}));
    const value = data?.data?.total_usage ?? data?.total_usage;
    return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value / 100 : null;
  } catch (error) { throwIfAborted(budget.signal); return null; }
  finally {budget.close();}
}
export async function readUsage(site, account, { quotaPerUnit = 500000, now = Date.now, fetchImpl = globalThis.fetch, signal = site?.signal, todaySpend = true } = {}) {
  const rate = quotaRate(quotaPerUnit);
  if (account.mode === "api-key") {
    const spent = await keySpend(account.apiBase, account.key, fetchImpl, signal);
    return { plan: "API Key（仅推理）", windows: spent === null ? [] : [{ name:"累计消耗", display:`$${spent.toFixed(2)}`, aside:true }], signIn:"kept", ...(spent===null?{error:"仅有模型 Key，无法确认余额；累计消耗读取不可用"}:{}) };
  }
  let user;
  try { throwIfAborted(signal); user = bound(site) ? await site.self() : await site.self(account, signal); }
  catch (error) {
    throwIfAborted(signal);
    return { error:error?.kind === "credentials" ? "AnyRouter：本站会话已失效，请重新导入 Cookie；模型 API Key 未被判定失效。" : `AnyRouter：${redactedMessage(error?.message || "无法读取账号信息", account)}`, windows:[], signIn:"kept" };
  }
  throwIfAborted(signal);
  let balance;
  try { balance=userBalance(user); } catch (error) { return {error:error.message, windows:[], signIn:"kept"}; }
  const result = { plan:typeof user.username === "string"?user.username:undefined, balance:formatUSD(balance.quota,rate), signIn:"kept",
    windows:[{name:"累计消耗",display:formatUSD(balance.used,rate),aside:true},
      {name:"余额",balance:balance.quota/rate,unit:"USD",display:formatUSD(balance.quota,rate)}] };
  if (!todaySpend) return result;
  const today = await readTodaySpend(site, account, now, signal);
  const daily = today.error ? `不可用：${today.error}` : `${formatUSD(today.quota,rate)}${today.source==="logs"?"（消费日志汇总）":""}`;
  result.windows.push({name:"今日消耗",display:`${daily}（${today.date}，北京时间）`,aside:true});
  return result;
}
export const _internal = {dailyQuota, sumTodayFromLogs, keySpend, userBalance};
