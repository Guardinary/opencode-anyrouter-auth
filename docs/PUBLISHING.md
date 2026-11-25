# GitHub publication

## Official route

Magpie's [plugin documentation](<https://usemagpie.ai/docs/zh/plugins#发布与上架>) supports standalone npm or GitHub packages. For a GitHub plugin, keep the package manifest at repository root and commit the directly loadable entry/runtime files. A `magpie-plugin` repository topic enables the **unofficial GitHub discovery** section; it does not imply official review or recommendation-list acceptance.

This project publishes from [Guardinary/opencode-anyrouter-auth](<https://github.com/Guardinary/opencode-anyrouter-auth>) as a standalone repository, not a GitHub fork. Version 0.2.1 has a tagged GitHub Release with the package tarball and SHA-256 checksum. No same-name upstream npm publication or recommendation-registry PR is part of this release.

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

Run installed Bun and the isolated host gates when the runtime/host contract changes. Validate no private files, local tooling, reference files or gitlinks are tracked. Review the final commit and generated archive, then publish the exact commit via `main` and an immutable version tag.

For this repository, the official discovery topic is `magpie-plugin`. Release notes must distinguish known implementation guarantees, locally executed checks, remote CI results and unverified upstream availability. Do not call configured Node/OS matrix cells passed until GitHub Actions actually reports success.

## Consumer installation

```sh
magpie plugin add github:Guardinary/opencode-anyrouter-auth#v0.2.1
magpie plugin login anyrouter
```

Removing the tag suffix follows default-branch updates. Installation downloads a package/dependencies; logging in and querying an account are separate user-controlled operations. A repository Release does not upgrade an already configured production gateway.
