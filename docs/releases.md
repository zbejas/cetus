# Releases - versioning and publishing

## Overview

Cetus ships one multi-arch container image and one GitHub Release per version. The `version` field in the root `package.json` is the only version source; the server imports it in `apps/server/src/config.ts` for the UI and health endpoints. A release is created only when that version has no matching GitHub Release yet, so ordinary `package.json` edits and workflow edits are safe no-ops.

## Key files

| File | Purpose |
|---|---|
| `.github/workflows/ci.yml` | Pull request and master verification: typecheck, unit tests, web build, container build without pushing |
| `.github/workflows/release.yml` | Version check, release verification, GitHub Release creation, and compose asset upload |
| `.github/workflows/docker-publish.yml` | Reusable GHCR image build for `linux/amd64` and `linux/arm64` |
| `package.json` | Single source of the release version in the `version` field |
| `apps/server/src/config.ts` | Imports the root `package.json` version for the UI, health endpoint, and worker handshake |
| `Dockerfile` | Multi-stage production image built from the Bun install and `dist/web` output |
| `compose/manager.yaml` | Manager container definition, published as a release asset |
| `compose/worker.yaml` | Worker container definition, published as a release asset |

## How it works

### Version bump

1. Update the `version` field in `package.json`.
2. Run `bun run typecheck`, `bun run test`, and `bun run build:web`.
3. Open a PR with the version bump and the behavior changes.
4. Merge to `master`.

Use patch versions for fixes and minor versions for features. Major versions are reserved for breaking changes. The release workflow does not bump versions.

### CI

`.github/workflows/ci.yml` runs on every pull request and every push to `master`:

```text
typecheck -> unit tests -> build:web
                      \-> container build (no push)
```

The container job catches Dockerfile breakage before a release. Playwright is not part of CI because the E2E suite expects a seeded Docker host and stack fixtures.

### Release pipeline

`.github/workflows/release.yml` runs when `package.json` or either release workflow changes on `master`, and can be started manually.

```text
version job
  read package.json version
  skip when GitHub Release v<version> exists
        |
        v
verify job
  install, typecheck, unit tests, build:web
        |
        v
docker job
  reusable docker-publish.yml
  build amd64 + arm64, push GHCR
        |
        v
release job
  gh release create v<version>
  attach manager and worker compose files
```

The image is pushed before the GitHub Release is created. A failed image build therefore leaves no release without its image.

### Image tags

The publish workflow resolves the version and pushes:

| Tag | When |
|---|---|
| `<version>` | Every release, including pre-releases |
| `<major>.<minor>` | Stable releases only |
| `<major>` | Stable releases only, and only when the major version is not `0` |
| `latest` | Stable normal releases through the release workflow; not forced rebuilds, pre-releases, or manually published releases |

Images publish to `ghcr.io/zbejas/cetus`. The workflow derives the image name from `github.repository`, so a repository move follows automatically, but the two compose files must be updated.

A version with a pre-release suffix such as `0.2.0-rc.1` gets only the full `<version>` tag. The GitHub Release is marked as a pre-release and the `latest` tag is not moved.

### Manual rebuilds

Run **Release** with `force` enabled to rebuild and push the image for the version already in `package.json`. Verification runs again, the existing release is left in place, and `latest` is not moved. The verification and image build check out the existing `v<version>` tag, so the rebuild matches the release even when `master` has moved. Use this to recover a failed image push, not to publish a new version.

Publishing an existing release by hand in the GitHub UI runs `docker-publish.yml` through its `release: published` trigger. That path publishes the version tags but does not move `latest`; only the release workflow's explicit call does.

## Gotchas & invariants

- The release gate is a GitHub Release lookup by tag `v<version>`, not a tag lookup. A version with a stale tag and no release can still create the release.
- A release created with `GITHUB_TOKEN` does not trigger another workflow. The release job calls the reusable Docker workflow directly for this reason.
- The release workflow only reads the root `package.json`. Do not add a second product version in `apps/` or `packages/`.
- The server imports `package.json` at runtime. Keep it in the image and do not replace it with a hardcoded version.
- Changing only source files does not trigger a release. Bump the version in the PR that should ship.
- `latest` moves only when the reusable workflow is called with `latest=true` for a stable version. Forcing an old version rebuild or publishing a release manually does not roll `latest` backward.
- A forced rebuild checks out `v<version>`, not the current `master` HEAD. The image therefore matches the code that was released.
- The Docker build needs QEMU for `arm64`. Keep the QEMU setup step before Buildx.
- Release assets are the compose files from the tagged commit. If compose paths move, update `.github/workflows/release.yml`.
- `compose/manager.yaml` and `compose/worker.yaml` reference `ghcr.io/zbejas/cetus:latest`. Update both if the repository owner changes.
- `compose/worker.yaml` requires `CETUS_MANAGER_URL` and `CETUS_ENROLL_TOKEN` at deploy time. It has no hardcoded manager host.
- The E2E suite is local-only for now. It expects Chrome and uses a local Docker host when stacks and logs are available; see `e2e/smoke.spec.ts` and `playwright.config.ts`.
- The visual suite is local-only and is not a CI gate. Run `bun run test:visual` before shipping UI changes; see `e2e/visual.spec.ts` and `playwright.visual.config.ts`.

## Related docs

- [Root README](../README.md) - install, run, and feature overview
- [Development](development.md) - local commands and test gates
- [Settings and configuration](settings.md) - runtime settings and restart boundaries
- [Worker mode](worker.md) - worker deployment and protocol
- [Docs index](README.md) - documentation map
- [.github/workflows](../.github/workflows) - workflow source of truth
