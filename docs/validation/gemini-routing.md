# Gemini native routing correction (0.2.2)

Date: 2026-11-26 (Asia/Shanghai). Scope: user-reported Gemini Responses 404 in Magpie; user authorized using the existing model Key for bounded live verification and publishing a v0.2.2 patch. No production credential, account setting, key rotation or check-in was changed.

## Root cause

The old family classifier selected Responses for every non-Claude model, grouped `gemini`/`google` endpoint metadata into Responses, forced every model base to `/v1`, and denied native `/v1beta/models/...:generateContent` routes at the final loader boundary. An account listing the Gemini IDs therefore did not establish a usable protocol.

Anonymous `/api/pricing` lists carbon/neon/2.5-pro. The user's read-only `/v1/models` returned 18 models including these Gemini IDs but no endpoint-type declarations. Current site-declared documentation is [docs.anyrouter.top](<https://docs.anyrouter.top>); it describes Claude setup and does not establish Gemini routing. Results from similarly named unrelated domains were not used as site evidence.

## Authorized live evidence

Exactly six short-output requests were used, plus read-only metadata GETs. The model Key stayed in process memory and was never printed or saved. All POSTs were manual single-shot probes, not automatic fallback/retry; no carbon capacity retry was attempted.

| Model / route | Observed result |
| --- | --- |
| carbon native generateContent | HTTP 500: model load reached its limit; not claimed as successful inference |
| carbon Chat Completions | HTTP 404 Invalid URL |
| carbon Anthropic Messages | HTTP 404 |
| neon native streamGenerateContent | HTTP 200 SSE with candidates; short-output cap reached |
| 2.5-pro native generateContent | HTTP 404; not claimed as supported/available |
| neon through corrected plugin loader | HTTP 200 SSE, candidate content, STOP completion |

This establishes the native Gemini route and a successful neon request at the observation time. It does not guarantee future availability, carbon capacity, 2.5-pro access, long contexts or every tool workflow.

## Patch contracts

- Gemini default: `@ai-sdk/google`, official `/v1beta`; Claude/cc-format and GPT defaults unchanged.
- Explicit user SDK and recognized account endpoint types remain authoritative; unknown metadata shapes are ignored, not interpreted as SDKs.
- Discovery stays `/v1/models`, separate from generation API versions. Config/preview/fallback/runtime use consistent protocol bases.
- Only precise native generateContent/streamGenerateContent actions are newly permitted at official HTTPS origin; files/delete/cache operations, foreign URLs and encoded path tricks remain rejected.
- Native loader uses the account `x-goog-api-key`, removes gateway query Key and site/other-protocol credentials, retains signed body bytes and caller signal, and blocks credential redirects.
- No automatic alternate-protocol request or retry is introduced.

## Verification

- Eight new [native-routing regressions](<../../test/gemini-routing.test.mjs>) failed on the old implementation and passed after repair; they cover defaults, explicit overrides, preview/failure fallback, discovery, exact paths, signed contents, authentication, redirect and single-fetch behavior.
- Existing tests expecting the incorrect Gemini Responses default were updated to assert native Google while preserving GPT, unknown-action rejection and per-SDK base checks.
- [Installed-host suite](<../../test/host.integration.test.mjs>) now verifies both discovered Gemini SDKs/bases plus native nonstream/stream loader round trips with signed content and the exact account credential boundary in a loopback fixture.
- Full Node: 455 total, 452 passed, 0 failed, 3 ordinary opt-in skips. Full Bun: 431 total / 27 files, 428 passed, 0 failed, 3 skips. All three opt-in installed-host/CLI tests separately passed with zero skips. The final unknown-metadata parser tightening was additionally checked by the focused native suite; the exact release ref is also gated by remote CI.
- Metadata graph, actual private-sentinel archive and offline import gates passed: 19 runtime modules / 28 published files; no dependency installation.
- A review mutation of the Gemini-family condition in a test-owned minimal source copy failed its native classifier assertion; unmutated control passed and working source remained byte-identical.

## Update behavior

After installing the patch, use Magpie's “重新获取模型”. If a Gemini model has an explicit old Responses SDK override, restore the default or choose `@ai-sdk/google` / `https://anyrouter.top/v1beta`; the plugin deliberately does not overwrite explicit user choices. Existing account keys and sessions do not require relogin.

The user approved a new GitHub patch Release, not npm publication or modifying the local production provider. The old v0.2.1 tag remains immutable. Published release/CI results must be verified at their exact ref rather than inferred from these local results.
