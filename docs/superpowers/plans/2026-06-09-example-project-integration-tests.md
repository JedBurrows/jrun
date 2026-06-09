# Example Project Integration Tests Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a real end-to-end integration test that drives `JrunApi` against the shipped `example/` Maven project, and stop committing the example's build artifacts.

**Architecture:** A single new test file at `test/integration/example-project.test.ts` builds the same Effect runtime/layer stack as `test/api/JrunApi.test.ts`, but points `ProjectRoot` at the real `example/` directory while keeping config/pid/log state in a per-run temp dir. A `beforeAll` probes for `mvn`/`java`/`rg` and, when present, runs `mvn -q compile`; the whole suite is skipped via `describe.skipIf` when the toolchain is absent so clean boxes stay green.

**Tech Stack:** TypeScript, Effect, `@effect/platform-node`, vitest. Real `mvn`/`javac`/`java`/`rg` at runtime.

---

> **Note on TDD ordering:** This plan tests *already-working* application behavior, so the usual red→green flow is inverted: each scenario test is expected to **pass** (or **skip**) immediately. The discipline here is to run after every addition and confirm green/skip before committing, and to verify the skip-gate genuinely engages when the toolchain is missing.

## File Structure

- **Create** `test/integration/example-project.test.ts` — the entire integration suite: layer wiring, toolchain probe, polling helper, and the 4 scenarios.
- **Modify** `.gitignore` — add `example/target/`.
- **Untrack** `example/target/` (5 files currently committed).

No production source changes. No vitest config change (the `test/**/*.test.ts` glob already covers the new file).

---

## Task 1: Untrack and ignore example build artifacts

**Files:**
- Modify: `.gitignore`

- [ ] **Step 1: Untrack the committed build artifacts**

Run:
```bash
git rm -r --cached example/target
```
Expected: `rm 'example/target/...'` for 5 files. The files remain on disk (only the index entry is removed).

- [ ] **Step 2: Add example/target/ to .gitignore**

Append a line to `.gitignore` so it reads:
```
node_modules/
dist/
*.tsbuildinfo
.jrun-classpath-cache
example/target/
```

- [ ] **Step 3: Verify the artifacts are now ignored**

Run:
```bash
git status --porcelain example/ && git check-ignore example/target/classes/com/example/HelloWorld.class
```
Expected: `git status` shows the staged deletions of the 5 `example/target` files (and the modified `.gitignore`), and `git check-ignore` prints the path, confirming it is now ignored.

- [ ] **Step 4: Commit**

```bash
git add .gitignore
git commit -m "chore: untrack example build artifacts and gitignore example/target"
```

---

## Task 2: Integration test scaffold — layers, toolchain gate, compile

**Files:**
- Create: `test/integration/example-project.test.ts`

This task creates the file with the runtime wiring, the toolchain probe, the `mvn compile` step, and a single smoke assertion (scenario 1: discovery). Later tasks append the remaining scenarios to the same `describe`.

- [ ] **Step 1: Write the scaffold + discovery test**

Create `test/integration/example-project.test.ts` with exactly this content:

