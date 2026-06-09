# Install & Distribution Design

**Date:** 2026-06-09
**Branch:** `feat/install-distribution`
**Status:** Implemented

## Problem

jrun is intended for a small internal team (Java devs on WSL/Linux). Installation
should be easy and ideally driven through `mise`, which the team already uses for
toolchain provisioning. The distribution story was half-built and broken:

- `install.sh` and the README assumed a single-binary-on-GitHub-Releases model, but
  `release.yml` built and uploaded no binary, so `install.sh` failed and there was
  nothing for `mise` to install.
- The README advertised `npm i -g github:jedburrows/jrun` "from source," which did
  not work (`dist/` is gitignored, no build-on-install hook).

## Decision: publish to the npm registry (the industry standard)

jrun is a Node/TypeScript CLI for developers. The normal, best-practice way to ship
such a tool is to **publish it to the npm registry and install via `npm i -g` /
mise's `npm:` backend** — the same path used by Wrangler, Prisma, Gatsby, the Gemini
CLI, etc. We publish as a **public scoped package, `@jed-dev/jrun`** (the
unscoped `jrun` name is already taken on npm).

Why this over the alternatives we explored:

- **Runs on real Node** — the runtime jrun was written and tested on. This is
  decisive: jrun's core job is subprocess/PID/kill management on WSL, so it should
  run on its target runtime, not a compatibility layer.
- **mise-native** — `mise use -g npm:@jed-dev/jrun` works through mise's `npm:`
  backend, and mise also supplies the Node runtime. The "always via mise" goal is
  fully met.
- **Boring, battle-tested CI** — `npm publish --provenance` on a `v*` tag (~15
  lines), with supply-chain provenance for free.
- **Tiny + semver** — ~48kB package, real version pinning, no exotic toolchain.

### Rejected approaches and why

- **Node SEA single binary:** dead end — SEA runs a CommonJS blob, but `ink` and
  `yoga-layout` require top-level await, which esbuild cannot bundle to CommonJS.
  Confirmed not just project-specific (Ink maintainer won't fix: ink#787, ink#844).
- **Deno `compile` binary:** validated working end-to-end (CLI, subprocess, and the
  Ink TUI with yoga WASM), but it ships jrun on Deno's Node-compat layer rather than
  Node — an unnecessary runtime substitution for a process-management tool, and a
  94MB artifact + multi-step build for a portability benefit a mise-based team does
  not need. Abandoned in favor of npm.
- **`npm i -g github:jedburrows/jrun` (git install):** viable with a `prepare`
  script, and runs on real Node, but rebuilds from source on every install and is
  **not mise-managed** (mise's backends don't drive `github:` specifiers). Worse
  ergonomics than registry publishing.
- **`no npm` constraint:** the original constraint was dropped — its only rationale
  would be privacy, and the repo is already public.

### Out of scope (YAGNI)

Single-binary distribution, GitHub Packages / private registry, macOS/arm64 concerns
(npm is cross-platform by nature).

## Changes

### 1. `package.json`

- Renamed to `@jed-dev/jrun`; added `engines.node >= 22`, `repository`, and
  `publishConfig: { access: public, provenance: true }`.
- `prepublishOnly: pnpm build` already builds `dist/` before publish.
- Removed the SEA/Deno build scripts (`build:sea`/`build:bundle`), `esbuild` and
  `postject` devDependencies — all binary-only.

### 2. `.github/workflows/release.yml` — publish on `v*` tag

Build job (runner `ubuntu-latest`): checkout → pnpm install → `pnpm build` →
`npm publish --provenance --access public` (auth via `NPM_TOKEN` secret;
`id-token: write` permission for provenance) → generate notes with git-cliff →
create the GitHub release. Publishes the version in `package.json`, so a release is
cut by bumping the version and tagging `v<version>`.

### 3. Docs — `README.md` and `CLAUDE.md`

Install via `mise use -g npm:@jed-dev/jrun` (primary; also supplies Node) or
`npm i -g @jed-dev/jrun`, with a shared `mise.toml` example provisioning
`node` + `java` + `ripgrep` + the package. Removed the binary/install.sh and
npm-from-source instructions.

### 4. Removed files

`scripts/build-binary.sh`, `scripts/stubs/react-devtools-core.mjs`, `install.sh`,
`sea-config.json`.

## Data flow

```
bump version in package.json → git tag vX.Y.Z → push
   └─► release.yml (ubuntu-latest)
         ├─ pnpm install --frozen-lockfile
         ├─ pnpm build                       (tsup → dist/main.js)
         ├─ npm publish --provenance         (→ npm registry, public)
         └─ git-cliff + action-gh-release    (→ GitHub release notes)

teammate:  mise use -g npm:@jed-dev/jrun   (mise installs Node + the package)
       or: npm i -g @jed-dev/jrun
```

## Verification

- `pnpm build` → `dist/main.js` (~60kB); `node bin/jrun --help` and `jrun list` in
  the example Maven project both work on real Node ✓
- `npm pack --dry-run` → clean 47.7kB package: `bin/jrun`, `dist/main.js`(+map),
  README, LICENSE, package.json ✓

### Owner action items (cannot be automated here)

1. Create the npm account/scope and an automation token; add it as the `NPM_TOKEN`
   repository secret.
2. Release process: bump `version` in `package.json`, commit, `git tag vX.Y.Z`,
   push the tag. CI publishes and cuts the GitHub release.
