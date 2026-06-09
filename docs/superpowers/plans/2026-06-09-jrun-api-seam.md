# JrunApi Seam Implementation Plan (Phase 3)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Introduce a single promise-returning `JrunApi` adapter over the Effect services — the one seam both the CLI and the future lazygit dashboard go through — and prove it by migrating the existing `configs` TUI off its raw-`fs`-in-React anti-pattern. Also fold in a small pre-existing service-layer fix (`resolveClasspath` mtime comparison).

**Architecture:** `JrunApi` is a plain object of `Promise`-returning methods, constructed by `makeJrunApi(runtime)` where `runtime` is a `Runtime.Runtime` that already has the services in context. Each method is a `Runtime.runPromise(runtime)(<service effect>)` wrapper. The CLI stays Effect-native (no rewrite — that would lose typed errors); inside the `configs` TUI handler we obtain the live runtime via `Effect.runtime()` and build a `JrunApi` to hand to Ink. React components call `JrunApi` methods instead of touching `fs`. A new `ConfigStore.delete` method centralizes config deletion (currently duplicated as raw `path.join(...os.homedir...)` + `fs.remove`/`nodefs.unlink` in three places).

**Tech Stack:** TypeScript, Effect (`Runtime`, `ManagedRuntime`, `@effect/platform` `FileSystem`/`Path`), Ink/React, Vitest with `@effect/vitest`.

**Prerequisite:** Phase 2 (`feat/dashboard-agent-cli`) is merged to `main`. `ProcessRecord`, `RunOptions`, `ProcessManager.run/listRunning/kill`, and the service tags exist.

---

## File Map

| File | Change |
|---|---|
| `src/services/JavaProject.ts` | Task 1: fix `resolveClasspath` `Option<Date>` mtime comparison so the classpath cache actually works |
| `test/services/JavaProject.test.ts` | Task 1: add cache freshness tests |
| `src/services/ConfigStore.ts` | Task 2: add `delete(name)` method to the service interface + impl |
| `test/services/ConfigStore.test.ts` | Task 2: test `delete` (removes file; not-found behavior) |
| `src/commands/configs.ts` | Task 3 (CLI delete uses `store.delete`), Task 5 (TUI uses JrunApi) |
| `src/api/JrunApi.ts` | Task 4: **new** — `JrunApi` interface + `makeJrunApi(runtime)` |
| `test/api/JrunApi.test.ts` | Task 4: **new** — contract test over real test layers |
| `src/tui/ConfigsTui.tsx` | Task 5: `onDelete` prop already async — no change needed beyond wiring (verify) |

**`JrunApi` interface (the seam — Phase 4 dashboard depends on this exact shape):**

```ts
export interface StartSpec {
  readonly mainClass?: string;        // one of mainClass | configName
  readonly configName?: string;
  readonly args?: readonly string[];
  readonly jvmOpts?: readonly string[];
  readonly detached?: boolean;
  readonly debug?: { readonly port: number; readonly suspend: boolean } | null;
}

export interface JrunApi {
  listConfigs(): Promise<string[]>;
  loadConfig(name: string): Promise<RunConfig | null>;
  saveConfig(name: string, cfg: RunConfig): Promise<void>;
  deleteConfig(name: string): Promise<void>;
  listMainClasses(): Promise<string[]>;
  listRunning(): Promise<ProcessRecord[]>;
  start(spec: StartSpec): Promise<ProcessRecord>;
  kill(mainClass: string): Promise<void>;
}
```

---

## Task 1: Fix `resolveClasspath` mtime comparison (pre-existing bug)

**Context:** `fs.stat().mtime` is an `Option<Date>` in this Effect version, but `resolveClasspath` compares it with `!== undefined` and `>`. `Option<Date> !== undefined` is always true, and `>` on two `Option` objects is always false — so the classpath cache freshness check is dead and the cache branch is effectively never taken (every `start`/`status`-driven classpath resolve re-runs `mvn`, which is slow). This was found during Phase 2 review.

**Files:**
- Modify: `src/services/JavaProject.ts`
- Test: `test/services/JavaProject.test.ts`

