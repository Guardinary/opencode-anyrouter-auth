import { credentialSnapshot, patchAccountAuth, readAccount } from "./accounts.mjs";
import { deadlineSignal, throwIfAborted } from "./safety.mjs";

export class AccountChangedError extends Error {
  constructor() {
    super("操作期间登录信息已更新或账号已移除；未覆盖新凭据，请重新操作。");
    this.name = "AccountChangedError";
    this.code = "anyrouter_account_changed";
  }
}

// auth.set replaces the record; it is not cross-process CAS. The queue tracks
// only this plugin's writes and preserves the latest host-owned record fields.
export function createAccountOperations({ site, client, timeoutMs = 30000, now = Date.now }) {
  const queues = new Map();
  async function run(_action, getAuth, provider, signal, work) {
    throwIfAborted(signal);
    const firstAuth = await getAuth();
    throwIfAborted(signal);
    const first = readAccount(firstAuth, provider, now());
    if (!first) throw new AccountChangedError();
    const intent = credentialSnapshot(firstAuth);
    const key = `${first.siteURL}:${first.userId || intent}`;
    let q = queues.get(key);
    if (!q) {
      q = { tail: Promise.resolve(), transitions: new Map(), active: 0 };
      queues.set(key, q);
    }
    // Each caller executes against the freshest record. Returning the same
    // claimed result to two callers would duplicate the displayed reward.
    const budget = deadlineSignal(signal, timeoutMs);
    q.active++;
    const expected = token => {
      let next = token;
      const seen = new Set();
      while (q.transitions.has(next) && !seen.has(next)) {
        seen.add(next); next = q.transitions.get(next);
      }
      return next;
    };
    const execute = async () => {
      let op;
      try {
        throwIfAborted(budget.signal);
        const initialAuth = await getAuth();
        throwIfAborted(budget.signal);
        const token = credentialSnapshot(initialAuth);
        if (token !== expected(intent)) throw new AccountChangedError();
        const account = readAccount(initialAuth, provider, now());
        const check = async () => {
          throwIfAborted(budget.signal);
          const latest = await getAuth();
          throwIfAborted(budget.signal);
          if (credentialSnapshot(latest) !== token) throw new AccountChangedError();
        };
        op = site.openSession(account, { signal: budget.signal, beforeMutation: check });
        let persistenceAttempted = false;
        const persist = async (patch = {}) => {
          persistenceAttempted = true;
          if (!op.safeToPersist()) return false;
          throwIfAborted(budget.signal);
          const latest = await getAuth();
          throwIfAborted(budget.signal);
          if (credentialSnapshot(latest) !== token) return false;
          const snapshot = op.snapshot();
          const latestAccount = readAccount(latest, provider, now());
          if (!Object.keys(patch).length && JSON.stringify(latestAccount.sessionState) === JSON.stringify(snapshot)) return true;
          if (typeof client?.auth?.set !== "function") return false;
          const updated = patchAccountAuth(latest, { sessionState: snapshot, ...patch }, now());
          throwIfAborted(budget.signal);
          await client.auth.set({ path: { id: "anyrouter" }, body: updated });
          const updatedToken = credentialSnapshot(updated);
          if (updatedToken !== token) q.transitions.set(token, updatedToken);
          return true;
        };
        try {
          const result = await work({ account, auth: initialAuth, op, persist, check, signal: budget.signal });
          // An explicit save failure/decline must never cause a second attempt.
          // Work owns confirmed server outcomes even if local storage is broken.
          if (!persistenceAttempted) {
            try { await persist(); } catch {}
          }
          return result;
        } catch (error) {
          if (!persistenceAttempted && !budget.signal.aborted && op.safeToPersist()) {
            try { await persist(); } catch {}
          }
          throw error;
        }
      } finally { op?.close(); }
    };
    const pending = q.tail.then(execute, execute);
    q.tail = pending.catch(() => {});
    let abort;
    const cancelled = new Promise((_, reject) => {
      abort = () => { budget.close(); reject(budget.signal.reason); };
      budget.signal.addEventListener("abort", abort, { once: true });
    });
    // A cancelled waiter returns promptly, but the owned job keeps the queue
    // ordered until it settles. It cannot abort another waiter's operation.
    void pending.finally(() => {
      budget.signal.removeEventListener("abort", abort); budget.close();
      if (--q.active === 0 && queues.get(key) === q) queues.delete(key);
    }).catch(() => {});
    return Promise.race([pending, cancelled]);
  }
  return { run };
}
