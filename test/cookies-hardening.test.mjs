import test from "node:test";
import assert from "node:assert/strict";
import { importCookieHeader, applySetCookies, cookieHeader, serializeSession, restoreSession } from "../lib/cookies.mjs";
import { createSiteClient, solveWafChallenge } from "../lib/site-client.mjs";
import { saveAccount, readAccount } from "../lib/accounts.mjs";
const origin = "https://anyrouter.top", url = `${origin}/api/user/self`;
const arg = "0123456789abcdef0123456789abcdef01234567";
const known = `<script>var arg1='${arg}'; /* algorithm data only */</script>`;
const account = () => ({ mode: "session", site: "top", siteURL: origin, userId: "123", session: "session=synthetic", headers: "" });

test("the known arg1 vector is solved without executing remote JavaScript", () => {
  assert.equal(solveWafChallenge(known), "acw_sc__v2=d2c7186598ab1a508a4f6064e4fa746323ab17c6");
  const html = `<script>var arg1='x';document.cookie='acw_sc__v2='+document.constructor.constructor("globalThis.__hardeningMarker=true;return process.version")();</script>`;
  assert.equal(solveWafChallenge(html), "");
  assert.equal(globalThis.__hardeningMarker, undefined);
  assert.equal(solveWafChallenge(known + known), "");
});
test("expiry, negative Max-Age and domain/path scopes survive persistence", () => {
  const jar = importCookieHeader("session=synthetic");
  applySetCookies(jar, new Headers({ "set-cookie": "session=expired; Max-Age=-1; Path=/" }), url);
  assert.equal(cookieHeader(jar, url), "");
  applySetCookies(jar, new Headers({ "set-cookie": "private=scoped; Path=/private; Secure" }), url);
  applySetCookies(jar, new Headers({ "set-cookie": "session=foreign; Domain=other.invalid; Path=/" }), url);
  const restored = restoreSession({ sessionState: serializeSession(jar) });
  assert.equal(cookieHeader(restored, url), "");
  assert.equal(cookieHeader(restored, `${origin}/private`), "private=scoped");
});
test("positive Max-Age is a fixed deadline, not extended by reads/restarts", () => {
  const now = Date.now(), jar = importCookieHeader("", origin, now);
  applySetCookies(jar, new Headers({ "set-cookie": "session=timed; Max-Age=2; Path=/" }), url, now);
  const saved = serializeSession(jar, now + 500);
  assert.equal(cookieHeader(restoreSession({sessionState:saved}, now + 1000), url, now + 1000), "session=timed");
  assert.equal(cookieHeader(restoreSession({sessionState:saved}, now + 3000), url, now + 3000), "");
});
test("valid __Host prefix survives restore; malformed stored state never falls back", () => {
  const jar = importCookieHeader("__Host-synthetic=value; session=synthetic");
  const saved = serializeSession(jar);
  assert.match(cookieHeader(restoreSession({sessionState:saved}), url), /__Host-synthetic=value/);
  assert.throws(() => restoreSession({session:"session=old",sessionState:{version:99,origin,jar:{cookies:[]}}}));
  assert.throws(() => restoreSession({session:"session=old",sessionState:null}), "null new state must not revive legacy credentials");
  const corrupted = structuredClone(saved);
  corrupted.jar.cookies[0].expires = "invalid-date";
  assert.throws(() => restoreSession({session:"session=old",sessionState:corrupted}), "invalid expiry is not permission for an immortal cookie");
});
test("a challenge GET cannot resurrect a server-deleted login cookie", async () => {
  const seen = [];
  const site = createSiteClient({fetchImpl:async (_, init) => {
    seen.push(init.headers.get("cookie"));
    return seen.length === 1 ? new Response(known,{headers:{"content-type":"text/html","set-cookie":"session=deleted; Max-Age=0; Path=/"}}) : Response.json({success:true,data:{turnstile_check:false}});
  }});
  await site.status(account());
  assert.match(seen[0], /session=synthetic/);
  assert.doesNotMatch(seen[1], /session=/);
  assert.match(seen[1], /acw_sc__v2=/);
});
test("one operation retains warmup rotation for the single check-in POST", async () => {
  const seen = [];
  const site = createSiteClient({fetchImpl:async (target, init) => {
    seen.push({path:new URL(target).pathname,cookie:init.headers.get("cookie")});
    return seen.length === 1 ? Response.json({success:true,data:{id:123}}, {headers:{"set-cookie":"session=rotated; Path=/"}}) : Response.json({success:true,message:""});
  }});
  const op=site.openSession(account());
  try { await op.self(); await op.signIn(); assert.equal(seen[1].cookie,"session=rotated"); }
  finally {op.close();}
});
test("new credentials persist a jar and generation, not duplicated raw Cookie strings", () => {
  const auth=saveAccount({...account(),key:""});
  const state=JSON.parse(auth.refresh);
  assert.equal(state.session,undefined); assert.equal(state.cookie,undefined);
  assert.equal(state.sessionState.origin,origin); assert.ok(state.loginGeneration);
  assert.equal(readAccount(auth).userId,"123");
});
test("a pre-aborted operation issues zero site requests", () => {
  const controller=new AbortController();controller.abort();let calls=0;
  const site=createSiteClient({fetchImpl:async()=>{calls++;return Response.json({})}});
  assert.throws(()=>site.openSession(account(),{signal:controller.signal}));
  assert.equal(calls,0);
});
