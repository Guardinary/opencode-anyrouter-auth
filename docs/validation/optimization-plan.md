# AnyRouter optimization work

Scope authorized by the user: all proposed model/diagnostic/pricing/native-counting/cleanup/external-usage/community-registry improvements. Lead-only implementation; no production credential/config changes, model retries or npm publication.

## Verified findings and constraints

- Baseline commit: 329508581b184ac3e1513f6a458deb6d96fb5b76 (0.2.2). Installed Magpie is now 0.1.4795; reverify its actual cached host when integrating.
- The local Google registry provides Gemini 4 Neon: context 1048576 / output 65536; Carbon: context 1048576 / output 32768; both have friendly names and explicit reasoning/tool/input modalities. These are maker metadata/fallback limits, not guarantees of relay capacity or every supported media modality.
- Anonymous pricing currently hit a 403 http_ratelimit; do not loop retries. Unknown prices remain unknown.
- Native neon countTokens responded 200 JSON with candidates/promptFeedback/usageMetadata and no totalTokens, not a valid count. Do not manufacture counts or claim upstream counting success; add bounded response validation, preserve legitimate errors, and clearly report unavailable counting.
- Magpie auth.calls signature is `(getAuth, provider, {since, signal}) -> {calls:[{rid,t,model,in,out,cache_read,cache_write,cost?,session?}]}`. rid and epoch-ms time are mandatory; host deduplicates rid and retries a failed read from the same cursor. Token accounting must distinguish cache and ordinary input; never publish partial pages or guess identity.
- Public model_ratio is not automatically a Magpie credit rate. cost is USD per million tokens. Confirm site units/multipliers and map only supported explicit values; preserve user overrides. Do not label unknown/fixed-request prices as free or infer cache prices.
- Only protocolOfURL is imported from protocols.mjs by live source; unused retry/error/stream helpers may be removed after references and regression behavior are checked.
- The recommended registry is magpie-community/plugins registry.json. Inspect its parser/contribution rules before adding a standalone git entry; do not claim a submitted PR is accepted or use a same-name upstream npm package as this plugin.

## Work order and acceptance

1. Friendly declarations + safe native action/path normalization/counting response validation, then remove confirmed unused protocol helpers. Gate: native regression/public schema, no foreign URL/query credential/signature mutation, count incompatibility visible, full tests.
2. Conservative Gemini/Chinese diagnostics and pricing metadata. Gate: business errors win, partial/opaque bytes survive, protocol-compatible error envelope, exact selected units and unknown/explicit-zero distinctions, user overrides.
3. External calls. Gate: authenticated current UID, complete bounded pages, stable IDs, cancellation and cookie rotation, no plaintext request bodies/credentials, no duplication of gateway-known requests when site lacks reliable provenance.
4. Isolated current Magpie host and Node/Bun/pack/CI validation and patch release. Preserve local-only reference exclusion.

## Revised community scope

The official registry validator accepts npm names only (`pkgName`), not GitHub install specs; its current registry has no git entries. After this was confirmed, the user explicitly chose to defer the recommendation PR rather than publish npm or contribute the whole source package. No recommendation PR or npm publication is now part of this round.

## Progress

First slice verified: Gemini4 friendly declarations, official v1/trailing-slash normalization, exact countTokens action and strict standard-count validation, plus removal of confirmed unused protocol helpers. The initial 11 new tests failed before implementation and passed afterward. A twelfth cleanup test now exercises real Response tee cancellation with an unclosed source and an uncooperative cancel; monkeypatching the pre-clone body method was diagnosed as an invalid fixture because Response.clone replaces the exposed body. Invalid-count replacement now cancels the unused original without awaiting it.

Full Node at this boundary: 467 total, 464 pass, 0 fail, 3 opt-in host skips. The focused native suite passed on Node and Bun. All three isolated installed-host/CLI tests passed with zero skips, including standard countTokens shape and credential/signature boundaries. Package import graph and actual private-sentinel archive/import gates passed (19 runtime modules / 28 published files). Counting is not claimed operational on the live relay: its observed candidate-shaped response is explicitly rejected.

Read-only site log/schema inspection was rate-limited too; no repeated API polling or password renewal was attempted. Pricing and external-call conversion must therefore still be grounded in official/source contracts and conservative schema validation, not fabricated live sample fields. No new live generation was used in this optimization phase.

Remaining: conservative diagnostic mapping, proven pricing units and metadata, safe authenticated external-usage import, final whole-scope review/CI/release. No framework was initialized.
