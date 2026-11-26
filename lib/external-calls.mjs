import { quotaRate } from "./usage.mjs";
import { isRecord, positiveId, redactedMessage, throwIfAborted, usableModelKey } from "./safety.mjs";

const PAGE_SIZE = 100, MAX_PAGES = 20;
const count = value => Number.isSafeInteger(value) && value >= 0;
const modelId = value => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,255}$/.test(value);
const canonicalKey = value => value.trim().replace(/^sk-/, "");
const fail = message => { throw new Error(message); };

export function externalKeyIds(value) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 10) fail("externalUsageKeyIds 必须是最多十个外部专用 Key ID 的数组");
  const ids = value.map(positiveId);
  if (ids.some(id => !id) || new Set(ids).size !== ids.length) fail("外部专用 Key ID 必须是唯一正整数");
  return ids;
}

function callFromRow(row, account, rate) {
  if (!modelId(row.model_name) || redactedMessage(row.model_name, account) !== row.model_name ||
      !count(row.prompt_tokens) || !count(row.completion_tokens)) fail("外部日志缺少有效模型或 token 用量");
  let other;
  try { other = typeof row.other === "string" ? JSON.parse(row.other) : row.other; } catch {}
  if (!isRecord(other) || !count(other.cache_tokens) || other.claude !== undefined && typeof other.claude !== "boolean") fail("外部日志缓存用量未知，未估算");
  const read = other.cache_tokens;
  const creation = other.cache_creation_tokens !== undefined ? other.cache_creation_tokens : other.cache_write_tokens !== undefined ? other.cache_write_tokens : 0;
  if (!count(creation) || other.cache_write_tokens !== undefined && !count(other.cache_write_tokens) ||
      other.cache_creation_tokens !== undefined && other.cache_write_tokens !== undefined && other.cache_creation_tokens !== other.cache_write_tokens ||
      creation > 0 && other.claude !== true) fail("外部日志缓存写入形态不明确，未估算");
  // New API's explicit Claude marker means prompt_tokens already excludes cache.
  // OpenAI/Google-style prompt_tokens include cached reads. Do not use a model
  // name alone to infer the accounting of a relay's converted protocol.
  const input = other.claude === true ? row.prompt_tokens : row.prompt_tokens - read;
  if (!count(input)) fail("外部日志缓存读取超过输入 token");
  const t = row.created_at * 1000;
  if (!count(t) || t === 0) fail("外部日志时间无效");
  const call = { rid: `anyrouter:${account.userId}:log:${positiveId(row.id)}`, t, model: row.model_name,
    in: input, out: row.completion_tokens, cache_read: read, cache_write: creation };
  if (row.quota !== undefined) {
    if (!count(row.quota)) fail("外部日志缺少有效消费额度");
    call.cost = row.quota / rate;
  }
  return call;
}

async function currentKeyId(op, account, signal, check) {
  if (!account.key || account.hasModelKey === false) return undefined;
  if (!usableModelKey(account.key)) fail("当前模型 Key 无法识别，未导入站外日志");
  throwIfAborted(signal); await check();
  const id = positiveId(account.keyId);
  const { data } = await op.request(id ? `/api/token/${id}` : "/api/token/?p=0&size=100");
  throwIfAborted(signal); await check();
  const items = id ? [data] : Array.isArray(data) ? data : data?.items;
  if (!Array.isArray(items) || items.length > 100) fail("无法完整读取当前 Key 身份，未导入站外日志");
  if (!id && (data.total !== undefined ? !count(data.total) || data.total !== items.length : items.length >= 100)) fail("当前 Key 列表可能被截断，未导入站外日志");
  const seen = new Set(), matches = [];
  for (const item of items) {
    if (!isRecord(item) || !positiveId(item.id) || seen.has(positiveId(item.id)) ||
        item.user_id !== undefined && positiveId(item.user_id) !== account.userId) fail("当前 Key 列表身份无效，未导入站外日志");
    seen.add(positiveId(item.id));
    if (usableModelKey(item.key) && canonicalKey(item.key) === canonicalKey(account.key)) matches.push(positiveId(item.id));
  }
  if (matches.length !== 1 || id && matches[0] !== id) fail("无法唯一确认当前模型 Key；请重新连接并选择已有 Key ID，未导入日志");
  return matches[0];
}

