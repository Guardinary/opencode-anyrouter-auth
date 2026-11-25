# Final adversarial self-review

Date: 2026-11-24 (Beijing time). Reviewer: lead, in a separate deliberate review pass; no additional agent or independent person participated, as requested by the user.

Migration note, 2026-11-25: this is a historical review, not a new test run. The final evidence and runtime diff below were preserved before the old framework directory was removed; the full old baseline tree is not retained. Current maintained behavior is described in [runtime contracts](<../../specs/runtime-contracts.md>) and [constraints](<../../../CONSTRAINTS.md>).

## Reviewed boundary and reference

The workspace root is not a Git repository. The reviewed reference is the approved pre-hardening baseline snapshot and the current local source, not a fabricated PR head/commit. The [saved runtime diff](<round-7-runtime.diff>) and source reads cover credential codec/session jar, operation queue, site HTTP, catalog/config translation, request normalization/repair, response proof/redaction, quota aggregation, entry/metadata, packaging scripts, CI and public documentation. Both reference repositories were independently checked and remain clean.

## Five-axis result

| Axis | Verified conclusion |
| --- | --- |
| Correctness | Original independently reproduced cookie/rotation/race/output/schema/switch/amount defects have concrete regressions. Current Node/Bun suites and installed-host gates pass. Authoritative empty/keyless account models, single-shot POST, confirmed-success preservation and incomplete-log rejection are covered. |
| Readability | State ownership is explicit in cookies/accounts/account-operations/site-client. Removed stale unused provider imports and after-return initialization comments. Runtime files stay below the large-file threshold; a broad rewrite was integrated in verified slices rather than hidden behind one green count. Dense local formatting is not treated as a reason to add unrelated refactors. |
| Architecture | Cookie storage and account queue are canonical shared boundaries. Config/runtime model schemas are separate, provider orchestration does not own a hidden account pool, and the developer scripts do not become runtime dependencies. Existing module cycles are handled through deferred function use; no new eager import side effect or network startup was found. |
| Security | No remote JS runner remains. Final credential origin/path/redirect checks, UID/generation guards, cookie scope/expiry/deletion, managed headers, known diagnostic redaction and private-file packaging guards are checked. Source attribution and MIT notice for actual reuse were corrected. |
| Performance | Reads, proof depth, paging and deadlines are bounded; normal SSE uses chunk replay/backpressure, not full-body cloning. Cookie operations are serial per UID and metadata is cached. No heartbeat, inference retry loop or extra server was introduced. |

## Problems caught in the deliberate review and resolved

1. Generated diagnostics could copy echoed credentials and structured error-code objects. Fixed by credential-context text/code redaction; semantic/opaque raw responses remain unchanged.
2. Completion/prelude checks treated unknown nested config and future state as empty. Fixed typed proof, all-zero usage and conservative proof-depth exhaustion.
3. Invalid SSE UTF-8 could become a newly parsed error. Fixed fatal decoding with original-byte handoff.
4. Rewritten response digests were stale. Removed content/repr digest headers when rebuilding.
5. Valid extreme quota rates rendered a nonzero single quota as zero. Increased the bounded expansion to 18 digits and documented truncation.
6. Root publish-directory whitelist could include user-created private JSON. Restricted to runtime `.mjs`, validated the actual pack report and decompressed private-sentinel archive.
7. Public docs still described VM execution, no dependency, old result/day behavior and incorrect model config. Updated current contracts and labeled obsolete history.
8. A helper test still asserted the old whole-directory whitelist. Changed it to assert the safe `.mjs` allowlist and exclusion of `lib/`, not to restore the unsafe behavior.

## Mutation experiment

[Mutation evidence](<final-mutation.json>): copied the trusted source, the lifecycle test and the installed dependency closure into an owned temporary tree. Inverted the credential-snapshot inequality in the POST guard, ran the same same-UID-during-preflight regression, and removed only that owned fixture afterward.

- Unmutated copied source: exit 0.
- Mutated guard: exit 1, test failure observed.
- Original working source was byte-identical afterward.

The first copied baseline attempt failed because blindly copying pnpm's root `node_modules` loses transitive sibling resolution. It was diagnosed as a test-fixture dependency-layout problem, not called a product regression or a caught mutation. The successful run explicitly copied the installed package dependency closure, without installation or network.

## Final execution evidence

| Gate | Evidence | Result |
| --- | --- | --- |
| Full portable Node | [log](<final-node-verified.log>) | 445 total, 442 pass, 0 fail, 3 opt-in host skips |
| Full Bun | [log](<final-bun-verified.log>) | 421 total / 26 files, 418 pass, 0 fail, 3 opt-in host skips |
| Explicit real-host/CLI integration | [log](<final-host.log>) | 3 pass, 0 fail, 0 skip; 5 actual CLI host fence launches |
| Actual tarball/private sentinel/import | [log](<final-pack.log>) | 28 published files, private sentinel excluded, archive imported offline with installed dependencies |
| Deliverable pack report | [report](<final-pack-report.json>) | version 0.2.1; all 19 runtime modules present, no private JSON/log/test/reference files |
| EOL-aware whitespace | [log](<round-7-whitespace.log>) | passed; raw CRLF-only false positives were not “fixed” by changing behavior |

## Remaining limitations, not unresolved regressions

- The host supplies no cross-process atomic auth CAS; the queue/snapshot guard is explicitly best-effort. Identical-value legacy ABA remains a documented limitation.
- A raw upstream response/transport header is not universally scrubbed. Only plugin-generated known diagnostics are redacted; consumers must protect their own logs and prompts.
- No fresh online install, npm publication, production profile edit, live check-in, key mutation, or online Claude availability verification was performed.
- Node 20/22/24 and the remote GitHub CI matrix are configuration targets, not locally executed results. Original OpenCode loader compatibility has not been independently verified.
- Dependency versions/lock/behavior and source attribution were reviewed; this is not a claim that a live vulnerability database was queried or that every dependency is vulnerability-free.

## Verdict

**Approve for local delivery within the authorized scope.** No remaining independently confirmed critical or required defect was found in the final reviewed boundary. The limitations above are preserved in the public documentation rather than hidden or described as solved. Do not infer deployment/publication/third-party model availability from this verdict.
