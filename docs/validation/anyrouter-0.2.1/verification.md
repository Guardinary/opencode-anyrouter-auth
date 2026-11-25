# Final AnyRouter hardening verification

## Completion status — 2026-11-24 (Beijing time)

The authorized implementation, offline regression, installed-host isolation, public documentation, package validation and separate lead-only adversarial self-review are complete. Source version is **0.2.1, not published**. No production Magpie profile or credential was edited; no live check-in, model probe, key mutation, deployment or dependency reinstallation was performed during final validation.

The user requested no additional agents. [Final self-review](<adversarial-review.md>) is explicitly a deliberate review by lead, not a second model or independent person.

## Final execution evidence

| Gate | Evidence / command | Result |
| --- | --- | --- |
| Portable Node suite | `pnpm test -- --test-reporter=tap`; [log](<final-node-verified.log>) | 445 total, 442 passed, 0 failed, 3 explicit opt-in host skips; exit 0 |
| Bun suite | installed Bun `test --isolate --max-concurrency=1 test/`; [log](<final-bun-verified.log>) | 421 total / 26 files, 418 passed, 0 failed, 3 host skips; exit 0 |
| All enabled real-host/CLI tests | explicit installed paths through [sandbox wrapper](<../../../scripts/sandbox-check.sh>); [log](<final-host.log>) | 3 passed, 0 failed, 0 skipped; 5 actual CLI-spawned hosts produced the loopback fence marker |
| Syntax | `node --check` for entry, runtime, dev/test and fixture modules | passed before the final test run |
| Metadata/import graph | `pnpm run check:package` | version 0.2.1, 19 runtime modules, 28 files; no-network import passed |
| Actual archive/private exclusion/import | `pnpm run check:pack`; [log](<final-pack.log>) | private sentinels absent in real decompressed tarball; actual unpacked runtime imported using the installed dependency closure |
| Final deliverable file list | `pnpm pack --pack-destination dist --json`; [report](<final-pack-report.json>) | 28 explicit files, all runtime imports/assets present; no private JSON, logs, tests or reference directories |
| Mutation check | [evidence](<final-mutation.json>) | baseline 0, inverted guard 1; regression caught mutation; original source byte-identical afterward |
| Whitespace | EOL-aware baseline `git diff --no-index --check`; [log](<round-7-whitespace.log>) | passed; ordinary CRLF was not misrepresented as trailing source whitespace |
| CI structure | installed `Bun.YAML.parse` plus matrix/ignore-scripts assertions | YAML parsed; Node 20/22/24 × Ubuntu/Windows and Bun jobs configured; not a remote execution claim |

Node and Bun count nested tests differently. The three ordinary skips were separately run with no skips. No lint or static type-check script is configured; syntax and runtime tests are the checks actually executed.

## Deliverable

The acceptance artifact was the local `opencode-anyrouter-auth-0.2.1.tgz`; generated tarballs are not source-tracked. The SHA-256 below belongs to that historical local artifact, not a claim about a rebuilt distribution asset. Current distribution is available through the [GitHub Release](<https://github.com/Guardinary/opencode-anyrouter-auth/releases/tag/v0.2.1>), whose attached checksum describes its own tarball.

Historical acceptance SHA-256:

```text
b580bb34aa5c1188e0e7f618bfcf0480e22ea24009ce2707b667661091870469
```

Runtime dependency closure used for offline import: tough-cookie 6.1.0, tldts 7.5.5, tldts-core 7.5.5. These were copied from already installed packages, not downloaded or installed. The [lockfile](<../../../pnpm-lock.yaml>) remains authoritative for project setup.

## Repaired and verified boundaries

- Remote VM/eval/Function execution removed; known unique 40-hex arg1 uses local math; all POSTs single-shot.
- Versioned origin/path/expiry/prefix-aware jar, fixed Max-Age, deletion and no stale-cookie fallback/revival.
- UID queue and generation/snapshot guard; rotation carried through GET/page/POST; latest host fields preserved; one save attempt; server-confirmed success survives local save failure.
- Read-only explicit Key ID selection and honest balance-only mode; no creation/rotation or guessed ambiguous Key.
- Config/runtime schema conversion, explicit false/SDK/capabilities, authoritative successful/empty lists and keyless zero-model/no-network behavior.
- Independent Claude/Codex switches and final official credential destination/redirect guard.
- Unknown/signed/opaque request history and semantic response bytes preserved; detached tool-output pairs checked; bounded/cancellable reads and replay.
- Known diagnostic credential echoes redacted; invalid UTF-8/unknown completion state handed off; stale digests removed.
- Same rate for numeric/text quota, extreme-rate single quota visible, 18-place truncation documented; duplicated/incomplete/invalid daily logs stay unknown, cancellation stops fallback.
- Private JSON excluded by runtime `.mjs` whitelist and real pack sentinel regression; source reuse notice corrected.

## Host environment and isolation

Verified Node 26.5.0, installed Bun 1.4.5, actual Magpie CLI 0.1.4720. RPC checks cover cached host-acc034d984c6.js and host-9897559a62af.js; actual CLI was observed using the latter. Its host cwd is the test-owned magpie config directory, not guessed from caller HOME or cache mtime.

Initial CLI attempts correctly stopped before credential-bearing steps when the fence was absent. Runtime local preload was then placed at the measured cwd; official-origin traffic is redirected only to the test-owned loopback server and system proxy forwarding is disabled. No fake credential was knowingly sent to the live site by the final harness.

The first mutation fixture copied pnpm's root dependency layout incorrectly and failed to resolve tldts. It was diagnosed as fixture layout, not called a product failure or caught mutation; explicit installed dependency-closure copying resolved it. The real package fixture also uses that verified strategy.

## Documentation, specification and task state

[README](<../../../README.md>), [security](<../../../SECURITY.md>), [design](<../../../DESIGN.md>), [changelog](<../../../CHANGELOG.md>) and [provenance](<../../../UPSTREAM.md>) reflect actual behavior and distinguish history from current evidence. [CI](<../../../.github/workflows/ci.yml>) installs frozen dependencies with lifecycle scripts disabled, uses portable explicit test filenames and actual package checks.

[Root code-spec](<../../specs/runtime-contracts.md>) captures signatures, storage/env contracts, error matrix, good/base/bad cases, tests and wrong/correct examples. At the original validation date, legacy package/task metadata pointed to the root plugin rather than the reference repository; both reference repositories were clean.

Historical record: at acceptance, root had no Git repository and no root commit/PR/merge was claimed. This dated acceptance record does not assert the current repository or release state. The maintained root contracts above remain authoritative.

## Explicit limitations

- Queue/snapshot protection is not cross-process atomic CAS; identical-value legacy ABA cannot be detected.
- Raw model responses/headers are not universal DLP targets; consumers still need safe logs.
- Node 20/22/24 / remote CI and original OpenCode loader are not independently executed here; configuration alone is not proof.
- No fresh registry installation, publication, real reward or current upstream Claude availability is claimed. Historical upstream failures remain possible.
- Dependency behavior/versions/lock and licenses were reviewed, not a live vulnerability-database clearance.

No remaining independently confirmed critical/required defect was found in the final reviewed scope. No relevant background jobs or owned terminals remain.