// Automatic mode excludes the verified current Key; it is not client-source
// proof. Advanced IDs retain the caller's external-only declaration and checks.
// Read all rows in a fixed time range before publishing any filtered calls.
export async function readExternalCalls(op, account, { keyIds, since = 0, now = Date.now,
  quotaPerUnit = 500000, signal = op.signal, check = async () => {}, automatic = false, filterSameKey } = {}) {
  throwIfAborted(signal);
  const ids = externalKeyIds(keyIds), rate = quotaRate(quotaPerUnit), end = now();
  if (!count(since) || !count(end)) fail("站外用量游标必须是非负安全整数毫秒时间");
  if (!ids.length && !automatic || since > end) return [];
  if (automatic && ids.length) fail("自动站外同步不能与外部专用白名单混用");
  if (!positiveId(account.userId)) fail("站外用量需要有效站点账号 UID");
  if (ids.includes(account.keyId)) fail("外部专用 Key ID 不能是当前 Magpie 模型 Key");
  await check();
  const user = await op.self();
  if (positiveId(user?.id) !== account.userId) fail("站外用量账号身份不一致");
  const excluded = automatic ? await currentKeyId(op, account, signal, check) : undefined;
  const credentials = new Set();
  for (const id of ids) {
    throwIfAborted(signal); await check();
    const { data } = await op.request(`/api/token/${id}`);
    if (!isRecord(data) || positiveId(data.id) !== id || data.user_id !== undefined && positiveId(data.user_id) !== account.userId || !usableModelKey(data.key)) fail("无法只读确认外部专用 Key 的身份");
    const key = canonicalKey(data.key);
    if (account.key && key === canonicalKey(account.key) || credentials.has(key)) fail("外部专用 Key 与 Magpie Key 或另一指定 Key 重复");
    credentials.add(key);
  }
  const startTimestamp = Math.floor(since / 1000), endTimestamp = Math.floor(end / 1000);
  const allowed = new Set(ids), seen = new Set(), calls = [], currentCalls = [];
  const includeCurrent = automatic && typeof filterSameKey === "function";
  let expected, received = 0;
  for (let page = 1; page <= MAX_PAGES; page++) {
    throwIfAborted(signal); await check();
    const { data } = await op.request(`/api/log/self?p=${page}&page_size=${PAGE_SIZE}&type=2&start_timestamp=${startTimestamp}&end_timestamp=${endTimestamp}`);
    throwIfAborted(signal); await check();
    if (!isRecord(data) || !Array.isArray(data.items) || !count(data.total) || data.total > PAGE_SIZE * MAX_PAGES || data.items.length > PAGE_SIZE ||
        data.page !== undefined && data.page !== page || data.page_size !== undefined && data.page_size !== PAGE_SIZE) fail("站外消费日志分页无效或超过 2000 条，未返回部分用量");
    expected ??= data.total;
    if (data.total !== expected || received + data.items.length > expected || !data.items.length && received < expected) fail("站外消费日志总数变化或提前结束");
    for (const row of data.items) {
      if (!isRecord(row) || !positiveId(row.id) || seen.has(positiveId(row.id)) || row.type !== 2 || positiveId(row.user_id) !== account.userId ||
          !positiveId(row.token_id) || !count(row.created_at) || row.created_at < startTimestamp || row.created_at > endTimestamp) fail("站外消费日志身份、ID、类型或时间无效，未返回部分用量");
      seen.add(positiveId(row.id));
      if (automatic ? positiveId(row.token_id) !== excluded || includeCurrent : allowed.has(positiveId(row.token_id))) {
        const call = callFromRow(row, account, rate);
        if (call.t >= since) {
          calls.push(call);
          if (includeCurrent && positiveId(row.token_id) === excluded) currentCalls.push(call);
        }
      }
    }
    received += data.items.length;
    if (received === expected) {
      await check(); throwIfAborted(signal);
      if (!includeCurrent) return calls;
      const currentIds = new Set(currentCalls.map(call => call.rid));
      const keep = new Set(filterSameKey(currentCalls).map(call => call.rid));
      return calls.filter(call => !currentIds.has(call.rid) || keep.has(call.rid));
    }
  }
  fail("站外消费日志未完整读取，未返回部分用量");
}
