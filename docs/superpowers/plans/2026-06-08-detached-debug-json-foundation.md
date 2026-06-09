# Detached Runs + Debug + Enriched Records + `--json` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add detached/background process runs, first-class JDWP debug support, enriched PID records, a `--json` output mode across query/action commands, and a `jrun logs` command — the service + CLI foundation the dashboard TUI will sit on.

**Architecture:** Upgrade `ProcessManager` to write PID files as JSON `ProcessRecord`s (with legacy raw-integer fallback on read) and to support a detached spawn path (Node `child_process.spawn` with `detached:true` + file-redirected stdio + `unref()`), while the existing foreground path keeps using Effect's `Command`. JDWP is enabled purely by injecting an `-agentlib:jdwp=...` JVM arg at launch; jrun never attaches a debugger. CLI commands gain a `--json` option and emit stable structured output; a new `logs` command prints/tails a run's log file.

**Tech Stack:** TypeScript, Effect (`@effect/platform` `Command`/`FileSystem`/`Path`, `@effect/cli` `Options`), Node `child_process`, Vitest with `@effect/vitest`.

**Prerequisite:** Phase 1 (rg rewrite, `docs/superpowers/plans/2026-05-19-fast-main-class-discovery.md`) is merged first. This plan does not depend on its internals but shares `JavaProject`.

---

## File Map

| File | Change |
|---|---|
| `src/services/ProcessManager.ts` | Add `ProcessRecord` type + `RunOptions`; JSON PID-file format; legacy fallback in `listRunning`; detached spawn path; JDWP arg injection; helper `debugJvmArg`; `recordFile`/parse helpers |
| `test/services/ProcessManager.test.ts` | Update existing assertions to enriched shape; add tests: JSON record round-trip, legacy fallback, detached spawn writes record+log, debug arg injection, `debugJvmArg` unit |
| `src/commands/start.ts` | Add `--detached`/`-d`, `--debug [port]`, `--debug-suspend`, `--json`; thread `RunOptions`; JSON result |
| `src/commands/status.ts` | Add `--json`; print enriched records |
| `src/commands/list.ts` | Add `--json` |
| `src/commands/kill.ts` | Add `--json`; non-zero exit on not-found |
| `src/commands/save.ts` | Add `--json` |
| `src/commands/configs.ts` | Add `--json` to `list`, `show`, `delete` |
| `src/commands/logs.ts` | **New**: `jrun logs <class>` print/tail the run's log file; `--follow`/`-f` |
| `src/main.ts` | Register `logs` subcommand |

**`ProcessRecord` shape (the north star — used by every later phase):**

```ts
export interface ProcessRecord {
  readonly pid: number;
  readonly mainClass: string;
  readonly startedAt: string;          // ISO 8601
  readonly logFile: string | null;     // null for foreground runs
  readonly args: readonly string[];    // program args this run was started with
  readonly debugPort: number | null;   // null unless --debug
}

export interface RunOptions {
  readonly detached?: boolean;
  readonly debug?: { readonly port: number; readonly suspend: boolean } | null;
}
```

`RunningProcess` is replaced by `ProcessRecord` everywhere (it was `{ mainClass, pid }`).

---

## Task 1: `debugJvmArg` pure helper

**Files:**
- Modify: `src/services/ProcessManager.ts`
- Test: `test/services/ProcessManager.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `test/services/ProcessManager.test.ts` inside the top-level `describe("ProcessManager", ...)`. First add the import at the top of the file:

```ts
import { debugJvmArg } from "../../src/services/ProcessManager.js";
```

Then the test (uses plain `it` from vitest — import `it` from vitest is already shadowed by `@effect/vitest`'s `it`; use `it.effect` is unnecessary for a pure fn, so use `expect` in a plain test via `vitest`'s `test`). Add this block:

```ts
import { test } from "vitest";

test("debugJvmArg builds a non-suspending JDWP arg by default", () => {
  expect(debugJvmArg(5005, false)).toBe(
    "-agentlib:jdwp=transport=dt_socket,server=y,suspend=n,address=*:5005"
  );
});

