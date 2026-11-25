# AnyRouter executable contracts

Maintained specification reviewed on 2026-11-25 (Asia/Shanghai). Behavior follows [project constraints](<../../CONSTRAINTS.md>) and the [specification entry](<README.md>). Historical acceptance evidence is available [here](<../validation/anyrouter-0.2.1/verification.md>).

## 1. Scope / Trigger

Credential/session storage, HTTP boundaries, host model schemas, request/response transformation, and package validation cross layers. Changes must preserve explicit contracts, not only pass current fixtures. This spec covers workspace-root runtime and tests; reference repositories are read-only sources.

## 2. Signatures

```js
readAccount(auth, provider = {}, now = Date.now())
saveAccount(account, previous = {}, now = Date.now())
patchAccountAuth(latest, patch, now = Date.now())
credentialSnapshot(auth)
restoreSession(account, now)
serializeSession(jar, now)
cookieHeader(jar, exactURL, now)
hasSession(account, now, exactURL)
createSiteClient({fetchImpl, timeoutMs, now}).openSession(account, {signal, beforeMutation})
createAccountOperations({site, client, timeoutMs, now}).run(action, getAuth, provider, signal, work)
createCatalog({site, explicit, compatibility, fetchImpl, loadRegistry})(provider, account, {signal})
explainResponse(response, {retryAfterSeconds, signal, account})
prepareRequest(input, init, {portableResponses, textFilter, sessionRepair})
formatUSD(integerQuota, positiveSafeIntegerRate)
```

Coordinator work receives `{account, auth, op, persist, check, signal}`. Node minimum is 20.3.0 because login cancellation combines signals with `AbortSignal.any`.

Commands:

```sh
pnpm test
pnpm run check:package
pnpm run check:pack
MAGPIE_TEST_HOST=/absolute/native/host.js MAGPIE_TEST_BINARY=/absolute/native/magpie MAGPIE_TEST_BUN=/absolute/native/bun pnpm run test:host
```

Only installed runtimes are used for the last command. Windows child-process variables use native absolute paths such as `C:/...`, not MSYS `/c/...` values. Packaging may use `ANYROUTER_TEST_PNPM` with an actual absolute executable/CLI-JS path; no `.cmd`/`.bat`/PowerShell wrapper is embedded into Node argv.

## 3. Contracts

### Credential and cookie state

- Site origin is exactly `https://anyrouter.top`. The model endpoint is the official origin plus allowed model paths; arbitrary origins are out of scope.
- Outer OAuth state remains schema 2 with `provider: anyrouter` and a known mode. Model key lives in native `key` or OAuth `access`.
- New cookie state is `{version:1, origin, jar}`; jar is bounded to 128 KiB / 256 cookies. It is authoritative if present, including malformed-present states: no legacy raw-cookie fallback.
- Raw legacy headers are read-only migration inputs. Cookie retrieval uses exact request URL and fixed receipt-time expiry; last-access changes cannot extend Max-Age.
- New login gets a new generation. Full refresh/credential snapshots protect this plugin's queued work; host-only outer fields are preserved from the latest record.
- Persist may patch only `sessionState`, `lastCheckinDay`, `lastCheckin`, `username`, `email`. Explicit failed/declined saves are not automatically attempted again.
- This is best-effort in-process coordination, not cross-process CAS. An identical-value legacy ABA cannot be detected without generation.

### Login and check-in

- Five site methods use OAuth callback shape; native model-key method is host-owned API shape.
- Password/auth-token methods use `method:auto`; browser handoff uses `method:code` and parses only official self cURL/JSON data, never commands.
- Model Key/Key ID selection reads existing records only. A specified bad ID fails instead of selecting another record; unspecified ambiguous/missing Key may yield balance-only connection.
- Valid session check-in is self then one sign-in POST. Saved password is used only after a refused session, not after WAF/network/rate failure.
- All POSTs are single-shot. Only known-challenge read-only GET may be replayed once. No remote VM/eval/Function/worker execution.
- Only claimed/done writes completion day, taken at confirmation in Beijing time. Confirmed server success survives local persistence failure.
- Password-storage consent does not replace host check-in scheduling, and no-password does not revoke an otherwise valid cookie capability.

### Models and requests

- Config uses `model.provider.{npm,api}`, top-level reasoning/attachment/tool_call/modalities. Runtime uses `model.api.{id,npm,url}` and capabilities.
- Successful account lists, including empty lists, are authoritative. Public registry/pricing and manual-only IDs never grant account access.
- Keyless account returns zero models and sends no model request. Preview/failure fallback comes from plugin declarations and explicit settings, not arbitrary host catalog union.
- Claude/cc-format defaults to Messages; GPT/Gemini to Responses. Explicit model SDK may override but does not prove upstream support.
- Claude and Codex switches are independent. Keep unknown/signed/opaque input items intact; never invent reasoning effort.
- Lossy repair is explicitly off by default. Detached tool results require an earlier retained call of the same kind/ID; otherwise fail before fetch.

