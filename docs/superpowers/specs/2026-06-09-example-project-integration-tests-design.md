# Example Project Integration Tests — Design

**Date:** 2026-06-09
**Status:** Approved

## Goal

Wire the existing `example/` Maven project into the automated test suite as a
real, end-to-end integration test, and stop committing its build artifacts.

The repo already ships an example Maven project (`example/`) with three main
classes covering distinct process shapes:

- `com.example.HelloWorld` — prints and exits immediately (quick-exit)
- `com.example.DataProcessor` — batch job with `--count`/`--label`, then exits
- `com.example.ApiServer` — long-running loop until killed (shutdown hook, `--port`)

Today nothing drives jrun against this project; the existing `JrunApi.test.ts`
exercises the API contract against an empty temp project and never starts a real
JVM. This work adds a true end-to-end test and fixes the committed
`example/target/` artifacts.

## Architecture

A new integration test at `test/integration/example-project.test.ts` drives the
real `JrunApi` — the same Promise seam the CLI and TUI use — against the real
`example/` directory.

- `ProjectRoot` points at the absolute path of `example/`.
- Config / pid / log dirs are a fresh `mkdtemp` per run (mirroring the existing
  `JrunApi.test.ts` wiring), so the real `~/.jrun` is never touched.
- Real `mvn`, real compiled classes, real JVM processes — no mocking.

The runtime/layer wiring is copied from `JrunApi.test.ts` (merge
`JavaProjectLive`, `ConfigStoreLive`, `ProcessManagerLive` over the temp dir
layers and `NodeContext.layer`), with `ProjectRoot` set to `example/` instead of
an empty temp dir.

## Toolchain gate

A `beforeAll` probes for `mvn`, `java`, and `rg` on PATH. If any is missing, the
whole block is skipped via `describe.skipIf(...)`, so a clean box (including the
current dev machine, which has no `mvn`) stays green rather than red.

When the toolchain is present, `beforeAll` runs `mvn -q compile` in `example/` to
produce `target/classes` before any scenario runs.

## Scenarios

Each scenario is a real JVM round-trip. JVM startup is ~1–2s, so scenarios use a
small `pollUntil(predicate, timeoutMs)` helper and generous per-test timeouts
(e.g. 30s).

1. **Discovery** — `listMainClasses()` returns the three FQCNs
   (`com.example.ApiServer`, `com.example.DataProcessor`, `com.example.HelloWorld`).
   (Requires `rg`.)
2. **DataProcessor (batch → exits)** — `start` detached with `--count 2`; poll
   `readLog` until it contains `Done.`; then `listRunning()` no longer lists it.
3. **ApiServer (long-running)** — `start` detached; poll `listRunning()` until it
   appears and `readLog` shows `Server started`; `kill()`; poll until it is gone
   from `listRunning()`.
4. **HelloWorld (foreground)** — `start({ detached: false })` resolves (blocks to
   a clean exit 0).

## Teardown

- `afterEach` kills any class still running (best-effort; `kill` already swallows
  `ProcessNotFound`).
- `afterAll` removes the temp state dir.
- `example/target/` and `example/.jrun-classpath-cache` are left in place as
  gitignored build artifacts.

## gitignore

- Untrack the committed example build artifacts: `git rm -r --cached example/target`.
- Add `example/target/` to `.gitignore`.
- `.jrun-classpath-cache` is already ignored globally — no change needed.

## Suite wiring

vitest's `include` already globs `test/**/*.test.ts`, so the new file is
auto-discovered. No vitest config change is required beyond per-test timeouts set
inline in the test file.

## Out of scope

- `save` / `rerun` / config round-trips driven against the example — already
  covered against an empty project by `JrunApi.test.ts`.
- Adding new example classes or making the example multi-module.
- Real port binding in `ApiServer` (it only prints; no socket to free).