```typescript
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { NodeContext } from "@effect/platform-node";
import { Layer, ManagedRuntime } from "effect";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { type JrunApi, makeJrunApi } from "../../src/api/JrunApi.js";
import { ConfigDir, ConfigStoreLive } from "../../src/services/ConfigStore.js";
import { JavaProjectLive, ProjectRoot } from "../../src/services/JavaProject.js";
import { LogDir, PidDir, ProcessManagerLive } from "../../src/services/ProcessManager.js";

// example/ lives at the repo root, two levels up from test/integration/.
const exampleRoot = path.resolve(fileURLToPath(import.meta.url), "../../../example");

const onPath = (bin: string): boolean => {
  try {
    execFileSync(process.platform === "win32" ? "where" : "which", [bin], {
      stdio: "ignore",
    });
    return true;
  } catch {
    return false;
  }
};

// Faithful end-to-end run requires the full toolchain. On a box missing any of
// these, skip rather than fail so the suite stays green (e.g. minimal CI, or a
// dev machine without maven).
const toolchainPresent = onPath("mvn") && onPath("java") && onPath("rg");

// JVM startup is ~1-2s; poll an async predicate until it holds or we time out.
const pollUntil = async (
  predicate: () => Promise<boolean>,
  timeoutMs: number,
  intervalMs = 250
): Promise<boolean> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return false;
};

describe.skipIf(!toolchainPresent)("example project (integration)", () => {
  // biome-ignore lint/suspicious/noExplicitAny: test-only runtime handle
  let mr: ManagedRuntime.ManagedRuntime<any, never>;
  let api: JrunApi;
  let stateRoot: string;
  const started: string[] = [];

  beforeAll(async () => {
    // Compile the example exactly as a user would, into example/target/classes.
    execFileSync("mvn", ["-q", "compile"], { cwd: exampleRoot, stdio: "inherit" });

    stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), "jrun-example-it-"));
    const configDir = path.join(stateRoot, "config");
    const pidDir = path.join(stateRoot, "pids");
    const logDir = path.join(stateRoot, "logs");
    for (const d of [configDir, pidDir, logDir]) fs.mkdirSync(d, { recursive: true });

    const ProjectRootLayer = Layer.succeed(ProjectRoot, exampleRoot);
    const ConfigDirLayer = Layer.succeed(ConfigDir, configDir);
    const PidDirLayer = Layer.succeed(PidDir, pidDir);
    const LogDirLayer = Layer.succeed(LogDir, logDir);

    const javaProjectLayer = JavaProjectLive.pipe(
      Layer.provide(ProjectRootLayer),
      Layer.provide(NodeContext.layer)
    );
    const configStoreLayer = ConfigStoreLive.pipe(
      Layer.provide(ConfigDirLayer),
      Layer.provide(NodeContext.layer)
    );
    const processManagerLayer = ProcessManagerLive.pipe(
      Layer.provide(javaProjectLayer),
      Layer.provide(ProjectRootLayer),
      Layer.provide(PidDirLayer),
      Layer.provide(LogDirLayer),
      Layer.provide(NodeContext.layer)
    );

    const appLayer = Layer.mergeAll(javaProjectLayer, configStoreLayer, processManagerLayer);
    mr = ManagedRuntime.make(appLayer);
    const runtime = await mr.runtime();
    api = makeJrunApi(runtime);
  }, 120_000); // mvn compile can be slow on a cold cache

  afterEach(async () => {
    // Best-effort: kill anything a scenario left running. kill() swallows
    // ProcessNotFound, so already-exited classes are harmless.
    for (const cls of started.splice(0)) {
      await api.kill(cls).catch(() => {});
    }
  });

  afterAll(async () => {
    if (mr) await mr.dispose();
    if (stateRoot) fs.rmSync(stateRoot, { recursive: true, force: true });
  });

  it("listMainClasses finds the three example classes", async () => {
    const classes = await api.listMainClasses();
    expect(classes).toEqual([
      "com.example.ApiServer",
      "com.example.DataProcessor",
      "com.example.HelloWorld",
    ]);
  });
});
```

- [ ] **Step 2: Run the new file and confirm it passes (or skips)**

Run:
```bash
pnpm test:run -- test/integration/example-project.test.ts
```
Expected, when `mvn`/`java`/`rg` are present: `1 passed`. When the toolchain is absent: the describe block is **skipped** (vitest reports the suite as skipped, exit 0). Either outcome is acceptable — confirm there are **no failures**.

- [ ] **Step 3: Verify the skip-gate engages (only if toolchain IS present)**

Temporarily confirm the gate by running with a stripped PATH so `mvn` is hidden:
```bash
env PATH=/usr/bin pnpm test:run -- test/integration/example-project.test.ts
```
Expected: the suite is reported as **skipped** (not failed). Restore and re-run normally afterward. (If your toolchain is already absent, the previous step already demonstrated the skip — note that and move on.)

- [ ] **Step 4: Commit**

```bash
git add test/integration/example-project.test.ts
git commit -m "test: integration scaffold + main-class discovery against example project"
```

---

## Task 3: DataProcessor scenario (batch job → exits)

**Files:**
- Modify: `test/integration/example-project.test.ts`

- [ ] **Step 1: Add the DataProcessor test**

Insert this `it` block inside the `describe`, immediately after the `listMainClasses` test:

```typescript
  it("DataProcessor runs detached, logs Done., then exits", async () => {
    const cls = "com.example.DataProcessor";
    started.push(cls);
    const rec = await api.start({
      mainClass: cls,
      args: ["--count", "2", "--label", "order"],
      detached: true,
    });
    expect(rec.pid).toBeGreaterThan(0);

    // Log accrues as the JVM runs; wait for the completion marker.
    const logged = await pollUntil(async () => {
      const log = await api.readLog(cls);
      return log?.includes("Done.") ?? false;
    }, 30_000);
    expect(logged).toBe(true);

    // A batch job exits on its own; it should drop out of listRunning.
    const exited = await pollUntil(async () => {
      const running = await api.listRunning();
      return !running.some((r) => r.mainClass === cls);
    }, 30_000);
    expect(exited).toBe(true);
  }, 60_000);
```

