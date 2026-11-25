// Test-only: official AnyRouter HTTP traffic is redirected to a verified local
// fixture. All other origins and every redirect are blocked before fetch.
import { writeFileSync } from "node:fs";
import path from "node:path";

const nativeFetch = globalThis.fetch;
const base = new URL(process.env.MAGPIE_TEST_ORIGIN);
if (base.hostname !== "127.0.0.1" || base.protocol !== "http:" || base.username || base.password || base.pathname !== "/") {
  throw new Error("Integration tests require a loopback fixture origin.");
}
// The native CLI may inject system proxy settings. Test HTTP must be direct,
// including when a machine-wide proxy would otherwise intercept localhost.
for (const name of ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"]) delete process.env[name];
process.env.NO_PROXY = "*"; process.env.no_proxy = "*";
globalThis.__ANYROUTER_OFFLINE_FIXTURE__ = { origin: base.origin };
const fence = process.env.MAGPIE_TEST_FENCE_FILE;
if (fence) {
  if (!path.isAbsolute(fence) || !/^offline-fence-\d+\.json$/.test(path.basename(fence)) ||
      !path.basename(path.dirname(fence)).startsWith("anyrouter-")) throw new Error("Invalid test-owned fence marker path.");
  writeFileSync(fence, JSON.stringify({ pid: process.pid, origin: base.origin, executable: process.execPath }), "utf8");
}

globalThis.fetch = (input, init = {}) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (url.origin !== "https://anyrouter.top" || url.username || url.password || url.hash) {
    throw new Error("External network request refused by the offline host fixture.");
  }
  const headers = new Headers(input instanceof Request ? input.headers : undefined);
  new Headers(init.headers).forEach((value, name) => headers.set(name, value));
  headers.set("x-test-upstream-origin", url.origin);
  headers.set("x-test-redirect-policy", init.redirect ?? "follow");
  const target = base.origin + url.pathname + url.search;
  return nativeFetch(input instanceof Request ? new Request(target, input) : target, {
    ...init, headers, proxy: "", redirect: "manual",
  });
};