### Responses, amounts and package

- JSON clone: 64 KiB / 2 seconds. SSE prelude: 64 KiB / 15 seconds. Request clone: 4 MiB / 2 seconds. Site body: 2 MiB within operation budget. Anonymous registry: 32 MiB / private metadata deadline.
- Unknown/semantic/signed state, excessive proof depth or invalid SSE UTF-8 releases original bytes; only proven empty typed metadata can be skipped/repackaged. Preserve backpressure and the in-flight read.
- Generated diagnostics redact known credential echoes and do not copy structured unknown error codes. Raw model output/headers are not universally scrubbed. Rebuilt body headers must drop stale digests/length/encoding.
- Use the same validated quota rate for display and numeric values. Nonstandard rates are truncated at 18 decimal places; nonzero single quota cannot display zero at any allowed safe-integer rate.
- Daily log fallback requires complete, consistent, nonduplicated pages and matching UID/time. Cancellation cannot publish a partial total or start another fallback.
- Runtime publish allowlist is explicit docs/assets plus `lib/*.mjs`; optional private JSON is not published. Packer fixture injects private sentinels into its own source copy and verifies absence in actual decompressed tarball before import.
- Archive smoke copies the already-installed dependency closure; it is not a fresh online installation test. Do not run lifecycle scripts or publish from checks.

## 4. Validation & Error Matrix

| Condition | Required outcome |
| --- | --- |
| Foreign site/base, URL credentials, unknown model path | fixed local config/destination failure before credentials leave |
| Invalid new jar/null/bad date/foreign domain | visible reconnect error, never raw-cookie fallback |
| Wrong UID candidate | reject identity; no POST or candidate persistence |
| Changed login/logout before mutation | AccountChangedError/local failure; preserve newer record |
| Missing inference Key | HTTP 400 anyrouter_missing_api_key; zero fetch |
| Model redirect | HTTP 502 anyrouter_upstream_redirect; no following fetch |
| Console session refusal | unavailable console data, signIn kept; do not expire independent model Key |
| Caller aborted | AbortError/abort reason; stop paging/POST, not another caller's work |
| Orphan tool result after enabled repair | local anyrouter_session_repair_opaque_tool; zero fetch |
| Opaque/partial output or invalid SSE encoding | original status/body bytes, no plugin replay |
| Duplicate/incomplete daily pages | unknown daily window, not zero/partial sum |
| Missing CLI fence marker | stop integration before credential-bearing CLI steps |
| Private file in pack report/payload | failed package check, no publish |

## 5. Good / Base / Bad Cases

- Good: self rotates session, sign-in uses rotated cookie once, latest outer metadata survives the saved jar.
- Base: unconnected provider displays declarations; valid-cookie account without Key displays no account models but may read usage.
- Bad: state has null jar plus old raw Cookie; never revive it to make a fixture pass.
- Good: successful empty account model list remains empty even with manual/registry models.
- Bad: unknown start block or signed metadata followed by an error is rewritten as an empty response.
- Good: unusual rate greater than 10^12 still displays nonzero single quota; inconsistent pages stay unknown.
- Bad: isolated HOME without verified fetch preload is assumed safe for a fake-key quota probe.

## 6. Tests Required (assertion points)

- Cookie hardening: malicious arg1 script never executes; domain/path/prefix/deletion/fixed expiry/restoration; no deleted-cookie revival.
- Lifecycle: fresh-cookie usage/check-in queue, same-UID relogin/logout, host fields, one failed save attempt, midnight confirmation, cancellation.
- Key/model hardening: specified ID and ambiguity, masked/exhausted/expired data, config/runtime SDK/capabilities, explicit false, authoritative empty/keyless lists.
- Protocol/response hardening: signed tools, unknown fields, semantic start events, JSON partial output, four switch combinations, foreign URLs/redirects, malformed UTF-8 and content-digest removal.
- Amounts: standard/extreme rates, negative/single quota, duplicate IDs/pages, wrong total/UID/time, cancellation at stat and paging.
- Installed host: actual RPC and CLI normalization/prompt/rotation/missing-key/one-fetch assertions. Fence must prove preload and storage ownership.
- Package: syntax/import graph, declared dependency, no lifecycle requirements, real tarball private-sentinel exclusion and borrowed-dependency offline import.

## 7. Wrong vs Correct

```js
// Wrong: revives old values, ignores scope/expiry, or writes an old whole record.
const cookie = mergeRawHeaders(oldCookie, response.headers);
await client.auth.set({path:{id:"anyrouter"}, body:oldAuth});

// Correct: session operation owns an exact-URL jar; coordinator reads/guards
// the latest record and patches owned state through its persist helper.
await op.self();
await check();
const result = await op.signIn(); // never replay this POST
await persist({lastCheckinDay:confirmationDay, lastCheckin:confirmedResult});
```

Never weaken the generation guard, scope validation or semantic proof simply to restore old fixture expectations. Stable test auth must keep one login generation between reads. A green configured matrix is not execution evidence until that matrix actually ran.
