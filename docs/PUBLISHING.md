# GitHub publication

## Official route

Magpie's [plugin documentation](<https://usemagpie.ai/docs/zh/plugins#发布与上架>) supports standalone npm or GitHub packages. For a GitHub plugin, keep the package manifest at repository root and commit the directly loadable entry/runtime files. A `magpie-plugin` repository topic enables the **unofficial GitHub discovery** section; it does not imply official review or recommendation-list acceptance.

This project publishes from [Guardinary/opencode-anyrouter-auth](<https://github.com/Guardinary/opencode-anyrouter-auth>) as a standalone repository, not a GitHub fork. Each published version has a tagged GitHub Release with the package tarball and SHA-256 checksum; 0.2.4 adds balance-first cached usage, shared console cooldown and GUI opt-in external usage with verified current-Key exclusion and separately warned same-Key best-effort matching. No same-name upstream npm publication or recommendation-registry PR is part of this release.

## Repository contents

- Root package manifest, source entry, runtime `.mjs`, icon, LICENSE and public documentation must be committed; no postinstall build is required.
- `reference/` checkouts and machine-local agent tooling are excluded in `.git/info/exclude` only. Do not put reference exclusion in the shared `.gitignore` or commit nested repository gitlinks.
- Dependency installations, private word lists, environment files, generated tarballs and ordinary local logs are not committed. Reviewed synthetic acceptance logs may be explicitly staged so historical evidence links remain resolvable.
- Keep artifact generation separate from production profile changes, live login/check-in, key mutation and paid model probes.

## Before publishing

```sh
pnpm test
pnpm run check:package
pnpm run check:pack
```

CI pins pnpm 10.26.0 or a reviewed later version: `pack --dry-run` was [introduced in pnpm 10.26.0](<https://pnpm.io/10.x/cli/pack#--dry-run>), so older CI tool pins cannot run the existing archive fixture. Do not remove the pack gate to work around an unsupported flag.

Offline archive smoke normalizes both source and `fs.cp` filter paths to the same Windows namespaced form and verifies each copied dependency's manifest before import. This prevents Node 20 on Windows from silently filtering out the entire installed package root. The package regression exercises a real copy/import through both path representations.

Run installed Bun and the isolated host gates when the runtime/host contract changes. Validate no private files, local tooling, reference files or gitlinks are tracked. Review the final commit and generated archive, then publish the exact commit via `main` and an immutable version tag.

For this repository, the official discovery topic is `magpie-plugin`. Use a descriptive `AnyRouter <version> — <topic>` release title and Chinese topic-led Markdown notes: introduction, `### 安装` or `### 更新`, capability/fix boundaries, `### 验证`, download/checksum instructions and relevant explicit limits, following the [0.2.1](<https://github.com/Guardinary/opencode-anyrouter-auth/releases/tag/v0.2.1>) and [0.2.2](<https://github.com/Guardinary/opencode-anyrouter-auth/releases/tag/v0.2.2>) style. Notes must distinguish implementation guarantees, locally executed checks, remote CI and unverified upstream availability; do not substitute a terse English bullet summary or call configured matrix cells passed before Actions succeeds.

## Consumer installation

```sh
magpie plugin add github:Guardinary/opencode-anyrouter-auth#v0.2.4
magpie plugin login anyrouter
```

Removing the tag suffix follows default-branch updates. Installation downloads a package/dependencies; logging in and querying an account are separate user-controlled operations. A repository Release does not upgrade an already configured production gateway.
