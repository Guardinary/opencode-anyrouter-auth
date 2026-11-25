# Project constraints

Last reviewed: 2026-11-25 (Asia/Shanghai). This records the existing AnyRouter quality and safety bar, not a new framework or a new coverage/security promise. The user authorized a public standalone Guardinary/opencode-anyrouter-auth repository and GitHub v0.2.1 Release; no npm publication, recommendation-list PR, production deployment or key changes are included.

## Standing floor

- Preserve existing checks, thresholds, assertions and behavior-sensitive regressions. Do not skip/delete tests, suppress checks or weaken a guard to get green without explicit justification and review.
- No real secrets in source, shared evidence or logs. Synthetic fixtures must remain clearly synthetic and offline.
- No unimplemented placeholders or silent error suppression that hides a failure. Existing intentionally ignored cleanup/fail-open errors must retain their documented semantics; this is not a blanket ban on every empty catch.
- No remote JavaScript execution, model inference replay, credential-bearing foreign destination or invented account balance.
- Preserve unknown/signed/opaque input and response state. Only proven-empty response metadata may be discarded or repackaged.
- Do not lower this file's bar to make another change pass. Exceptions require explicit rationale and user approval for consequential behavior.

These floor rules are reviewed, not falsely advertised as scanner-enforced. The existing regression/packaging controls below automate specific parts of the bar.

## Existing executable gates

| Dimension | Requirement and rationale | Actual command | When |
| --- | --- | --- | --- |
| Runtime regression | Exit 0 and zero failed tests; protect the demonstrated credential, lifecycle, model, protocol and quota contracts | `pnpm test` | Related tests during behavior edits; full suite after material integrated changes |
| Module syntax and import | Every runtime import resolves, metadata remains valid, and startup performs no HTTP; avoid a tarball that only works inside the checkout | `pnpm run check:package` | Runtime/import/metadata changes; CI |
| Archive safety | Private-file sentinels absent from real tarball, complete runtime file list and actual offline import; prevent local secrets/word lists entering publication | `pnpm run check:pack` | Publish-file/dependency/pack changes; final delivery; CI |
| Bun compatibility | Exit 0 and zero failed tests on the installed supported host runtime | `bun test --isolate --max-concurrency=1 test/` | Runtime changes when Bun is available; CI |
| Installed Magpie integration | Three explicit opt-in tests pass against test-owned storage/loopback; fence failure stops credential steps | Set native absolute `MAGPIE_TEST_HOST`, `MAGPIE_TEST_BINARY`, `MAGPIE_TEST_BUN`, then `pnpm run test:host` | Host API/schema/request behavior changes and installed-host acceptance |
| Dependency reproducibility | Frozen lockfile and lifecycle scripts disabled; no unsolicited reinstall | `pnpm install --frozen-lockfile --ignore-scripts` | Authorized environment setup or CI, not automatically every edit |

Every failed applicable gate blocks completion of affected work until corrected or an explicit limitation is accepted. Existing tests use 3 opt-in host skips in ordinary offline runs; the host acceptance run must exercise them separately with zero skips. Missing runtimes/scanners are reported, not silently replaced by a passing assertion.

The Node gate uses explicit test filenames via `scripts/test.mjs`, avoiding Windows shell-glob differences. CI covers Node 20/22/24 × Ubuntu/Windows and Bun jobs, but CI configuration is not evidence of execution. Node minimum is 20.3.0 because the login code uses `AbortSignal.any`.

## Existing bounded behavior

These are current implementation limits justified by protecting memory, latency, credential scope and data integrity. They are assertions/contracts, not measured performance benchmarks.

| Boundary | Current limit | Owner / validation |
| --- | --- | --- |
| Serialized cookie state | 128 KiB / 256 cookies | Cookie hardening regressions and `lib/cookies.mjs` |
| Site response body | 2 MiB, within operation deadline | Site/lifecycle tests and `lib/site-client.mjs` |
| JSON diagnostic clone | 64 KiB / 2 seconds | Response bounds/hardening tests |
| SSE prelude | 64 KiB / 15 seconds; release on content or uncertainty | Response replay/backpressure/proof tests |
| Request inspection | 4 MiB / 2 seconds | Request replay/protocol tests |
| Anonymous registry data | 32 MiB; private metadata deadline | Registry tests |
| Daily log fallback | 100 entries/page / at most 20 pages, complete nonduplicate total | Usage/pagination tests |
| Default quota conversion | 500000 quota/USD, one rate for text and numeric wallet | Usage tests; unusual rates bounded to 18 decimal places |

## Historical measured baseline, not new thresholds

The [2026-11-24 evidence](<docs/validation/anyrouter-0.2.1/verification.md>) records Node 26.5.0: 445 total / 442 pass / 0 fail / 3 skips; Bun 1.4.5: 421 total / 418 pass / 0 fail / 3 skips across 26 files; installed Magpie 0.1.4720: 3 integration passes / 0 failures / 0 skips.

Node/Bun aggregate counts differ. Counts are not a coverage percentage or a rule that a future valid refactor must retain exactly that number. Any removal/replacement of assertions still requires review against their contract.

The [review evidence](<docs/validation/anyrouter-0.2.1/adversarial-review.md>) includes an isolated mutation experiment: a correct guard passes; the inverted same-UID guard fails; working source stays unchanged. The package fixture also tests a real private-file violation and clean import control.

## Not yet tool-enforced / not claimed

- No configured linter, static type checker, coverage ratchet, project mutation score, vulnerability scanner or secret scanner is claimed. Do not invent thresholds or install tools merely to satisfy this document. New automated dimensions need explicit scope/authorization and known-violation plus clean-control validation.
- This library/provider has no preview web UI; Lighthouse/axe budgets do not apply without a separate UI task.
- No live vulnerability-database clearance, Node20/22/24 local results, remote CI result or independently verified original OpenCode loader is claimed by the historical baseline.
- No generic task-end 90-second SLA is imposed: use the smallest sufficient affected checks and keep expensive full/pack/host runs out of the per-edit loop.

## Non-negotiable scope and explicit limitations

- Reference repositories stay unchanged unless explicitly targeted. No new agent delegation under the user's standing lead-only request.
- No live check-in, key creation/rotation/deletion, credential edits, dependency installation, publication, deployment, destructive Git action or file deletion/move beyond current authorization.
- UID queues and credential snapshots are best-effort in-process protection, not cross-process atomic CAS. Identical-value legacy ABA remains undetectable without generation.
- Generated diagnostics redact known credentials; raw successful/partial/unknown model bytes and transport headers are not universal DLP targets.
- A borrow-installed-dependencies archive smoke proves offline import, not a fresh registry installation.

## Specification and workflow

Read [runtime contracts](<docs/specs/runtime-contracts.md>) before changing covered behavior. Acceptance requires independently justified regression expectations, applicable gate results and explicit remaining limits. Use current engineering skills directly; do not reintroduce Trellis or a replacement framework automatically.

No new quality exception is introduced by repository publication. Existing deliberate fail-open cleanup and explicit host-test opt-in behavior are documented above, not newly weakened controls.
