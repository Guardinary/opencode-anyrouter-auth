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

Second slice verified on 2026-11-26 (Asia/Shanghai): canonical Google RESOURCE_EXHAUSTED/UNAVAILABLE and exact Chinese saturated-load wording are recognized only before semantic output. Real HTTP500/503 require an explicit meaningful error boundary and retain their transport status; detail-less/unknown bodies stay original. Chinese quota/balance/permission failures and Google authentication/permission markers veto transient diagnosis. Native generated errors have numeric code/canonical status; existing SDK shapes and HTTP400/429 behavior remain unchanged. No inference replay was introduced.

The initial 15 new tests had 12 failures before implementation. Final 16 new tests pass, including a review-found SSE media-type parameter case reproduced before its fix. Existing assertions were preserved unchanged. Final full Node: 483 total / 480 pass / 0 fail / 3 opt-in host skips. Bun 1.4.5: 459 total / 456 pass / 0 fail / 3 opt-in host skips. Package graph/import: 19 runtime modules / 28 published files, passed. An isolated outer-business-guard mutation failed its assertion (exit 1), while the clean control passed (exit 0); working source was not mutated. Installed Magpie 0.1.4795 with host-acc034d984c6: all three isolated host/CLI tests passed, zero failures/skips, five fenced CLI host launches. No production auth/config was changed.

Pricing/log research used the configured smart-search CLI. Its research command does not accept --timeout; that parse-only failure was corrected using SMART_SEARCH_TIMEOUT_SECONDS. Retrieval returned candidate source pages but the fetched excerpts were GitHub navigation rather than sufficient formula/schema proof. Do not treat retrieval success as verified pricing or external provenance.

Follow-up exact source fetches succeeded through smart-search:

- [New API price calculation](https://raw.githubusercontent.com/QuantumNous/new-api/main/web/src/features/pricing/lib/price.ts): token input USD base is `model_ratio * 2 * selectedGroupRatio`; output multiplies completion_ratio. Missing cache ratios produce NaN/unknown, not free. Per-request pricing is a separate quota_type. This proves the upstream reference formula, not AnyRouter's selected group or fork compatibility.
- [New API log schema](https://raw.githubusercontent.com/QuantumNous/new-api/main/model/log.go): current user-log formatting replaces database `id` with display row positions; those IDs are not stable request identities across different queries. Stable request_id is a separate field and must be verified on the actual fork. Consume rows include prompt_tokens/completion_tokens/quota/model_name/user_id/created_at; cache_write_tokens is normalized separately. No reliable magpie/non-magpie provenance is established by this file.
- Exact retrieved evidence is in `/tmp/anyrouter-upstream-price-20261126.md` and `/tmp/anyrouter-upstream-log-20261126.md` (temporary local research, not package artifacts).

Third slice verified on 2026-11-26 (Asia/Shanghai): [AnyRouter public pricing](https://anyrouter.top/api/pricing) was retrieved read-only with smart-search (Tavily returned no content; Firecrawl returned success, no provider notices). [The deployed public frontend](https://anyrouter.top/assets/index-BLWZRx7E.js) independently shows `model_ratio * 2 * group_ratio` input and `model_ratio * completion_ratio * 2 * group_ratio` output, displayed as USD / 1M tokens; it selects the logged-in user's group, otherwise default. This proves the AnyRouter formula, but not any particular account's current billing group. Markdown extraction was decoded only for static reading; no remote code executed. Saved public evidence is `/tmp/anyrouter-public-pricing-20261126.json` and `/tmp/anyrouter-frontend-pricing-20261126.json`.

Price mapping now preserves explicit user cost (including zero) and supports public group quotes only with explicit `provider.anyrouter.pricingGroup`. Unknown/unselected groups, duplicate rows, fixed-request prices, missing cache ratios and overflow/nonzero underflow stay unknown. No maker prices or guessed Magpie rate are used, and no production config is changed. Offline conversion of the actual retrieved public payload gives default-group neon 2/10 and carbon 4/20 USD per million input/output tokens; this is not an inference/availability or actual-account-bill claim.

The initial ten new price tests had five failures before implementation. All final eleven pass on Node and Bun, including a review-found nonzero underflow reproduced before its fix. Neighboring model/protocol suites passed (57 assertions/tests at that checkpoint). An isolated eligibility-guard deletion mutation fails (exit 1 / AssertionError) while the control passes (exit 0), working source unchanged. The new runtime module changes the exact package inventory from 19/28 to 20 modules/29 files; stale count assertions were updated without weakening them after their explicit failure.

Final pricing gates: Node 494 total / 491 pass / 0 fail / 3 opt-in host skips; Bun 470 total / 467 pass / 0 fail / 3 opt-in host skips. Package graph/import passed (20 modules / 29 files); actual archive private-sentinel exclusion and borrowed-dependency offline import passed. All three current Magpie isolated host/CLI tests passed with zero skips/failures, including numeric quote mapping, explicit zero override, no maker-price inheritance, failed-discovery behavior and anonymous pricing credential assertions.

Browser preflight now reports no active backend/connection and zero task spaces; no login/CAPTCHA bypass or automatic profile changes were attempted. Public frontend references cache_tokens and cache_creation_tokens with protocol-specific accounting, but does not establish stable request identity or magpie/non-magpie provenance. Need a user-enabled browser connection and authenticated read-only log schema before safely implementing the outside-magpie hook.

Remaining: safe authenticated external-usage import with stable request IDs and non-gateway provenance, final whole-scope review/CI/release. No framework was initialized.