- [ ] **Step 2: Run and confirm pass/skip**

Run:
```bash
pnpm test:run -- test/integration/example-project.test.ts
```
Expected (toolchain present): `2 passed`. Otherwise: skipped, no failures.

- [ ] **Step 3: Commit**

```bash
git add test/integration/example-project.test.ts
git commit -m "test: DataProcessor batch-run scenario against example project"
```

---

## Task 4: ApiServer scenario (long-running → kill)

**Files:**
- Modify: `test/integration/example-project.test.ts`

- [ ] **Step 1: Add the ApiServer test**

Insert this `it` block inside the `describe`, after the DataProcessor test:

```typescript
  it("ApiServer runs until killed, then disappears from listRunning", async () => {
    const cls = "com.example.ApiServer";
    started.push(cls);
    await api.start({ mainClass: cls, args: ["--port", "8099"], detached: true });

    // Long-runner: it should appear in listRunning and log its banner.
    const appeared = await pollUntil(async () => {
      const running = await api.listRunning();
      return running.some((r) => r.mainClass === cls);
    }, 30_000);
    expect(appeared).toBe(true);

    const banner = await pollUntil(async () => {
      const log = await api.readLog(cls);
      return log?.includes("Server started") ?? false;
    }, 30_000);
    expect(banner).toBe(true);

    await api.kill(cls);

    const gone = await pollUntil(async () => {
      const running = await api.listRunning();
      return !running.some((r) => r.mainClass === cls);
    }, 30_000);
    expect(gone).toBe(true);
  }, 60_000);
```

- [ ] **Step 2: Run and confirm pass/skip**

Run:
```bash
pnpm test:run -- test/integration/example-project.test.ts
```
Expected (toolchain present): `3 passed`. Otherwise: skipped, no failures.

- [ ] **Step 3: Commit**

```bash
git add test/integration/example-project.test.ts
git commit -m "test: ApiServer long-running + kill scenario against example project"
```

---

## Task 5: HelloWorld scenario (foreground → clean exit)

**Files:**
- Modify: `test/integration/example-project.test.ts`

- [ ] **Step 1: Add the HelloWorld test**

Insert this `it` block inside the `describe`, after the ApiServer test:

```typescript
  it("HelloWorld runs in the foreground and resolves on clean exit", async () => {
    const cls = "com.example.HelloWorld";
    // Foreground start blocks until the process exits; a clean exit (code 0)
    // resolves, a non-zero exit rejects with JavaProcessError.
    const rec = await api.start({ mainClass: cls, args: ["Alice"], detached: false });
    expect(rec.mainClass).toBe(cls);
    expect(rec.detached).toBe(false);
  }, 60_000);
```

- [ ] **Step 2: Run the full file and confirm all scenarios pass/skip**

Run:
```bash
pnpm test:run -- test/integration/example-project.test.ts
```
Expected (toolchain present): `4 passed`. Otherwise: skipped, no failures.

- [ ] **Step 3: Run the whole suite to confirm no regressions**

Run:
```bash
pnpm test:run
```
Expected: all existing suites plus the integration suite pass (integration suite skipped if toolchain absent). No failures.

- [ ] **Step 4: Typecheck and lint**

Run:
```bash
pnpm typecheck && pnpm lint
```
Expected: both clean. If biome flags import ordering or formatting in the new file, run `pnpm lint:fix` and re-stage.

- [ ] **Step 5: Commit**

```bash
git add test/integration/example-project.test.ts
git commit -m "test: HelloWorld foreground scenario against example project"
```

---

## Self-Review Notes

- **Spec coverage:** Task 1 → gitignore section. Task 2 → architecture + toolchain gate + scenario 1 (discovery). Task 3 → scenario 2 (DataProcessor). Task 4 → scenario 3 (ApiServer). Task 5 → scenario 4 (HelloWorld). Teardown (`afterEach`/`afterAll`) is in Task 2's scaffold. All spec sections mapped.
- **Type consistency:** `api` is `JrunApi`; methods used (`listMainClasses`, `start`, `kill`, `readLog`, `listRunning`) match `src/api/JrunApi.ts`. `ProcessRecord` fields used (`pid`, `mainClass`, `detached`) match `src/services/ProcessManager.ts`. Layer tags (`ProjectRoot`, `ConfigDir`, `PidDir`, `LogDir`, `*Live`) match the service modules.
- **No placeholders:** every code/command step has concrete content.
