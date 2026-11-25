import { open } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { readBoundedText } from "./site-client.mjs";
import { deadlineSignal, throwIfAborted } from "./safety.mjs";

export const REGISTRY_URL = "https://models.dev/api.json";
const MAX_BYTES = 32 * 1024 * 1024;
const valid = value => value && typeof value === "object" && !Array.isArray(value) &&
  Object.values(value).some(provider => provider?.models && typeof provider.models === "object" && !Array.isArray(provider.models));

export function registryCachePaths(env = process.env, home = homedir()) {
  const roots = [env.XDG_CACHE_HOME || join(home, ".cache"), env.LOCALAPPDATA].filter(Boolean);
  return [...new Set(roots)].flatMap(root => ["magpie", "opencode"].map(app => join(root, app, "models.json")));
}

async function readCache(path, signal) {
  throwIfAborted(signal);
  const file = await open(path, "r");
  try {
    const stat = await file.stat();
    throwIfAborted(signal);
    if (!stat.isFile() || stat.size > MAX_BYTES) return undefined;
    const chunks = [];
    let size = 0;
    for await (const chunk of file.createReadStream({ autoClose: false, signal })) {
      throwIfAborted(signal);
      size += chunk.byteLength;
      if (size > MAX_BYTES) return undefined;
      chunks.push(chunk);
    }
    throwIfAborted(signal);
    const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (valid(value)) return value;
  } finally { await file.close(); }
}

// Capability data never grants account access. Reads are anonymous and do not
// modify the host cache. Only signal-free callers share an in-flight refresh;
// one cancellable caller must not abort another caller's metadata lookup.
export function createModelRegistry({ paths = registryCachePaths(), fetchImpl = (...args) => fetch(...args), now = Date.now,
  ttlMs = 300000, timeoutMs = 5000 } = {}) {
  let cached = {}, expires = 0, pending;
  return async ({ signal } = {}) => {
    throwIfAborted(signal);
    if (now() < expires) return cached;
    if (!signal && pending) return pending;
    const budget = deadlineSignal(signal, timeoutMs);
    const task = (async () => {
      try {
        for (const path of paths) {
          try {
            const value = await readCache(path, budget.signal);
            if (value) { cached = value; return cached; }
          } catch { throwIfAborted(budget.signal); }
        }
        throwIfAborted(budget.signal);
        const response = await fetchImpl(REGISTRY_URL, {
          headers: { accept: "application/json" }, redirect: "error", signal: budget.signal,
        });
        if (!response.ok) { void response.body?.cancel().catch(() => {}); return cached; }
        const value = JSON.parse(await readBoundedText(response, MAX_BYTES, { signal: budget.signal, timeoutMs }));
        throwIfAborted(budget.signal);
        if (valid(value)) cached = value;
      } catch {
        // Caller cancellation propagates; a private metadata timeout is merely
        // unavailable enrichment and may return the last successful cache.
        throwIfAborted(signal);
      }
      return cached;
    })();
    if (!signal) pending = task;
    try { return await task; }
    finally {
      budget.close();
      if (!signal || !signal.aborted) expires = now() + ttlMs;
      if (pending === task) pending = undefined;
    }
  };
}
