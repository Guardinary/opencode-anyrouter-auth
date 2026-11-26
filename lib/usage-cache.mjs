import { credentialSnapshot, beijingDay, accountCapabilities } from "./accounts.mjs";
import { AccountChangedError } from "./account-operations.mjs";
import { deadlineSignal, throwIfAborted } from "./safety.mjs";

const TTL = 60000, HISTORY_TTL = 300000, MAX_ENTRIES = 64;
const sampledText = time => new Date(time + 8 * 3600000).toISOString().slice(0, 19).replace("T", " ") + "，北京时间";
function displaySample(entry, historical = false) {
  const result = structuredClone(entry.result), note = `${historical ? "历史" : "缓存"}，采样 ${sampledText(entry.at)}`;
  result.windows = result.windows.map(window => {
    const out = { ...window, display: `${window.display}（${note}）` };
    if (historical) { delete out.balance; out.aside = true; }
    return out;
  });
  if (historical) delete result.balance;
  else if (result.balance) result.balance += `（${note}）`;
  return result;
}

// Only usage reads are merged, never check-in outcomes. Every subscriber owns
// cancellation; the last departing subscriber cancels the shared operation.
export function createUsageReads({ now = Date.now, timeoutMs = 30000, cooldownMs = () => 0 } = {}) {
  const cache = new Map(), pending = new Map();
  return async function read({ auth, account, getAuth, signal, todaySpend }, work) {
    const budget = deadlineSignal(signal, timeoutMs);
    let abort, flight, key, joined = false;
    const stopped = new Promise((_, reject) => {
      abort = () => reject(budget.signal.reason);
      budget.signal.addEventListener("abort", abort, { once: true });
    });
    try {
      const suffix = `${account.siteURL}:${account.apiBase}:${account.mode}:${todaySpend ? beijingDay(now()) : "balance"}`;
      const keyFor = token => `${token}:${suffix}`;
      key = keyFor(credentialSnapshot(auth));
      for (const [k, entry] of cache) if (now() - entry.at >= HISTORY_TTL || now() < entry.at) cache.delete(k);
      const previous = account.mode === "api-key" || accountCapabilities(account, now()).usage ? cache.get(key) : undefined;
      const verify = async entry => {
        throwIfAborted(budget.signal);
        if (credentialSnapshot(await getAuth()) !== entry.token) throw new AccountChangedError();
        throwIfAborted(budget.signal);
      };
      if (previous && now() - previous.at < TTL) {
        await Promise.race([verify(previous), stopped]);
        return displaySample(previous);
      }
      flight = pending.get(key);
      if (!flight) {
        if (pending.size >= MAX_ENTRIES) throw new Error("额度读取繁忙，请稍后再试");
        const controller = new AbortController();
        flight = { controller, subscribers: 0 };
        pending.set(key, flight);
        flight.promise = (async () => {
          let at = now();
          const entry = { ...await work(controller.signal, () => { at = now(); }), at };
          throwIfAborted(controller.signal);
          if (!entry.result.error && !cooldownMs()) {
            const next = keyFor(entry.token);
            cache.delete(next); cache.set(next, structuredClone(entry));
            if (cache.size > MAX_ENTRIES) cache.delete(cache.keys().next().value);
          }
          return entry;
        })().finally(() => { if (pending.get(key) === flight) pending.delete(key); });
        // A cancelled caller leaves an owned job until it settles.
        void flight.promise.catch(() => {});
      }
      flight.subscribers++; joined = true;
      const entry = await Promise.race([flight.promise, stopped]);
      await Promise.race([verify(entry), stopped]);
      throwIfAborted(budget.signal);
      if (!entry.result.balance && cooldownMs() && previous && now() - previous.at < HISTORY_TTL) {
        return { ...displaySample(previous, true), error: entry.result.error, signIn: "kept" };
      }
      return structuredClone(entry.result);
    } finally {
      budget.signal.removeEventListener("abort", abort); budget.close();
      if (joined && --flight.subscribers === 0) {
        flight.controller.abort();
        if (pending.get(key) === flight) pending.delete(key);
      }
    }
  };
}