test("debugJvmArg sets suspend=y when requested", () => {
  expect(debugJvmArg(6000, true)).toBe(
    "-agentlib:jdwp=transport=dt_socket,server=y,suspend=y,address=*:6000"
  );
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm test:run -- test/services/ProcessManager.test.ts`
Expected: FAIL — `debugJvmArg` is not exported.

- [ ] **Step 3: Implement `debugJvmArg`**

In `src/services/ProcessManager.ts`, add near the top (after imports, before `ProcessManagerLive`):

```ts
export const debugJvmArg = (port: number, suspend: boolean): string =>
  `-agentlib:jdwp=transport=dt_socket,server=y,suspend=${suspend ? "y" : "n"},address=*:${port}`;
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm test:run -- test/services/ProcessManager.test.ts`
Expected: the two `debugJvmArg` tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/services/ProcessManager.ts test/services/ProcessManager.test.ts
git commit -m "feat: add debugJvmArg helper for JDWP arg construction"
```

---

## Task 2: `ProcessRecord` type + JSON PID files + enriched `listRunning` with legacy fallback

**Files:**
- Modify: `src/services/ProcessManager.ts`
- Test: `test/services/ProcessManager.test.ts`

- [ ] **Step 1: Update existing tests to the enriched record shape**

The current tests assert `{ mainClass, pid }`. Replace the two affected assertions:

In `"listRunning returns running processes for current project"`, change the final assertion to write a JSON record and expect the enriched shape:

```ts
      const myPid = process.pid;
      const record = {
        pid: myPid,
        mainClass: "com.example.Running",
        startedAt: "2026-06-08T00:00:00.000Z",
        logFile: null,
        args: [],
        debugPort: null,
      };
      yield* fs.writeFileString(
        `${pidDir}/${hash}-com.example.Running.pid`,
        JSON.stringify(record)
      );

      const layer = makeTestLayer(tmpDir, pidDir);
      const running = yield* ProcessManagerService.pipe(
        Effect.flatMap((pm) => pm.listRunning),
        Effect.provide(layer)
      );

      expect(running).toEqual([record]);
```

The `"listRunning cleans up stale PID files"` test writes `"99999999"` (a raw legacy int) — leave it; it still must be reaped (verifies legacy parse + reap path). The `"ignores PIDs from other projects"` and `"run spawns..."` (empty) tests are unaffected.

- [ ] **Step 2: Add a legacy-fallback test**

Append inside the `describe`:

```ts
  it.effect("listRunning parses legacy raw-integer PID files", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const tmpDir = yield* fs.makeTempDirectory();
      const pidDir = yield* fs.makeTempDirectory();
      const crypto = require("node:crypto");
      const hash = crypto.createHash("md5").update(tmpDir).digest("hex");

      const myPid = process.pid;
      yield* fs.writeFileString(`${pidDir}/${hash}-com.example.Legacy.pid`, String(myPid));

      const layer = makeTestLayer(tmpDir, pidDir);
      const running = yield* ProcessManagerService.pipe(
        Effect.flatMap((pm) => pm.listRunning),
        Effect.provide(layer)
      );

      expect(running.length).toBe(1);
      expect(running[0]!.pid).toBe(myPid);
      expect(running[0]!.mainClass).toBe("com.example.Legacy");
      expect(running[0]!.logFile).toBe(null);
      expect(running[0]!.debugPort).toBe(null);
      expect(running[0]!.args).toEqual([]);
      // startedAt is derived from file mtime for legacy files; just assert it is a string
      expect(typeof running[0]!.startedAt).toBe("string");
    }).pipe(Effect.provide(NodeContext.layer))
  );
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `pnpm test:run -- test/services/ProcessManager.test.ts`
Expected: FAIL — `listRunning` still returns `{ mainClass, pid }` only.

- [ ] **Step 4: Implement the record type and rewrite `listRunning`**

In `src/services/ProcessManager.ts`:

Replace the `RunningProcess` interface:

```ts
export interface ProcessRecord {
  readonly pid: number;
  readonly mainClass: string;
  readonly startedAt: string;
  readonly logFile: string | null;
  readonly args: readonly string[];
  readonly debugPort: number | null;
}

export interface RunOptions {
  readonly detached?: boolean;
  readonly debug?: { readonly port: number; readonly suspend: boolean } | null;
}
```

Update the `ProcessManager` interface signatures:

```ts
export interface ProcessManager {
  readonly run: (
    config: RunConfig,
    options?: RunOptions
  ) => Effect.Effect<ProcessRecord, JavaProcessError | PlatformError>;
  readonly listRunning: Effect.Effect<ProcessRecord[], PlatformError>;
  readonly kill: (className: string) => Effect.Effect<void, ProcessNotFound | PlatformError>;
  readonly killByPid: (pid: number) => Effect.Effect<void, PlatformError>;
}
```

Add a parse helper above `ProcessManagerLive` (module scope):

```ts
const parseRecord = (
  content: string,
  mainClassFromName: string,
  mtimeIso: string
): ProcessRecord | undefined => {
  const trimmed = content.trim();
  if (trimmed.length === 0) return undefined;
  // Legacy format: a bare integer PID
  if (/^\d+$/.test(trimmed)) {
    return {
      pid: Number.parseInt(trimmed, 10),
      mainClass: mainClassFromName,
      startedAt: mtimeIso,
      logFile: null,
      args: [],
      debugPort: null,
    };
  }
  try {
    const obj = JSON.parse(trimmed) as Partial<ProcessRecord>;
    if (typeof obj.pid !== "number") return undefined;
    return {
      pid: obj.pid,
      mainClass: obj.mainClass ?? mainClassFromName,
      startedAt: obj.startedAt ?? mtimeIso,
      logFile: obj.logFile ?? null,
      args: obj.args ?? [],
      debugPort: obj.debugPort ?? null,
    };
  } catch {
    return undefined;
  }
};
```

Rewrite `listRunning` inside the layer:

```ts
    const listRunning = Effect.gen(function* () {
      const exists = yield* fs.exists(pidDir);
      if (!exists) return [];

      const entries = yield* fs.readDirectory(pidDir);
      const running: ProcessRecord[] = [];

      for (const entry of entries) {
        if (!entry.startsWith(hash) || !entry.endsWith(".pid")) continue;
        const filePath = pathSvc.join(pidDir, entry);
        const content = yield* fs.readFileString(filePath);
        const mainClassFromName = entry.slice(hash.length + 1, -4);
        const stat = yield* fs.stat(filePath);
        const mtimeIso =
          stat.mtime._tag === "Some" ? stat.mtime.value.toISOString() : "";

        const record = parseRecord(content, mainClassFromName, mtimeIso);
        if (record && isProcessRunning(record.pid)) {
          running.push(record);
        } else {
          yield* fs.remove(filePath).pipe(Effect.ignore);
        }
      }

      return running;
    });
```

Note: `@effect/platform` `File.Info.mtime` is an `Option<Date>`. Use `stat.mtime._tag === "Some" ? stat.mtime.value.toISOString() : ""`. If the local Effect version exposes `mtime` as `Date | undefined` instead, use `stat.mtime?.toISOString() ?? ""` — verify against the existing `resolveClasspath` usage in `JavaProject.ts` which already reads `stat.mtime` (it compares `cacheStat.mtime !== undefined`, so this codebase's version is `Date | undefined`; use `stat.mtime?.toISOString() ?? ""`).

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm test:run -- test/services/ProcessManager.test.ts`
Expected: PASS (record-shape, legacy fallback, stale reap all green). Other test files untouched.

- [ ] **Step 6: Typecheck**

Run: `pnpm typecheck`
Expected: errors in `status.ts`/`kill.ts` consumers referencing `RunningProcess` — those are fixed in later tasks. If `RunningProcess` is imported anywhere, add a temporary alias `export type RunningProcess = ProcessRecord;` to keep typecheck green until consumers are updated.

Add the alias to `ProcessManager.ts`:

```ts
/** @deprecated use ProcessRecord */
export type RunningProcess = ProcessRecord;
```

Run `pnpm typecheck` again. Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add src/services/ProcessManager.ts test/services/ProcessManager.test.ts
git commit -m "feat: enrich PID records to JSON ProcessRecord with legacy fallback"
```

---

## Task 3: `run` writes a `ProcessRecord` and supports detached + debug

**Files:**
- Modify: `src/services/ProcessManager.ts`
- Test: `test/services/ProcessManager.test.ts`

**Design note for the implementer:** the foreground path keeps Effect's `Command.make("java", ...)` + `Command.start`. The detached path cannot use inherited stdio (the parent returns immediately), so it uses Node's `child_process.spawn(javaBin, args, { detached: true, stdio: ["ignore", fd, fd], cwd: root })`, writes the record, then `child.unref()` and returns without awaiting exit. Both paths inject the JDWP arg first when `options.debug` is set.

- [ ] **Step 1: Write a failing test for the record returned by a detached run**

Use a mock `java` on PATH-free invocation by pointing the service at a fake binary is invasive; instead test the **record-writing + arg-assembly** seam by extracting a pure `buildJavaArgs` helper and testing it, plus an integration test of detached spawn using a real trivial command.

First, the pure helper test (add to the test file):

```ts
import { buildJavaArgs } from "../../src/services/ProcessManager.js";

test("buildJavaArgs injects debug arg before user jvm opts and orders cp/main/args", () => {
  const args = buildJavaArgs(
    { mainClass: "com.example.App", programArgs: ["--port", "8080"], jvmOpts: ["-Xmx512m"] },
    "target/classes:dep.jar",
    { port: 5005, suspend: false }
  );
  expect(args).toEqual([
    "-agentlib:jdwp=transport=dt_socket,server=y,suspend=n,address=*:5005",
    "-Xmx512m",
    "-cp",
    "target/classes:dep.jar",
    "com.example.App",
    "--port",
    "8080",
  ]);
});

test("buildJavaArgs omits debug arg when debug is null", () => {
  const args = buildJavaArgs(
    { mainClass: "com.example.App", programArgs: [], jvmOpts: [] },
    "cp",
    null
  );
  expect(args).toEqual(["-cp", "cp", "com.example.App"]);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm test:run -- test/services/ProcessManager.test.ts`
Expected: FAIL — `buildJavaArgs` not exported.

- [ ] **Step 3: Extract `buildJavaArgs` and use it in `run`**

Add module-scope helper to `ProcessManager.ts`:

```ts
export const buildJavaArgs = (
  config: RunConfig,
  classpath: string,
  debug: { port: number; suspend: boolean } | null
): string[] => {
  const debugArgs = debug ? [debugJvmArg(debug.port, debug.suspend)] : [];
  return [
    ...debugArgs,
    ...config.jvmOpts,
    "-cp",
    classpath,
    config.mainClass,
    ...config.programArgs,
  ];
};
```

- [ ] **Step 4: Run to verify the helper tests pass**

Run: `pnpm test:run -- test/services/ProcessManager.test.ts`
Expected: `buildJavaArgs` tests PASS.

- [ ] **Step 5: Write the detached-spawn integration test**

This test verifies a detached run writes a `ProcessRecord` with a `logFile`, redirects output there, and that `listRunning` then reports it. It uses a real short-lived shell process by temporarily swapping the spawned binary. To keep it hermetic, add an internal seam: `run` reads the java binary name from an optional `JavaBin` context tag defaulting to `"java"`. Add the tag:

```ts
export class JavaBin extends Context.Tag("JavaBin")<JavaBin, string>() {}
```

In the layer body, resolve it with a default:

```ts
    const javaBin = yield* Effect.serviceOption(JavaBin).pipe(
      Effect.map((o) => (o._tag === "Some" ? o.value : "java"))
    );
```

Now the test provides `JavaBin` = a tiny script that prints args and sleeps briefly so the PID is alive when we list. Add:

```ts
  it.effect("detached run writes a record with a log file and redirects output", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const tmpDir = yield* fs.makeTempDirectory();
      const pidDir = yield* fs.makeTempDirectory();
      const logDir = yield* fs.makeTempDirectory();

      // Fake "java": ignores classpath, prints a marker, sleeps 2s so it stays alive
      const fakeJava = `${tmpDir}/fake-java`;
      yield* fs.writeFileString(fakeJava, `#!/bin/bash\necho "HELLO_FROM_FAKE_JAVA"\nsleep 2\n`);
      yield* Effect.sync(() => require("node:fs").chmodSync(fakeJava, 0o755));

      const rootLayer = Layer.succeed(ProjectRoot, tmpDir);
      const pidLayer = Layer.succeed(PidDir, pidDir);
      const logLayer = Layer.succeed(LogDir, logDir);
      const javaBinLayer = Layer.succeed(JavaBin, fakeJava);
      const javaProjectLayer = JavaProjectLive.pipe(
        Layer.provide(rootLayer),
        Layer.provide(NodeContext.layer)
      );
      const layer = ProcessManagerLive.pipe(
        Layer.provide(javaProjectLayer),
        Layer.provide(rootLayer),
        Layer.provide(pidLayer),
        Layer.provide(logLayer),
        Layer.provide(javaBinLayer),
        Layer.provide(NodeContext.layer)
      );

      const record = yield* ProcessManagerService.pipe(
        Effect.flatMap((pm) =>
          pm.run(
            { mainClass: "com.example.App", programArgs: [], jvmOpts: [] },
            { detached: true, debug: null }
          )
        ),
        Effect.provide(layer)
      );

      expect(record.mainClass).toBe("com.example.App");
      expect(record.logFile).not.toBe(null);
      expect(record.debugPort).toBe(null);

      // Give the child a moment to write to the log
      yield* Effect.sleep("300 millis");
      const log = yield* fs.readFileString(record.logFile!);
      expect(log).toContain("HELLO_FROM_FAKE_JAVA");

      // Clean up the still-running fake process
      yield* ProcessManagerService.pipe(
        Effect.flatMap((pm) => pm.killByPid(record.pid)),
        Effect.provide(layer)
      );
    }).pipe(Effect.provide(NodeContext.layer))
  );
```

Add the `LogDir` import/tag usage — see Step 7. Add `LogDir` to the imports already present (`Layer`, `Effect`, etc. are imported).

- [ ] **Step 6: Run to verify failure**

Run: `pnpm test:run -- test/services/ProcessManager.test.ts`
Expected: FAIL — `LogDir`/`JavaBin` not exported, `run` ignores options and returns `void`.

- [ ] **Step 7: Implement detached run + record writing**

In `src/services/ProcessManager.ts`:

Add a `LogDir` tag near `PidDir`:

```ts
export class LogDir extends Context.Tag("LogDir")<LogDir, string>() {}
```

Add Node import at top:

```ts
import * as childProcess from "node:child_process";
import * as nodeFs from "node:fs";
```

In the layer body, resolve `logDir` and ensure it exists, alongside `javaBin` from Step 5:

```ts
    const logDir = yield* LogDir;
    yield* fs.makeDirectory(logDir, { recursive: true });
```

Add the `main.ts` wiring later (Task 9). Now rewrite `run`:

```ts
    const writeRecord = (record: ProcessRecord) =>
      fs.writeFileString(pidFile(record.mainClass), JSON.stringify(record));

    const run = (config: RunConfig, options: RunOptions = {}) =>
      Effect.gen(function* () {
        const classpath = yield* project.resolveClasspath;
        const debug = options.debug ?? null;
        const args = buildJavaArgs(config, classpath, debug);
        const startedAt = new Date().toISOString();

        if (options.detached) {
          const logFile = pathSvc.join(
            logDir,
            `${hash}-${config.mainClass}-${startedAt.replace(/[:.]/g, "-")}.log`
          );
          const record: ProcessRecord = yield* Effect.try({
            try: () => {
              const fd = nodeFs.openSync(logFile, "a");
              const child = childProcess.spawn(javaBin, args, {
                detached: true,
                stdio: ["ignore", fd, fd],
                cwd: root,
              });
              nodeFs.closeSync(fd);
              child.unref();
              if (child.pid === undefined) {
                throw new Error("failed to spawn detached process (no pid)");
              }
              return {
                pid: child.pid,
                mainClass: config.mainClass,
                startedAt,
                logFile,
                args: [...config.programArgs],
                debugPort: debug ? debug.port : null,
              };
            },
            catch: (e) =>
              new JavaProcessError({ message: `Failed to start detached: ${String(e)}` }),
          });
          yield* writeRecord(record);
          return record;
        }

        // Foreground path
        const proc = yield* Command.make(javaBin, ...args).pipe(
          Command.stdout("inherit"),
          Command.stderr("inherit"),
          Command.stdin("inherit"),
          Command.start
        );
        const record: ProcessRecord = {
          pid: proc.pid,
          mainClass: config.mainClass,
          startedAt,
          logFile: null,
          args: [...config.programArgs],
          debugPort: debug ? debug.port : null,
        };
        yield* writeRecord(record);

        yield* proc.exitCode.pipe(
          Effect.ensuring(fs.remove(pidFile(config.mainClass)).pipe(Effect.ignore)),
          Effect.flatMap((code) =>
            code === 0
              ? Effect.void
              : Effect.fail(new JavaProcessError({ message: `Java process exited with code ${code}` }))
          )
        );

        return record;
      }).pipe(Effect.scoped, Effect.provideService(CommandExecutor.CommandExecutor, executor));
```

Note: `proc.pid` from `@effect/platform` `Command.start` is a `number`. The foreground `return record` is unreachable in practice when the process is long-lived (the `proc.exitCode` await blocks), which matches existing behaviour — the return type still satisfies the signature for short-lived processes.

- [ ] **Step 8: Run to verify all ProcessManager tests pass**

Run: `pnpm test:run -- test/services/ProcessManager.test.ts`
Expected: PASS, including the detached integration test.

- [ ] **Step 9: Typecheck**

Run: `pnpm typecheck`
Expected: errors only in `start.ts` (calls `pm.run(config)` — still valid since `options` is optional) — should be clean. If `main.ts` does not yet provide `LogDir`/`JavaBin`, typecheck stays green (they're resolved via `LogDir` required + `JavaBin` optional). **`LogDir` is required**, so `main.ts` must provide it before runtime; add it now in Task 9. Typecheck will not catch a missing layer, but tests provide it. Proceed.

- [ ] **Step 10: Commit**

```bash
git add src/services/ProcessManager.ts test/services/ProcessManager.test.ts
git commit -m "feat: support detached java runs with log redirect and process records"
```

---

## Task 4: Wire `LogDir` into `main.ts`

**Files:**
- Modify: `src/main.ts`

- [ ] **Step 1: Provide `LogDir`**

In `src/main.ts`, add after the `PidDirLayer` definition:

```ts
import { LogDir, PidDir, ProcessManagerLive } from "./services/ProcessManager.js";
// ...
const LogDirLayer = Layer.succeed(LogDir, path.join(jrunHome, "logs"));
```

Add `Layer.provide(LogDirLayer)` to `ProcessManagerLayer`:

```ts
const ProcessManagerLayer = ProcessManagerLive.pipe(
  Layer.provide(JavaProjectLayer),
  Layer.provide(ProjectRootLayer),
  Layer.provide(PidDirLayer),
  Layer.provide(LogDirLayer),
  Layer.provide(NodeContext.layer)
);
```

- [ ] **Step 2: Typecheck + build**

Run: `pnpm typecheck && pnpm build`
Expected: clean.

- [ ] **Step 3: Manual smoke (from example project)**

Run:
```bash
cd example && mvn -q compile && node ../dist/main.js start com.example.ApiServer --detached || node ../dist/main.js start com.example.HelloWorld -d
node ../dist/main.js status
```
Expected: `status` lists a process (for a long-running one) or shows none for HelloWorld which exits. A log file appears under `~/.jrun/logs/`.

- [ ] **Step 4: Commit**

```bash
git add src/main.ts
git commit -m "feat: provide LogDir layer for detached run logs"
```

---

## Task 5: `start` CLI — `--detached`, `--debug`, `--debug-suspend`, `--json`

**Files:**
- Modify: `src/commands/start.ts`

- [ ] **Step 1: Add options and thread `RunOptions`**

Rewrite `src/commands/start.ts` option definitions and handler. Add these option defs after `jvmOption`:

```ts
import { Args, Command, Options } from "@effect/cli";

const detachedOption = Options.boolean("detached").pipe(
  Options.withAlias("d"),
  Options.withDescription("Run in the background, redirecting output to a log file")
);
const debugOption = Options.integer("debug").pipe(
  Options.optional,
  Options.withDescription("Enable JDWP debugging on the given port (default 5005)")
);
const debugSuspendOption = Options.boolean("debug-suspend").pipe(
  Options.withDescription("With --debug, suspend the JVM until a debugger attaches")
);
const jsonOption = Options.boolean("json").pipe(
  Options.withDescription("Emit machine-readable JSON output")
);
```

In `Command.make("start", { ... })` add the new options to the config object: `detached: detachedOption, debug: debugOption, debugSuspend: debugSuspendOption, json: jsonOption`, and destructure them in the handler.

Build `RunOptions` from flags (default debug port 5005 when `--debug` present without a value — note `Options.integer(...).pipe(Options.optional)` yields `Option<number>`; presence of the flag without a value is not expressible, so treat `--debug <port>` as required-when-present and add a separate boolean later if needed — for now `--debug` REQUIRES a port; document default 5005 in help and let users pass `--debug 5005`). Construct:

```ts
      const debug = Option.isSome(debugVal)
        ? { port: debugVal.value, suspend: debugSuspend }
        : null;
      const runOptions = { detached, debug };
```

When the user starts a config or class, call `pm.run(config, runOptions)` instead of `pm.run(config)`. Capture the returned record.

- [ ] **Step 2: JSON / human output**

Replace `Console.log(\`Running ${mainClass}...\`)` paths. After `const record = yield* pm.run(config, runOptions);`:

```ts
      if (json) {
        yield* Console.log(
          JSON.stringify({ ok: true, pid: record.pid, logFile: record.logFile, debugPort: record.debugPort })
        );
      } else if (detached) {
        yield* Console.log(
          `Started ${record.mainClass} (PID ${record.pid})` +
            (record.debugPort ? ` [debug:${record.debugPort}]` : "") +
            (record.logFile ? `\nLogs: ${record.logFile}` : "")
        );
      } else {
        yield* Console.log(`Running ${record.mainClass}...`);
      }
```

For the foreground branch the prior `Console.log("Running ...")` printed before `pm.run`; move it after for consistency or keep a pre-run human line guarded by `!json`. Keep human pre-run line only when `!json && !detached`.

**Implementer guidance:** the existing handler has two `pm.run` call sites (saved-config branch and class branch). Refactor so both build a final `config`, then a single tail does `saveLastRun` → `pm.run(config, runOptions)` → output. This removes the duplicated `pm.run`/log lines (DRY).

- [ ] **Step 3: Typecheck + manual check**

Run: `pnpm typecheck && pnpm build`
Then:
```bash
cd example && node ../dist/main.js start com.example.HelloWorld --json
node ../dist/main.js start com.example.ApiServer -d --debug 5005 --json
node ../dist/main.js status
```
Expected: first prints `{"ok":true,...}`; second prints JSON with `"debugPort":5005` and a `logFile`; `status` shows the ApiServer with its debug port.

- [ ] **Step 4: Commit**

```bash
git add src/commands/start.ts
git commit -m "feat: add --detached/--debug/--debug-suspend/--json to start"
```

---

## Task 6: `status` and `list` — `--json`

**Files:**
- Modify: `src/commands/status.ts`, `src/commands/list.ts`

- [ ] **Step 1: `status --json`**

Rewrite `src/commands/status.ts`:

```ts
import { Command, Options } from "@effect/cli";
import { Console, Effect } from "effect";
import { ProcessManagerService } from "../services/ProcessManager.js";

const jsonOption = Options.boolean("json").pipe(
  Options.withDescription("Emit machine-readable JSON output")
);

export const status = Command.make("status", { json: jsonOption }, ({ json }) =>
  Effect.gen(function* () {
    const pm = yield* ProcessManagerService;
    const running = yield* pm.listRunning;

    if (json) {
      yield* Console.log(JSON.stringify(running));
      return;
    }

    if (running.length === 0) {
      yield* Console.log("No tracked processes running");
    } else {
      yield* Console.log("Running processes:");
      for (const proc of running) {
        const dbg = proc.debugPort ? ` [debug:${proc.debugPort}]` : "";
        yield* Console.log(`  ${proc.mainClass} (PID ${proc.pid})${dbg}`);
      }
    }
  })
).pipe(Command.withDescription("Show tracked running processes"));
```

- [ ] **Step 2: `list --json`**

Rewrite `src/commands/list.ts`:

```ts
import { Command, Options } from "@effect/cli";
import { Console, Effect } from "effect";
import { JavaProjectService } from "../services/JavaProject.js";

const jsonOption = Options.boolean("json").pipe(
  Options.withDescription("Emit machine-readable JSON output")
);

export const list = Command.make("list", { json: jsonOption }, ({ json }) =>
  Effect.gen(function* () {
    const project = yield* JavaProjectService;
    const classes = yield* project.findMainClasses;

    if (json) {
      yield* Console.log(JSON.stringify(classes));
      return;
    }

    if (classes.length === 0) {
      yield* Console.log("No main classes found");
    } else {
      yield* Console.log("Available main classes:");
      for (const cls of classes) {
        yield* Console.log(`  ${cls}`);
      }
    }
  })
).pipe(Command.withDescription("List all main classes in the project"));
```

- [ ] **Step 3: Typecheck + manual**

Run: `pnpm typecheck && pnpm build`
```bash
cd example && node ../dist/main.js list --json
node ../dist/main.js status --json
```
Expected: a JSON array of class names; a JSON array of records.

- [ ] **Step 4: Commit**

```bash
git add src/commands/status.ts src/commands/list.ts
git commit -m "feat: add --json to status and list"
```

---

## Task 7: `kill`, `save` — `--json` and exit codes

**Files:**
- Modify: `src/commands/kill.ts`, `src/commands/save.ts`

- [ ] **Step 1: `kill --json` + non-zero exit on not-found**

In `src/commands/kill.ts`, add `jsonOption` (as in Task 6) to the command config and destructure `json`. Replace the not-found handling so that under `--json` it prints `{"ok":false,...}` and fails. Change the explicit-class branch:

```ts
    if (Option.isSome(classOpt)) {
      const target = classOpt.value;
      const result = yield* pm.kill(target).pipe(
        Effect.as("ok" as const),
        Effect.catchTag("ProcessNotFound", () => Effect.succeed("notfound" as const))
      );
      if (result === "notfound") {
        if (json) {
          yield* Console.log(JSON.stringify({ ok: false, error: `No tracked process for ${target}` }));
        } else {
          yield* Console.error(`No tracked process for ${target}`);
        }
        yield* Effect.fail(new Error("process not found"));
        return;
      }
      if (json) {
        yield* Console.log(JSON.stringify({ ok: true, mainClass: target }));
      } else {
        yield* Console.log(`Stopped ${target}.`);
      }
      return;
    }
```

Leave the interactive (no-arg) branch as-is for human use, but guard its `Console.log` lines so that when `json` is set and there are 0 or many processes, it prints a JSON object instead. Minimum: when `json` and `running.length === 0`, print `{"ok":false,"error":"no processes"}` and fail; when exactly one, kill it and print `{"ok":true,"mainClass":...}`. The multi-select prompt is human-only — if `json` and multiple, print `{"ok":false,"error":"ambiguous: specify a class"}` and fail.

- [ ] **Step 2: `save --json`**

In `src/commands/save.ts`, add `jsonOption`, destructure `json`, and replace the final log:

```ts
      if (json) {
        yield* Console.log(JSON.stringify({ ok: true, name }));
      } else {
        yield* Console.log(`Saved config: ${name}`);
      }
```

- [ ] **Step 3: Typecheck + manual**

Run: `pnpm typecheck && pnpm build`
```bash
cd example && node ../dist/main.js save hello com.example.HelloWorld --json
node ../dist/main.js kill com.example.DoesNotExist --json; echo "exit=$?"
```
Expected: `{"ok":true,"name":"hello"}`; then `{"ok":false,...}` with `exit=1`.

- [ ] **Step 4: Commit**

```bash
git add src/commands/kill.ts src/commands/save.ts
git commit -m "feat: add --json and failure exit codes to kill and save"
```

---

## Task 8: `configs` subcommands — `--json`

**Files:**
- Modify: `src/commands/configs.ts`

- [ ] **Step 1: `configs list --json` and `configs show --json`**

Add a shared `jsonOption` at the top of `configs.ts`. Update `configsList` to take `{ json: jsonOption }`; when `json`, print `JSON.stringify(names)`. Update `configsShow` to take `{ name: nameArg, json: jsonOption }`; it already prints the config as JSON — under `--json` print compact `JSON.stringify(config)` (no indent) and on not-found print `{"ok":false,"error":...}` and fail; keep the human branch as the pretty/indented form.

`configsList` becomes:

```ts
const configsList = Command.make("list", { json: jsonOption }, ({ json }) =>
  Effect.gen(function* () {
    const store = yield* ConfigStoreService;
    const names = yield* store.list;
    if (json) {
      yield* Console.log(JSON.stringify(names));
      return;
    }
    if (names.length === 0) {
      yield* Console.log("No saved configurations.");
    } else {
      for (const name of names) {
        yield* Console.log(name);
      }
    }
  })
).pipe(Command.withDescription("List all saved configurations"));
```

- [ ] **Step 2: `configs delete --json`**

`configsDelete` currently prompts for confirmation (human). Add `json: jsonOption`. When `json` is set, **skip the confirm prompt** (agents can't answer it) and delete directly, printing `{"ok":true,"name":...}`; on not-found print `{"ok":false,...}` and fail. Keep the interactive confirm for the human (`!json`) path.

- [ ] **Step 3: Typecheck + manual**

Run: `pnpm typecheck && pnpm build`
```bash
cd example && node ../dist/main.js configs list --json
node ../dist/main.js configs show hello --json
node ../dist/main.js configs delete hello --json
```
Expected: JSON array; compact config JSON; `{"ok":true,"name":"hello"}`.

- [ ] **Step 4: Commit**

```bash
git add src/commands/configs.ts
git commit -m "feat: add --json to configs list/show/delete"
```

---

## Task 9: `jrun logs <class>` command

**Files:**
- Create: `src/commands/logs.ts`
- Modify: `src/main.ts`

- [ ] **Step 1: Implement `logs`**

The command finds the running record for `<class>` via `pm.listRunning`, then prints its `logFile`. With `--follow`, it streams appended content. Create `src/commands/logs.ts`:

```ts
import * as childProcess from "node:child_process";
import { Args, Command, Options } from "@effect/cli";
import { FileSystem } from "@effect/platform";
import { Console, Effect } from "effect";
import { ProcessManagerService } from "../services/ProcessManager.js";

const classArg = Args.text({ name: "class" });
const followOption = Options.boolean("follow").pipe(
  Options.withAlias("f"),
  Options.withDescription("Stream new log output as it is written")
);

export const logs = Command.make("logs", { class_: classArg, follow: followOption }, ({ class_: cls, follow }) =>
  Effect.gen(function* () {
    const pm = yield* ProcessManagerService;
    const fs = yield* FileSystem.FileSystem;
    const running = yield* pm.listRunning;
    const record = running.find((r) => r.mainClass === cls);

    if (!record || !record.logFile) {
      yield* Console.error(`No log file for ${cls} (is it running detached?)`);
      yield* Effect.fail(new Error("no log file"));
      return;
    }

    const exists = yield* fs.exists(record.logFile);
    if (!exists) {
      yield* Console.error(`Log file missing: ${record.logFile}`);
      yield* Effect.fail(new Error("log file missing"));
      return;
    }

    if (follow) {
      const logFile = record.logFile;
      yield* Effect.async<void>((resume) => {
        const child = childProcess.spawn("tail", ["-f", logFile], { stdio: "inherit" });
        child.on("exit", () => resume(Effect.void));
      });
      return;
    }

    const content = yield* fs.readFileString(record.logFile);
    yield* Console.log(content);
  })
).pipe(Command.withDescription("Print or follow the log of a detached run"));
```

- [ ] **Step 2: Register in `main.ts`**

Add `import { logs } from "./commands/logs.js";` and include `logs` in `Command.withSubcommands([build, list, start, save, rerun, status, kill, configs, logs])`.

- [ ] **Step 3: Typecheck + build + manual**

Run: `pnpm typecheck && pnpm build`
```bash
cd example && node ../dist/main.js start com.example.ApiServer -d
node ../dist/main.js logs com.example.ApiServer
node ../dist/main.js kill com.example.ApiServer
```
Expected: prints the captured server output; `--follow` streams until Ctrl-C.

- [ ] **Step 4: Commit**

```bash
git add src/commands/logs.ts src/main.ts
git commit -m "feat: add jrun logs command to print/follow detached run logs"
```

---

## Task 10: Full suite + docs

**Files:**
- Modify: `README.md`, `CLAUDE.md`

- [ ] **Step 1: Run the full suite, typecheck, lint**

Run: `pnpm test:run && pnpm typecheck && pnpm lint`
Expected: all green. Fix any lint issues Biome reports.

- [ ] **Step 2: Update docs**

In `README.md`, add the new flags to the commands table (`start --detached/--debug/--debug-suspend/--json`, `--json` on `list`/`status`, new `logs` command) and a short "Agent / scripting" subsection noting `--json` everywhere. In `CLAUDE.md`, add `jrun logs` and the `--json`/`--detached`/`--debug` flags to the Quick reference.

- [ ] **Step 3: Commit**

```bash
git add README.md CLAUDE.md
git commit -m "docs: document detached, debug, json flags and logs command"
```

---

## Spec Coverage

| Spec requirement | Task |
|---|---|
| Detached `start --detached` with log redirect + `unref` | Task 3, 5 |
| Per-run log files under `~/.jrun/logs` | Task 3, 4 |
| Enriched JSON PID records (`pid/mainClass/startedAt/logFile/args/debugPort`) | Task 2, 3 |
| Legacy raw-int PID fallback + dead-PID reaping | Task 2 |
| JDWP `--debug [port]` arg injection before user jvmOpts | Task 1, 3, 5 |
| `--debug-suspend` (suspend=y) | Task 1, 5 |
| `debugPort` surfaced in `status`/`--json` | Task 6 |
| `--json` on `start/status/list/kill/save/configs list/show/delete` | Tasks 5–8 |
| Action commands emit `{ ok, ... }`; non-zero exit on failure | Tasks 5, 7, 8 |
| `jrun logs <class>` + `--follow` | Task 9 |
| jrun enables JDWP only, never attaches | Task 1, 3 (no attach code anywhere) |

## Out of Scope (this plan)

- `JrunApi` seam (Phase 3 — separate plan).
- Dashboard TUI (Phase 4 — separate plan).
- rg rewrite (Phase 1 — existing plan).
- Debug-port liveness/conflict checking (per spec, out of scope).