- [ ] **Step 1: Read the current `resolveClasspath`** in `src/services/JavaProject.ts`. Note the block that compares `cacheStat.mtime` and `pomStat.mtime`.

- [ ] **Step 2: Write a failing test** in `test/services/JavaProject.test.ts`. Add a `describe("JavaProject.resolveClasspath", ...)` (or extend the existing structure) with a test that does NOT require `mvn` for the cache-hit path: create a temp project dir with a `pom.xml` and a `.jrun-classpath-cache` whose mtime is NEWER than the pom; call `resolveClasspath`; assert it returns `target/classes:<cached contents>` WITHOUT invoking `mvn`. To make the cache newer than the pom deterministically, write `pom.xml` first, then write the cache file after (later mtime), or explicitly set mtimes. Use the existing test helpers/`FileSystem` patterns in the file.

  ```ts
  it.effect("uses the classpath cache when it is newer than pom.xml", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectory();
      yield* fs.writeFileString(`${root}/pom.xml`, "<project/>");
      // ensure the cache file's mtime is strictly newer than pom.xml
      yield* fs.writeFileString(`${root}/.jrun-classpath-cache`, "dep1.jar:dep2.jar");
      // bump cache mtime into the future to be unambiguous
      const future = new Date(Date.now() + 60_000);
      yield* Effect.sync(() =>
        require("node:fs").utimesSync(`${root}/.jrun-classpath-cache`, future, future)
      );

      const layer = JavaProjectLive.pipe(
        Layer.provide(Layer.succeed(ProjectRoot, root)),
        Layer.provide(NodeContext.layer)
      );
      const cp = yield* JavaProjectService.pipe(
        Effect.flatMap((p) => p.resolveClasspath),
        Effect.provide(layer)
      );
      expect(cp).toBe("target/classes:dep1.jar:dep2.jar");
    }).pipe(Effect.provide(NodeContext.layer))
  );
  ```

  Note: this test must use `it.live` if it relies on real wall-clock `Date.now()` vs file mtimes — but since the assertion only compares file mtimes against each other (not the test clock), `it.effect` is fine. Verify; if `Date.now()` is needed and unavailable under TestClock, switch to `it.live`.

- [ ] **Step 3: Run the test, confirm it FAILS** (the dead comparison means the cache branch is skipped and `mvn` is invoked → in a no-mvn environment it errors, or it doesn't return the cached value).

  Run: `pnpm test:run -- test/services/JavaProject.test.ts`

- [ ] **Step 4: Fix the comparison.** Replace the `mtime` comparison with real `Option<Date>` handling. Use `Option.match`/`Option.getOrElse` (import `Option` from `effect`) to extract the `Date`s and compare their `.getTime()`. The cache is fresh when both mtimes are present and `cache.getTime() > pom.getTime()`:

  ```ts
  import { Option } from "effect"; // add to imports if not present

  // inside resolveClasspath, replacing the old undefined/`>` comparison:
  const cacheMtime = Option.getOrNull(cacheStat.mtime);
  const pomMtime = Option.getOrNull(pomStat.mtime);
  if (cacheMtime !== null && pomMtime !== null && cacheMtime.getTime() > pomMtime.getTime()) {
    const cached = yield* fs.readFileString(cacheFile);
    return `target/classes:${cached.trim()}`;
  }
  ```

  Verify the actual shape of `cacheStat.mtime` in this version (`Option<Date>`); if `Option.getOrNull` isn't available, use `Option.match(cacheStat.mtime, { onNone: () => null, onSome: (d) => d })`.

- [ ] **Step 5: Run tests, confirm PASS.** `pnpm test:run -- test/services/JavaProject.test.ts`. Then `pnpm typecheck`.

- [ ] **Step 6: Commit**

  ```bash
  git add src/services/JavaProject.ts test/services/JavaProject.test.ts
  git commit -m "fix: repair classpath cache freshness check (Option<Date> mtime comparison)"
  ```

---

## Task 2: Add `ConfigStore.delete`

**Files:**
- Modify: `src/services/ConfigStore.ts`
- Test: `test/services/ConfigStore.test.ts`

**Context:** `ConfigStore` currently exposes `save/load/list/saveLastRun/loadLastRun`. Deletion is done with raw `fs`/`path` in `configs.ts` (CLI delete and TUI). Add a `delete` method so deletion is centralized and reusable by `JrunApi`.

- [ ] **Step 1: Write failing tests** in `test/services/ConfigStore.test.ts` (follow the existing test layer/helper pattern in that file):

  ```ts
  it.effect("delete removes a saved config", () =>
    Effect.gen(function* () {
      const store = yield* ConfigStoreService;
      yield* store.save("doomed", { mainClass: "com.x.A", programArgs: [], jvmOpts: [] });
      expect(yield* store.list).toContain("doomed");
      yield* store.delete("doomed");
      expect(yield* store.list).not.toContain("doomed");
    }).pipe(Effect.provide(/* the file's existing test layer */))
  );

  it.effect("delete of a missing config does not throw", () =>
    Effect.gen(function* () {
      const store = yield* ConfigStoreService;
      yield* store.delete("never-existed"); // should be a no-op, not an error
    }).pipe(Effect.provide(/* the file's existing test layer */))
  );
  ```

  Match the exact layer-provision style already used by the other tests in that file (read it first).

- [ ] **Step 2: Run, confirm FAIL** (`delete` not on the interface). `pnpm test:run -- test/services/ConfigStore.test.ts`

- [ ] **Step 3: Implement `delete`.** In `src/services/ConfigStore.ts`:
  - Add to the `ConfigStore` interface: `readonly delete: (name: string) => Effect.Effect<void, PlatformError>;`
  - In the layer, implement using the existing `configPath(name)` helper and `fs.remove` with idempotent semantics (removing a non-existent file must not fail):

    ```ts
    const del = (name: string) =>
      fs.remove(configPath(name)).pipe(Effect.ignore);
    ```

    (`Effect.ignore` makes a missing file a no-op. Confirm `fs.remove` on a missing path is the only failure being ignored; if you prefer, check `fs.exists` first and return early — but `Effect.ignore` is simplest and matches the "delete of missing is a no-op" test.)
  - Add `delete: del` to the returned object (`delete` is a reserved word as a bare identifier in some positions but is fine as an object property key; name the local `del` and map it: `{ ..., delete: del }`).

- [ ] **Step 4: Run tests, confirm PASS.** Then `pnpm typecheck`.

- [ ] **Step 5: Commit**

  ```bash
  git add src/services/ConfigStore.ts test/services/ConfigStore.test.ts
  git commit -m "feat: add ConfigStore.delete for centralized config deletion"
  ```

---

## Task 3: Route `configs delete` CLI through `ConfigStore.delete`

**Files:**
- Modify: `src/commands/configs.ts`

**Context:** `configsDelete` currently computes `path.join(os.homedir(), ".jrun", "configs", ...)` and uses `FileSystem.remove` directly — duplicating `ConfigStore`'s path logic. Replace with `store.delete(name)`.

- [ ] **Step 1:** In `configsDelete`, replace the manual path + `fs.remove` block:

  ```ts
      const configPath = path.join(os.homedir(), ".jrun", "configs", `${name}.json`);
      const fs = yield* FileSystem.FileSystem;
      yield* fs.remove(configPath);
  ```

  with:

  ```ts
      yield* store.delete(name);
  ```

  Remove the now-unused `FileSystem` import from `configs.ts` IF it is no longer referenced elsewhere in the file (check — `configsTui` and other subcommands may not use it; the only `FileSystem` use was here). Keep `path`/`os`/`cp` if still used by `configsEdit`/`configsTui`.

- [ ] **Step 2:** `pnpm typecheck` (clean), `pnpm build`, `pnpm test:run` (green). Manual: `node dist/main.js save zz com.x.A --json && node dist/main.js configs delete zz --json` → `{"ok":true,"name":"zz"}`, and `node dist/main.js configs list --json` no longer lists `zz`.

- [ ] **Step 3: Commit**

  ```bash
  git add src/commands/configs.ts
  git commit -m "refactor: use ConfigStore.delete in configs delete command"
  ```

---

## Task 4: Create `JrunApi` + `makeJrunApi`

**Files:**
- Create: `src/api/JrunApi.ts`
- Create: `test/api/JrunApi.test.ts`

**Context:** This is the seam. `makeJrunApi(runtime)` takes a `Runtime.Runtime<JavaProjectService | ProcessManagerService | ConfigStoreService>` and returns a `JrunApi` whose methods run service effects via `Runtime.runPromise`. The runtime already has the services in context (provided by the CLI's `AppLayer` at the call site, or by a test layer in the contract test).

- [ ] **Step 1: Write the contract test** `test/api/JrunApi.test.ts`. Build a `Runtime.Runtime` from the same `*Live` layers used in the service tests (over temp dirs), then assert each `JrunApi` method delegates correctly. Use `ManagedRuntime` to get a runtime:

  ```ts
  import { NodeContext } from "@effect/platform-node";
  import { FileSystem } from "@effect/platform";
  import { it } from "@effect/vitest";
  import { Effect, Layer, ManagedRuntime } from "effect";
  import { describe, expect } from "vitest";
  import { ConfigDir, ConfigStoreLive, ConfigStoreService } from "../../src/services/ConfigStore.js";
  import { JavaProjectLive, ProjectRoot } from "../../src/services/JavaProject.js";
  import { LogDir, PidDir, ProcessManagerLive } from "../../src/services/ProcessManager.js";
  import { makeJrunApi } from "../../src/api/JrunApi.js";

  // Build an app-like layer over temp dirs, make a ManagedRuntime, get its Runtime,
  // construct the api, and assert round-trips: saveConfig -> listConfigs -> loadConfig -> deleteConfig,
  // and listRunning() returns [] initially.
  ```

  Concretely, the test should:
  - Create temp dirs for ConfigDir/PidDir/LogDir/ProjectRoot.
  - Compose a layer mirroring `main.ts`'s `AppLayer` (JavaProject + ConfigStore + ProcessManager) over those temp dirs.
  - `const mr = ManagedRuntime.make(appLayer); const runtime = await mr.runtime();` then `const api = makeJrunApi(runtime);`
  - Assert: `await api.listConfigs()` is `[]`; after `await api.saveConfig("a", cfg)`, `listConfigs()` contains `"a"` and `loadConfig("a")` deep-equals `cfg`; `loadConfig("missing")` is `null`; after `deleteConfig("a")`, `listConfigs()` is `[]`; `await api.listRunning()` is `[]`.
  - Dispose: `await mr.dispose()` in a `finally`/teardown.
  - (Skip `start()` end-to-end here — it needs `mvn`; cover its arg-mapping by unit-reasoning or a later manual check. You MAY assert `loadConfig`/`listMainClasses` shapes. `listMainClasses` needs `rg` which IS available.)

  Use plain `it`/`test` with async (not `it.effect`) since `JrunApi` methods return Promises. Confirm the `@effect/vitest`/`vitest` async test style.

- [ ] **Step 2: Run, confirm FAIL** (`makeJrunApi` does not exist). `pnpm test:run -- test/api/JrunApi.test.ts`

- [ ] **Step 3: Implement `src/api/JrunApi.ts`.**

  ```ts
  import { Runtime } from "effect";
  import { Effect } from "effect";
  import {
    ConfigStoreService,
    type RunConfig,
  } from "../services/ConfigStore.js";
  import { JavaProjectService } from "../services/JavaProject.js";
  import {
    ProcessManagerService,
    type ProcessRecord,
  } from "../services/ProcessManager.js";

  export interface StartSpec {
    readonly mainClass?: string;
    readonly configName?: string;
    readonly args?: readonly string[];
    readonly jvmOpts?: readonly string[];
    readonly detached?: boolean;
    readonly debug?: { readonly port: number; readonly suspend: boolean } | null;
  }

  export interface JrunApi {
    listConfigs(): Promise<string[]>;
    loadConfig(name: string): Promise<RunConfig | null>;
    saveConfig(name: string, cfg: RunConfig): Promise<void>;
    deleteConfig(name: string): Promise<void>;
    listMainClasses(): Promise<string[]>;
    listRunning(): Promise<ProcessRecord[]>;
    start(spec: StartSpec): Promise<ProcessRecord>;
    kill(mainClass: string): Promise<void>;
  }

  type Services = JavaProjectService | ProcessManagerService | ConfigStoreService;

  export const makeJrunApi = (runtime: Runtime.Runtime<Services>): JrunApi => {
    const run = Runtime.runPromise(runtime);

    return {
      listConfigs: () =>
        run(Effect.flatMap(ConfigStoreService, (s) => s.list)),

      loadConfig: (name) =>
        run(
          Effect.flatMap(ConfigStoreService, (s) =>
            s.load(name).pipe(Effect.map((c): RunConfig | null => c), Effect.catchTag("ConfigNotFound", () => Effect.succeed(null)))
          )
        ),

      saveConfig: (name, cfg) =>
        run(Effect.flatMap(ConfigStoreService, (s) => s.save(name, cfg))),

      deleteConfig: (name) =>
        run(Effect.flatMap(ConfigStoreService, (s) => s.delete(name))),

      listMainClasses: () =>
        run(Effect.flatMap(JavaProjectService, (s) => s.findMainClasses)),

      listRunning: () =>
        run(Effect.flatMap(ProcessManagerService, (s) => s.listRunning)),

      start: (spec) =>
        run(
          Effect.gen(function* () {
            const configStore = yield* ConfigStoreService;
            const pm = yield* ProcessManagerService;
            let config: RunConfig;
            if (spec.configName) {
              const loaded = yield* configStore.load(spec.configName);
              config = {
                mainClass: loaded.mainClass,
                programArgs: [...loaded.programArgs, ...(spec.args ?? [])],
                jvmOpts: [...loaded.jvmOpts, ...(spec.jvmOpts ?? [])],
              };
            } else {
              if (!spec.mainClass) {
                return yield* Effect.die(new Error("start requires mainClass or configName"));
              }
              config = {
                mainClass: spec.mainClass,
                programArgs: [...(spec.args ?? [])],
                jvmOpts: [...(spec.jvmOpts ?? [])],
              };
            }
            return yield* pm.run(config, { detached: spec.detached, debug: spec.debug ?? null });
          })
        ),

      kill: (mainClass) =>
        run(
          Effect.flatMap(ProcessManagerService, (s) =>
            s.kill(mainClass).pipe(Effect.catchTag("ProcessNotFound", () => Effect.void))
          )
        ),
    };
  };
  ```

  Verify against the installed Effect API:
  - `Runtime.runPromise(runtime)` returns a function `(effect) => Promise`. Confirm signature; if it's `Runtime.runPromise(runtime, effect)` in this version, adapt the `run` helper accordingly.
  - `Effect.flatMap(Tag, f)` — accessing a service by yielding the Tag works (`yield* ConfigStoreService`); the `Effect.flatMap(ConfigStoreService, ...)` form should also work since a Tag is an `Effect` that yields the service. If it doesn't typecheck, use `Effect.gen(function*(){ const s = yield* ConfigStoreService; return yield* s.list })`.
  - `s.load(name)` fails with `ConfigNotFound` — `catchTag("ConfigNotFound", ...)` maps to `null`.
  - `kill` swallowing `ProcessNotFound` → `void` is intentional for API ergonomics (the dashboard kills a row it knows is running; a race where it's already gone shouldn't reject). Document this with a comment.

- [ ] **Step 4: Run the contract test, confirm PASS.** `pnpm test:run -- test/api/JrunApi.test.ts`. Then `pnpm typecheck`.

- [ ] **Step 5: Commit**

  ```bash
  git add src/api/JrunApi.ts test/api/JrunApi.test.ts
  git commit -m "feat: add JrunApi promise seam over Effect services"
  ```

---

## Task 5: Migrate the `configs` TUI onto `JrunApi`

**Files:**
- Modify: `src/commands/configs.ts`
- Possibly modify: `src/tui/ConfigsTui.tsx` (only if prop types need adjustment)

**Context:** The `configsTui` effect currently passes an `onDelete` that does raw `nodefs.unlink`. Replace it by building a `JrunApi` from the live runtime and routing `onDelete` through `api.deleteConfig`. This removes the raw-`fs`-in-React anti-pattern and validates `JrunApi` in Ink. `onEdit` (spawning `$EDITOR`) stays — it is a process-spawn concern, not a service call.

- [ ] **Step 1: Obtain the runtime and build the api** inside `configsTui`. At the top of the `Effect.gen`:

  ```ts
  import { Effect, Runtime } from "effect";
  import { makeJrunApi } from "../api/JrunApi.js";
  // ...
  const configsTui = Effect.gen(function* () {
    const store = yield* ConfigStoreService;
    const runtime = yield* Effect.runtime<
      import("../services/JavaProject.js").JavaProjectService |
      import("../services/ProcessManager.js").ProcessManagerService |
      ConfigStoreService
    >();
    const api = makeJrunApi(runtime);
    // ... existing names/configMap loading ...
  ```

  Confirm `Effect.runtime<R>()` yields a `Runtime.Runtime<R>` for the services in context. The `configs` command runs under `AppLayer`, so all three services are present. If the explicit type arg is awkward, infer it: `const runtime = yield* Effect.runtime()` and let `makeJrunApi`'s parameter type drive inference (you may need a cast `as Runtime.Runtime<Services>` — prefer the typed `Effect.runtime<Services>()` form).

- [ ] **Step 2: Route `onDelete` through the api.** Replace:

  ```ts
        onDelete: async (name: string) => {
          const configPath = path.join(os.homedir(), ".jrun", "configs", `${name}.json`);
          await nodefs.unlink(configPath);
        },
  ```

  with:

  ```ts
        onDelete: (name: string) => api.deleteConfig(name),
  ```

  Remove the now-unused `nodefs` import (`import * as nodefs from "node:fs/promises"`) IF nothing else uses it (check the file — only this used it). Keep `cp`/`os`/`path` if `onEdit`/`configsEdit` still use them.

- [ ] **Step 3:** `pnpm typecheck` (clean), `pnpm build`, `pnpm test:run` (green).

  Manual smoke (TUI is interactive — at minimum confirm it launches and lists, then quit): create a couple configs, run `node dist/main.js configs`, verify the list renders, navigate with arrows, press `d` then `y` to delete one, confirm it disappears and `node dist/main.js configs list` reflects the deletion. (If a fully interactive run isn't possible in this environment, confirm the build/typecheck and that `node dist/main.js configs list` still works; note that manual TUI verification is deferred to a real terminal.)

- [ ] **Step 4: Commit**

  ```bash
  git add src/commands/configs.ts src/tui/ConfigsTui.tsx
  git commit -m "refactor: route configs TUI deletion through JrunApi (remove raw fs in React)"
  ```

---

## Task 6: Full gate

- [ ] **Step 1:** `pnpm test:run && pnpm typecheck && pnpm lint && pnpm build` — all green. Fix any biome issues introduced.

- [ ] **Step 2:** Confirm no remaining raw `fs`/`nodefs`/`os`/`path`-to-config-file logic in React callbacks (grep `configs.ts` for `nodefs`, `unlink`, `\.jrun.*configs`). The only acceptable raw-process usage left is the `$EDITOR` spawn in `onEdit`/`configsEdit`.

- [ ] **Step 3: Commit** (if anything changed in Step 1).

---

## Spec Coverage

| Spec requirement | Task |
|---|---|
| Single `JrunApi` seam, promise-returning, built from one Runtime | Task 4 |
| `JrunApi` methods: listConfigs/loadConfig/saveConfig/deleteConfig/listMainClasses/listRunning/start/kill | Task 4 |
| Remove raw `fs`-in-React anti-pattern from the TUI | Task 5 |
| Centralized config deletion | Task 2, 3, 5 |
| CLI stays Effect-native (no forced rewrite through JrunApi) | Design note (only the TUI + new code consume JrunApi) |
| Classpath cache actually works (service-layer correctness) | Task 1 |

## Out of Scope (this plan)

- The full lazygit dashboard (Phase 4 — separate plan; it will consume `JrunApi.start/kill/listRunning/listMainClasses`).
- Rewriting the Effect-native CLI commands (`status`, `list`, `kill`, `start`, `save`) to go through `JrunApi` — they already call services cleanly and keep typed errors.
- `JrunApi.start` end-to-end test requiring `mvn`/`java` (covered by manual/real-env verification; arg-mapping is exercised by reasoning + Phase 2's ProcessManager tests).
