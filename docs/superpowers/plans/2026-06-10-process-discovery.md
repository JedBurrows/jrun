# OS-Discovery Process Tracking Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace jrun's per-class PID-file registry with pure OS process discovery, so multiple instances of the same main class are tracked correctly, orphans are visible, and jrun can never desync from reality.

**Architecture:** A new `ProcessProbe` service abstracts the Linux `/proc` filesystem behind an injectable seam. jrun injects a self-identifying marker (`-Djrun.project=<hash>`) into every JVM it launches; a pure `discovery` module owns a process iff its `/proc` argv carries that marker (see v2 Revisions). `ProcessManager.listRunning` becomes a probe-driven scan with zero persisted state and **no `rg` dependency**; logs are located by globbing PID-encoded filenames. Kill targets a PID and signals its process group, defaulting to the group signal when `/proc` can't be read.

**Tech Stack:** TypeScript, Effect (`@effect/platform` FileSystem/Path/Command, Context.Tag services, Layer), Ink/React TUI, Vitest + `@effect/vitest`.

**Reference spec:** `docs/superpowers/specs/2026-06-10-process-discovery-design.md`

---

## ⚠️ v2 Revisions (post-adversarial-review) — READ FIRST, these OVERRIDE the task bodies below

The architect + devil's-advocate review changed the core matching strategy and several details.
Where a task body below conflicts with this section, **this section wins**. The reference spec is
fully updated; tasks are dispatched with corrected text by the lead.

**R1 — Ownership is a self-identifying marker, NOT cwd+class.** `buildJavaArgs` prepends
`-Djrun.project=<projectHash>` (md5 of project root — same hash used for log names). A process is
owned iff its `/proc/<pid>/cmdline` argv contains that exact token. Consequences:
- **Task 3 (discovery) is rewritten.** No known-class set, no `cwd` requirement, no `ConfigStore`.
  - `ownsProcess(argv, marker): boolean` — `argv.includes(marker)`.
  - `extractMainClass(argv): string | null` — **positional only**: find `-cp`/`-classpath`/`--class-path`, return `argv[i+2]`; else **`null`** (do NOT guess "first token after the marker" — that could grab a `-jar` value/`@argfile`/program arg and surface a garbage FQCN). jrun always emits `-cp`, so an owned process always extracts; when it doesn't, `matchProcess` records the class as `(unknown)` rather than dropping the process. (No known-set param.)
  - `matchProcess(snap, { marker }): DiscoveredProcess | null` — owns by marker, then extracts class/args/debugPort; `pid`/`pgid`/`startedAt` straight from the snapshot.
  - **DELETE** the planned test `extractMainClass(argv, new Set()) → "com.example.Unknown"` — it encoded a bug. **ADD** a test: an **unmarked** java snapshot with cwd=root and `-cp x com.example.ApiServer` → `matchProcess` returns `null` (the IntelliJ/Gradle false-positive must be excluded).
- **Task 5 (listRunning) simplifies.** It no longer calls `project.findMainClasses`; it does NOT
  depend on `rg`/`ConfigStore`. `const marker = "-Djrun.project=" + hash;` then `probe.listJava` →
  `matchProcess(snap, { marker })` → derive `logFile`. Drop the `stubProject`-for-discovery wiring
  and the `Effect.catchAll(()=>[])` known-set guard (no longer relevant). `run`'s tests still need
  a `stubProject` because `run` calls `resolveClasspath`.

**R2 — `buildJavaArgs` marker (folded into Task 6, do FIRST within it).** Prepend the marker to
the returned args. **Single source of truth (architect):** the token `-Djrun.project=` is on BOTH
sides of an equality check (spawn side in `buildJavaArgs`; discovery side in `matchProcess`/
`listRunning`). Define it ONCE and import it in both, so a future edit can't silently break
ownership:
```ts
// in discovery.ts (or a shared module both import)
export const projectMarker = (hash: string): string => `-Djrun.project=${hash}`;
```
`buildJavaArgs`'s current signature is `(config, classpath, debug)` — it has neither root nor
hash. Thread the hash (or the prebuilt marker string) in as a new parameter, and have
`run`/`ProcessManager` pass `projectHash(root)`. `discovery.matchProcess({ marker })` receives
`projectMarker(hash)`. **Add a round-trip test:** `buildJavaArgs(...)` output contains
`projectMarker(hash)` AND `ownsProcess(thatOutput, projectMarker(hash))` is true — this is the
only test that catches the two literals drifting apart. Update the two existing `buildJavaArgs`
unit tests' expected arrays to include the marker as the first element.

**R3 — Kill defaults to GROUP signal when `/proc` read fails (Task 7).**
`const group = snap === null ? true : snap.pgid === pid;` — never downgrade to single-PID on a
read race (would strand detached children + bound ports). Add a test: `inspect` returns `null` →
group signal used.

**R4 — `run` rename is best-effort (Task 6).** Once `child.pid` exists, NEVER fail `run`. Wrap
the `renameSync` in its own try/catch INSIDE the success path; on failure keep the `.tmp` path as
`logFile` and return the record. The outer `Effect.try` catch only covers pre-spawn setup + spawn.

**R5 — `kill <pid>` ownership guard (Task 10).** Add a `--force` boolean option. `resolveKillTarget`
for a numeric arg returns `{ kind: "pid", pid, owned: running.some(r => r.pid === pid) }`. In the
command: if `!owned && !force` → refuse with a clear message / `{ok:false,error:"unowned pid; use --force"}` and exit 1. Update the resolver test accordingly (drop "untracked PID still resolves" as unconditional).

**R6 — `logs <pid>` resolves exited PIDs + TUI logs by PID (Tasks 11, 12).**
- Task 8: add `readLogByPidAnyClass(pid)` that globs `<hash>-*-<pid>.log` (class-agnostic) for the
  finished-PID case; `logs <pid>` uses it when the PID isn't in `listRunning`.
- Task 12: the dashboard log action must call `api.readLogByPid(rec.mainClass, rec.pid)` (NOT the
  newest-by-class `readLog`), so selecting one of two same-class rows shows that instance's log.

**R7 — Mandatory real-`/proc` test, un-gated (Task 14 or its own file). USE THE EMPIRICALLY-
VERIFIED RECIPE BELOW** — the devil's advocate *ran* the alternatives on a real `/proc` and they
all fail:
- `exec -a java sleep 30 <marker>` → `sleep` rejects `-Djrun.project=…` (`invalid option 'D'`) and
  dies instantly. Same for `tail`/most coreutils.
- A shebang script *named* `java` → kernel runs it as `/bin/sh <script> …`, so
  `cmdline[0] = /bin/sh` (basename `sh`), which **fails `isJava`**.

**Verified-working recipe — use Node's `argv0` option (devil's-advocate recipe (c), cleanest for
vitest: no temp file, no shell quoting, deterministic):**
```ts
import * as cp from "node:child_process";
const marker = projectMarker(hash); // = `-Djrun.project=${md5(root)}`, same helper the manager uses
const child = cp.spawn(
  "/bin/sh",
  ["-c", "while :; do sleep 1; done", "_", marker, "-cp", "x", "com.example.App"],
  { argv0: "java", cwd: root, stdio: "ignore" }
);
// /proc/<child.pid>/cmdline ≈ [java, -c, "while…", _, -Djrun.project=<hash>, -cp, x, com.example.App]
```
Why it works: Node's `argv0: "java"` sets the execve argv[0] so `/proc/cmdline[0]` basename is
`java` (→ `isJava` ✓), while everything after the `-c '<script>'` string (`_` becomes `$0`, then
`marker`, `-cp`, `x`, `com.example.App` are positional `$1..$4`) is NOT parsed as a shell option —
so the `-Djrun.project=…` and `-cp` tokens land verbatim in argv. Owned by marker ✓,
`extractMainClass` finds `-cp`→`com.example.App` ✓. Assert the **live `ProcessProbeLive` + real
`listRunning`** returns `child.pid` with `mainClass === "com.example.App"`. NOT gated on
`mvn`/`java`/`rg`. Kill the child in `afterEach`/`finally`. (Do NOT use a shebang script named
`java` — the kernel execs the interpreter so `cmdline[0]` becomes `/bin/sh`/`/bin/bash` and
`isJava` fails; and do NOT pass the marker to `sleep`/`tail`, which reject `-D…` as a bad option
and die — both verified failing.) Also strengthen the live-probe smoke test to assert `pgid` and
non-empty `argv`, not just `pid`/`cwd`.

**R8 — Build-greenness policy (fixes the misleading per-task `typecheck` gates).** Removing
`PidDir`/`kill(className)`/`detached` from `ProcessManager` breaks `main.ts`, `JrunApi`, and the
CLI until they're rewired. To avoid stranding an implementer on unrelated red:
- **Tasks 1–4** are additive → each ends with the FULL gate: `pnpm typecheck && pnpm build && pnpm test:run`.
- **Tasks 5–12 are ONE coordinated red window.** During it, verify with **targeted** `pnpm test:run <file>` only (NOT project `typecheck`). The lead dispatches these as a tight sequence and the implementer for each is told which stale references are expected.
- **Task 13 (main.ts rewire) is the GREEN GATE:** it must end with `pnpm typecheck && pnpm build && pnpm lint && pnpm test:run` ALL green, project-wide. Nothing proceeds to Task 14 until then.
- **Green-gate off-by-one fix (architect):** `test/integration/example-project.test.ts` is a member
  of project `tsc --noEmit` but isn't migrated until T14 — it still imports `PidDir`, asserts
  `rec.detached`, and calls `api.kill(cls)`, all of which break the moment T5/T9 remove those
  symbols. So **T13 must also migrate the integration harness's breaking references** (drop
  `PidDir`/`PidDirLayer`, add `Layer.provide(ProcessProbeLive)`, change `rec.detached` assertion →
  `rec.logFile === null`, change `api.kill(cls)` in `afterEach` → kill by discovered `rec.pid`)
  so the project typecheck is green. T14 then ONLY adds the new two-instance regression test and
  the real-`/proc` discovery test — it introduces no new compile breakage.
- Alternatively (lead's discretion) collapse Tasks 5–13 into one larger atomic commit if an
  implementer struggles with the red window — but the green gate at the end is non-negotiable.

**R9 — `ProcessRecord` keeps no `pgid`; `detached` removed.** (Unchanged from plan; spec updated to match — don't "fix" `pgid` back onto the record.) `status --json` shape losing `detached` is an accepted contract change.

**Dissolved by R1 (do NOT implement):** the saved-config∪rg known-set union, `ConfigStore`
injection into `ProcessManager`, the `findMainClasses` defect/`catchAll` handling in `listRunning`,
and the per-invocation known-set cache — none are needed once ownership is the marker.

---

## File Structure

**New files:**
- `src/platform.ts` — pure `unsupportedPlatformMessage(platform)` guard helper.
- `src/services/ProcessProbe.ts` — `ProcessSnapshot` type, `ProcessProbe` tag, `ProcessProbeLive` (`/proc` reader), and exported pure parsers (`parseProcStat`, `startedAtFromStat`, `parseCmdline`).
- `src/services/discovery.ts` — pure discovery core: `extractMainClass`, `extractDebugPort`, `extractProgramArgs`, `matchProcess`.
- `src/services/logNaming.ts` — pure log-filename builders/matchers: `compactStamp`, `logFileName`, `pickRunningLog`, `pickNewestLog`.
- `test/services/ProcessProbe.test.ts`, `test/services/discovery.test.ts`, `test/services/logNaming.test.ts`, `test/platform.test.ts`.

**Modified files:**
- `src/services/ProcessManager.ts` — drop PID-file machinery + `PidDir` + `detached`; `listRunning` uses probe+discovery; `run` uses temp-then-rename logs; `killByPid` uses observed pgid.
- `src/api/JrunApi.ts` — `kill(pid)`, `readLogByPid(pid)`.
- `src/commands/kill.ts`, `src/commands/logs.ts` — accept a PID or a class; ambiguity handling.
- `src/tui/dashboard/Dashboard.tsx` — kill by `rec.pid`.
- `src/main.ts` — platform guard; provide `ProcessProbeLive`; remove `PidDir` wiring.
- Tests: `test/services/ProcessManager.test.ts`, `test/api/JrunApi.test.ts`, `test/integration/example-project.test.ts`, `test/tui/dashboard/Dashboard.test.tsx`, `test/tui/dashboard/navigation.test.ts` — drop `detached`/`PidDir`, add discovery scenarios.

**Conventions to follow (from the existing codebase):**
- Effect services are `Context.Tag` classes; live layers are `Layer.effect`. Tests inject stubs with `Layer.succeed`.
- Process tests that rely on real signals/timers use `it.live` (not `it.effect`, whose TestClock would hang the 2s SIGTERM→SIGKILL delay).
- `pnpm test:run` runs Vitest once; `pnpm typecheck` runs `tsc --noEmit`; `pnpm lint` runs Biome.

---

## Task 1: Non-Linux startup guard

**Files:**
- Create: `src/platform.ts`
- Create: `test/platform.test.ts`
- Modify: `src/main.ts` (add guard near entry, after imports)

- [ ] **Step 1: Write the failing test**

`test/platform.test.ts`:
```ts
import { describe, expect, test } from "vitest";
import { unsupportedPlatformMessage } from "../src/platform.js";

describe("unsupportedPlatformMessage", () => {
  test("returns null on linux", () => {
    expect(unsupportedPlatformMessage("linux")).toBeNull();
  });

  test("returns a message naming the platform on darwin", () => {
    const msg = unsupportedPlatformMessage("darwin");
    expect(msg).toContain("darwin");
    expect(msg).toContain("/proc");
  });

  test("returns a message on win32", () => {
    expect(unsupportedPlatformMessage("win32")).toContain("win32");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test:run test/platform.test.ts`
Expected: FAIL — cannot find module `../src/platform.js`.

- [ ] **Step 3: Write minimal implementation**

`src/platform.ts`:
```ts
/**
 * jrun's process discovery reads `/proc`, which only exists on Linux (and WSL,
 * which reports `process.platform === "linux"`). Returns an error message to
 * print, or `null` when the platform is supported.
 */
export const unsupportedPlatformMessage = (platform: string): string | null => {
  if (platform === "linux") return null;
  return (
    `jrun requires Linux or WSL (detected ${platform}). ` +
    `Process discovery relies on /proc, which is unavailable on this platform.`
  );
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test:run test/platform.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Wire the guard into `main.ts`**

In `src/main.ts`, add the import alongside the other `./` imports:
```ts
import { unsupportedPlatformMessage } from "./platform.js";
```
Then immediately before `const cwd = process.cwd();` (line ~38), add:
```ts
const platformError = unsupportedPlatformMessage(process.platform);
if (platformError !== null) {
  console.error(platformError);
  process.exit(1);
}
```

- [ ] **Step 6: Verify build + typecheck**

Run: `pnpm typecheck && pnpm build`
Expected: both succeed.

- [ ] **Step 7: Commit**

```bash
git add src/platform.ts test/platform.test.ts src/main.ts
git commit -m "feat(platform): guard against non-Linux at startup"
```

---

## Task 2: ProcessProbe seam + `/proc` parsers

**Files:**
- Create: `src/services/ProcessProbe.ts`
- Create: `test/services/ProcessProbe.test.ts`

The probe abstracts the OS process table. `ProcessProbeLive` reads `/proc`; tests use the pure parsers directly and inject a `Layer.succeed` stub of the service where needed.

- [ ] **Step 1: Write the failing test for the pure parsers**

`test/services/ProcessProbe.test.ts`:
```ts
import { describe, expect, test } from "vitest";
import {
  parseCmdline,
  parseProcStat,
  startedAtFromStat,
} from "../../src/services/ProcessProbe.js";

describe("parseProcStat", () => {
  test("extracts pgid and starttime, tolerating spaces/parens in comm", () => {
    // Fields: pid (comm) state ppid pgrp session ... starttime(22) ...
    const line =
      "169627 (java (worker)) S 1695 169627 169627 0 -1 0 0 0 0 0 12 3 0 0 20 0 1 0 4242 0 0";
    const parsed = parseProcStat(line);
    expect(parsed?.pgid).toBe(169627);
    expect(parsed?.starttimeTicks).toBe(4242);
  });

  test("returns null on garbage", () => {
    expect(parseProcStat("not a stat line")).toBeNull();
  });
});

describe("startedAtFromStat", () => {
  test("computes ISO start time from btime + starttime/USER_HZ", () => {
    // btime = 1_000_000s, starttime = 500 ticks @ 100Hz => +5s => 1_000_005s.
    const iso = startedAtFromStat(500, 1_000_000, 100);
    expect(iso).toBe(new Date(1_000_005_000).toISOString());
  });
});

describe("parseCmdline", () => {
  test("splits NUL-separated argv and drops the trailing empty token", () => {
    const buf = "java\0-cp\0a:b c\0com.example.App\0--port\08080\0";
    expect(parseCmdline(buf)).toEqual([
      "java",
      "-cp",
      "a:b c",
      "com.example.App",
      "--port",
      "8080",
    ]);
  });

  test("returns [] for empty cmdline (kernel threads)", () => {
    expect(parseCmdline("")).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test:run test/services/ProcessProbe.test.ts`
Expected: FAIL — cannot find module.

- [ ] **Step 3: Write the implementation**

`src/services/ProcessProbe.ts`:
```ts
import * as nodeFs from "node:fs";
import { Context, Effect, Layer } from "effect";

/** A point-in-time view of one process, sourced from `/proc/<pid>`. */
export interface ProcessSnapshot {
  readonly pid: number;
  readonly pgid: number;
  /** `readlink /proc/<pid>/cwd`, or null when unreadable (not ours / gone). */
  readonly cwd: string | null;
  /** True argv from `/proc/<pid>/cmdline` (NUL-split). */
  readonly argv: readonly string[];
  /** ISO start time, or null when it can't be computed. */
  readonly startedAt: string | null;
}

export interface ProcessProbe {
  /** Snapshot every `java` process the current user can inspect. */
  readonly listJava: Effect.Effect<ProcessSnapshot[]>;
  /** Snapshot a single PID, or null if it's gone/unreadable. */
  readonly inspect: (pid: number) => Effect.Effect<ProcessSnapshot | null>;
}

export class ProcessProbeService extends Context.Tag("ProcessProbe")<
  ProcessProbeService,
  ProcessProbe
>() {}

const USER_HZ = 100; // CLK_TCK; 100 on all mainstream Linux/x86 — see proc(5).

/** Parse `/proc/<pid>/stat`. `comm` (field 2) is wrapped in parens and may
 *  itself contain spaces and parens, so we split on the LAST ')'. */
export const parseProcStat = (
  line: string
): { pgid: number; starttimeTicks: number } | null => {
  const close = line.lastIndexOf(")");
  if (close < 0) return null;
  const rest = line.slice(close + 1).trim().split(/\s+/);
  // rest[0]=state(f3) rest[1]=ppid(f4) rest[2]=pgrp(f5) ... rest[19]=starttime(f22)
  const pgid = Number(rest[2]);
  const starttimeTicks = Number(rest[19]);
  if (!Number.isFinite(pgid) || !Number.isFinite(starttimeTicks)) return null;
  return { pgid, starttimeTicks };
};

/** Convert a process start time (ticks since boot) to an ISO timestamp. */
export const startedAtFromStat = (
  starttimeTicks: number,
  btimeSec: number,
  userHz = USER_HZ
): string => new Date((btimeSec + starttimeTicks / userHz) * 1000).toISOString();

/** Split `/proc/<pid>/cmdline` (NUL-separated, NUL-terminated) into argv. */
export const parseCmdline = (raw: string): string[] =>
  raw.split("\0").filter((s) => s.length > 0);

const readBtime = (): number | null => {
  try {
    const stat = nodeFs.readFileSync("/proc/stat", "utf8");
    const m = stat.match(/^btime\s+(\d+)/m);
    return m ? Number(m[1]) : null;
  } catch {
    return null;
  }
};

const snapshot = (pid: number, btime: number | null): ProcessSnapshot | null => {
  let argv: string[];
  try {
    argv = parseCmdline(nodeFs.readFileSync(`/proc/${pid}/cmdline`, "utf8"));
  } catch {
    return null; // process vanished between readdir and read
  }
  if (argv.length === 0) return null; // kernel thread
  let pgid = pid;
  let startedAt: string | null = null;
  try {
    const stat = parseProcStat(nodeFs.readFileSync(`/proc/${pid}/stat`, "utf8"));
    if (stat) {
      pgid = stat.pgid;
      if (btime !== null) startedAt = startedAtFromStat(stat.starttimeTicks, btime);
    }
  } catch {
    /* keep defaults */
  }
  let cwd: string | null = null;
  try {
    cwd = nodeFs.readlinkSync(`/proc/${pid}/cwd`);
  } catch {
    cwd = null; // EACCES for processes we don't own, or already exited
  }
  return { pid, pgid, cwd, argv, startedAt };
};

const isJava = (argv: readonly string[]): boolean => {
  const exe = argv[0] ?? "";
  const base = exe.slice(exe.lastIndexOf("/") + 1);
  return base === "java";
};

export const ProcessProbeLive = Layer.succeed(ProcessProbeService, {
  listJava: Effect.sync(() => {
    const btime = readBtime();
    let pids: string[];
    try {
      pids = nodeFs.readdirSync("/proc");
    } catch {
      return [];
    }
    const out: ProcessSnapshot[] = [];
    for (const entry of pids) {
      if (!/^\d+$/.test(entry)) continue;
      const snap = snapshot(Number(entry), btime);
      if (snap && isJava(snap.argv)) out.push(snap);
    }
    return out;
  }),
  inspect: (pid: number) => Effect.sync(() => snapshot(pid, readBtime())),
});
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test:run test/services/ProcessProbe.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Smoke-test the live probe finds this node process**

Add to `test/services/ProcessProbe.test.ts`:
```ts
import { Effect } from "effect";
import { ProcessProbeLive, ProcessProbeService } from "../../src/services/ProcessProbe.js";

test("live probe inspect() returns a snapshot for the current process", async () => {
  const snap = await Effect.runPromise(
    ProcessProbeService.pipe(
      Effect.flatMap((p) => p.inspect(process.pid)),
      Effect.provide(ProcessProbeLive)
    )
  );
  expect(snap?.pid).toBe(process.pid);
  expect(snap?.cwd).not.toBeNull();
});
```

Run: `pnpm test:run test/services/ProcessProbe.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 6: Commit**

```bash
git add src/services/ProcessProbe.ts test/services/ProcessProbe.test.ts
git commit -m "feat(probe): add ProcessProbe /proc seam with pure parsers"
```

---

## Task 3: Pure discovery core

**Files:**
- Create: `src/services/discovery.ts`
- Create: `test/services/discovery.test.ts`

Defines the record shape produced by discovery (everything except the log path, which Task 5 derives). `DiscoveredProcess` is `ProcessRecord` minus `logFile`.

- [ ] **Step 1: Write the failing test**

`test/services/discovery.test.ts`:
```ts
import { describe, expect, test } from "vitest";
import {
  extractDebugPort,
  extractMainClass,
  extractProgramArgs,
  matchProcess,
} from "../../src/services/discovery.js";
import type { ProcessSnapshot } from "../../src/services/ProcessProbe.js";

const known = new Set(["com.example.ApiServer", "com.example.HelloWorld"]);

describe("extractMainClass", () => {
  test("finds a known class token among argv", () => {
    const argv = ["java", "-cp", "target/classes", "com.example.ApiServer", "--port", "8099"];
    expect(extractMainClass(argv, known)).toBe("com.example.ApiServer");
  });

  test("survives a garbage classpath that contains spaces", () => {
    // The real-world broken case: mvn error text captured into -cp as ONE argv token.
    const argv = [
      "java",
      "-cp",
      "target/classes:[ERROR] Failed to execute goal ... No such device",
      "com.example.ApiServer",
    ];
    expect(extractMainClass(argv, known)).toBe("com.example.ApiServer");
  });

  test("falls back to the token after -cp when no known class matches", () => {
    const argv = ["java", "-cp", "cp", "com.example.Unknown", "x"];
    expect(extractMainClass(argv, new Set())).toBe("com.example.Unknown");
  });

  test("returns null when no main class can be found", () => {
    expect(extractMainClass(["java", "-version"], known)).toBeNull();
  });
});

describe("extractDebugPort", () => {
  test("parses address=*:PORT", () => {
    const argv = ["java", "-agentlib:jdwp=transport=dt_socket,server=y,suspend=n,address=*:5005"];
    expect(extractDebugPort(argv)).toBe(5005);
  });
  test("parses address=PORT (no host)", () => {
    expect(extractDebugPort(["java", "-agentlib:jdwp=...,address=6000"])).toBe(6000);
  });
  test("returns null without a jdwp arg", () => {
    expect(extractDebugPort(["java", "-cp", "x", "Main"])).toBeNull();
  });
});

describe("extractProgramArgs", () => {
  test("returns tokens after the main class", () => {
    const argv = ["java", "-cp", "x", "com.example.ApiServer", "--port", "8099"];
    expect(extractProgramArgs(argv, "com.example.ApiServer")).toEqual(["--port", "8099"]);
  });
  test("returns [] when the main class is the last token", () => {
    expect(extractProgramArgs(["java", "-cp", "x", "Main"], "Main")).toEqual([]);
  });
});

describe("matchProcess", () => {
  const base: ProcessSnapshot = {
    pid: 100,
    pgid: 100,
    cwd: "/proj",
    argv: ["java", "-cp", "target/classes", "com.example.ApiServer", "--port", "8099"],
    startedAt: "2026-06-10T00:00:00.000Z",
  };
  const ctx = { projectRoot: "/proj", knownClasses: known };

  test("matches a java process in the project with a known class", () => {
    expect(matchProcess(base, ctx)).toEqual({
      pid: 100,
      pgid: 100,
      mainClass: "com.example.ApiServer",
      startedAt: "2026-06-10T00:00:00.000Z",
      args: ["--port", "8099"],
      debugPort: null,
    });
  });

  test("excludes a process whose cwd is not the project root", () => {
    expect(matchProcess({ ...base, cwd: "/elsewhere" }, ctx)).toBeNull();
  });

  test("excludes a process with no recognized main-class token", () => {
    expect(matchProcess({ ...base, argv: ["java", "-version"] }, ctx)).toBeNull();
  });

  test("excludes a process with a null (unreadable) cwd", () => {
    expect(matchProcess({ ...base, cwd: null }, ctx)).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test:run test/services/discovery.test.ts`
Expected: FAIL — cannot find module.

- [ ] **Step 3: Write the implementation**

`src/services/discovery.ts`:
```ts
import type { ProcessSnapshot } from "./ProcessProbe.js";

/** A discovered process — a ProcessRecord minus the (derived) log path. */
export interface DiscoveredProcess {
  readonly pid: number;
  readonly pgid: number;
  readonly mainClass: string;
  readonly startedAt: string | null;
  readonly args: readonly string[];
  readonly debugPort: number | null;
}

const CP_FLAGS = new Set(["-cp", "-classpath", "--class-path"]);

/**
 * Extract the main class from a java argv.
 *
 * Primary: the first argv token that is a member of `knownClasses` — robust
 * even when the classpath itself is malformed (the captured-mvn-error case).
 * Fallback: the token immediately after `-cp`/`-classpath`/`--class-path` (jrun
 * always emits `-cp <cp> <mainClass> <args…>`).
 */
export const extractMainClass = (
  argv: readonly string[],
  knownClasses: ReadonlySet<string>
): string | null => {
  for (const tok of argv) if (knownClasses.has(tok)) return tok;
  for (let i = 0; i < argv.length; i++) {
    if (CP_FLAGS.has(argv[i]!) && i + 2 < argv.length) return argv[i + 2]!;
  }
  return null;
};

/** Parse a JDWP debug port from `-agentlib:jdwp=…address=[host:]PORT`. */
export const extractDebugPort = (argv: readonly string[]): number | null => {
  for (const tok of argv) {
    if (!tok.includes("jdwp")) continue;
    const m = tok.match(/address=(?:[^:,]*:)?(\d+)/);
    if (m) return Number(m[1]);
  }
  return null;
};

/** Program args are everything after the main-class token. */
export const extractProgramArgs = (
  argv: readonly string[],
  mainClass: string
): string[] => {
  const idx = argv.indexOf(mainClass);
  return idx < 0 ? [] : argv.slice(idx + 1);
};

export interface MatchContext {
  readonly projectRoot: string;
  readonly knownClasses: ReadonlySet<string>;
}

/**
 * Decide whether a snapshot is one of this project's processes and, if so,
 * reconstruct its record. Ownership requires BOTH `cwd === projectRoot` AND a
 * recognized main-class token.
 */
export const matchProcess = (
  snap: ProcessSnapshot,
  ctx: MatchContext
): DiscoveredProcess | null => {
  if (snap.cwd !== ctx.projectRoot) return null;
  const mainClass = extractMainClass(snap.argv, ctx.knownClasses);
  if (mainClass === null) return null;
  return {
    pid: snap.pid,
    pgid: snap.pgid,
    mainClass,
    startedAt: snap.startedAt,
    args: extractProgramArgs(snap.argv, mainClass),
    debugPort: extractDebugPort(snap.argv),
  };
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test:run test/services/discovery.test.ts`
Expected: PASS (all cases).

- [ ] **Step 5: Commit**

```bash
git add src/services/discovery.ts test/services/discovery.test.ts
git commit -m "feat(discovery): pure cwd+class matching and argv parsing"
```

---

## Task 4: Log-filename builders/matchers

**Files:**
- Create: `src/services/logNaming.ts`
- Create: `test/services/logNaming.test.ts`

Filename scheme: `<hash>-<mainClass>-<startedAtCompact>-<pid>.log`. Timestamp precedes PID so `<hash>-<class>-*` filenames sort by time.

- [ ] **Step 1: Write the failing test**

`test/services/logNaming.test.ts`:
```ts
import { describe, expect, test } from "vitest";
import {
  compactStamp,
  logFileName,
  pickNewestLog,
  pickRunningLog,
} from "../../src/services/logNaming.js";

describe("compactStamp", () => {
  test("replaces colons and dots so the stamp is filename-safe", () => {
    expect(compactStamp("2026-06-10T12:30:45.123Z")).toBe("2026-06-10T12-30-45-123Z");
  });
});

describe("logFileName", () => {
  test("builds <hash>-<class>-<stamp>-<pid>.log", () => {
    expect(logFileName("abc", "com.example.App", "2026-06-10T12-30-45-123Z", 777)).toBe(
      "abc-com.example.App-2026-06-10T12-30-45-123Z-777.log"
    );
  });
});

describe("pickRunningLog", () => {
  test("selects the file for a specific class+pid", () => {
    const files = [
      "abc-com.example.App-2026-06-10T00-00-00-000Z-100.log",
      "abc-com.example.App-2026-06-10T00-00-01-000Z-200.log",
      "abc-com.example.Other-2026-06-10T00-00-00-000Z-200.log",
    ];
    expect(pickRunningLog(files, "abc", "com.example.App", 200)).toBe(
      "abc-com.example.App-2026-06-10T00-00-01-000Z-200.log"
    );
  });
  test("returns null when no file matches the pid", () => {
    expect(pickRunningLog([], "abc", "com.example.App", 999)).toBeNull();
  });
});

describe("pickNewestLog", () => {
  test("returns the newest (lexicographically last) log for a class", () => {
    const files = [
      "abc-com.example.App-2026-06-08T00-00-00-000Z-100.log",
      "abc-com.example.App-2026-06-09T00-00-00-000Z-150.log",
      "abc-com.example.Other-2026-06-10T00-00-00-000Z-1.log",
    ];
    expect(pickNewestLog(files, "abc", "com.example.App")).toBe(
      "abc-com.example.App-2026-06-09T00-00-00-000Z-150.log"
    );
  });
  test("returns null when nothing matches", () => {
    expect(pickNewestLog([], "abc", "com.example.App")).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test:run test/services/logNaming.test.ts`
Expected: FAIL — cannot find module.

- [ ] **Step 3: Write the implementation**

`src/services/logNaming.ts`:
```ts
/** Make an ISO timestamp filename-safe (`:`/`.` → `-`). */
export const compactStamp = (iso: string): string => iso.replace(/[:.]/g, "-");

/** `<hash>-<mainClass>-<stampCompact>-<pid>.log` */
export const logFileName = (
  hash: string,
  mainClass: string,
  stampCompact: string,
  pid: number
): string => `${hash}-${mainClass}-${stampCompact}-${pid}.log`;

const prefixFor = (hash: string, mainClass: string): string => `${hash}-${mainClass}-`;

/** The log of a specific running instance: prefix match + `-<pid>.log` suffix.
 *  If multiple share a pid (reuse over time), the newest by name wins. */
export const pickRunningLog = (
  files: readonly string[],
  hash: string,
  mainClass: string,
  pid: number
): string | null => {
  const prefix = prefixFor(hash, mainClass);
  const suffix = `-${pid}.log`;
  const matches = files.filter((f) => f.startsWith(prefix) && f.endsWith(suffix)).sort();
  return matches.length > 0 ? matches[matches.length - 1]! : null;
};

/** The newest log for a class regardless of pid (used for exited runs). */
export const pickNewestLog = (
  files: readonly string[],
  hash: string,
  mainClass: string
): string | null => {
  const prefix = prefixFor(hash, mainClass);
  const matches = files.filter((f) => f.startsWith(prefix) && f.endsWith(".log")).sort();
  return matches.length > 0 ? matches[matches.length - 1]! : null;
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test:run test/services/logNaming.test.ts`
Expected: PASS (all cases).

- [ ] **Step 5: Commit**

```bash
git add src/services/logNaming.ts test/services/logNaming.test.ts
git commit -m "feat(logs): pure PID-encoded log filename builders/matchers"
```

---

## Task 5: Rewrite `ProcessManager` — types, `listRunning`, remove PID files

**Files:**
- Modify: `src/services/ProcessManager.ts`
- Modify: `test/services/ProcessManager.test.ts`

This task changes the service interface and `listRunning`; `run` and `kill` are updated in Tasks 6–8. To keep the build green between tasks, this task keeps `run`'s current detached/foreground bodies but stops writing/reading PID files for liveness, switching `listRunning` to the probe.

- [ ] **Step 1: Update the `ProcessRecord` type and service interface**

In `src/services/ProcessManager.ts`:

Replace the `ProcessRecord` interface (lines ~18-31) with:
```ts
export interface ProcessRecord {
  readonly pid: number;
  readonly mainClass: string;
  readonly startedAt: string | null;
  readonly logFile: string | null;
  readonly args: readonly string[];
  readonly debugPort: number | null;
}
```
(`detached` is removed.)

Replace the `kill`/`killByPid` lines in the `ProcessManager` interface (lines ~44-45) with:
```ts
  readonly killByPid: (pid: number) => Effect.Effect<void, PlatformError>;
```
(Remove the `kill(className)` method and the `ProcessNotFound` import/class usage from the interface; delete the `ProcessNotFound` class declaration at lines ~14-16 — class addressing now lives in the CLI, Task 10.)

Remove the `PidDir` tag declaration (line ~60) and its import sites.

- [ ] **Step 2: Add new imports and discovery wiring**

At the top of `src/services/ProcessManager.ts`, add:
```ts
import { ProcessProbeService } from "./ProcessProbe.js";
import { matchProcess } from "./discovery.js";
import { compactStamp, logFileName, pickNewestLog, pickRunningLog } from "./logNaming.js";
```

In the `Layer.effect` body, replace `const pidDir = yield* PidDir;` with:
```ts
const probe = yield* ProcessProbeService;
```
Delete `yield* fs.makeDirectory(pidDir, ...)`. Keep the `logDir` creation.

- [ ] **Step 3: Replace `listRunning` with probe-driven discovery**

Delete `parseRecord` (lines ~108-142), `writeRecord` (lines ~166-172), `pidFile` (line ~164), and the old `listRunning` (lines ~272-304). Add:
```ts
const deriveLogFile = (mainClass: string, pid: number) =>
  Effect.gen(function* () {
    const exists = yield* fs.exists(logDir);
    if (!exists) return null;
    const entries = yield* fs.readDirectory(logDir);
    const name = pickRunningLog(entries, hash, mainClass, pid);
    return name ? pathSvc.join(logDir, name) : null;
  });

const listRunning = Effect.gen(function* () {
  const knownClasses = new Set(yield* project.findMainClasses);
  const snaps = yield* probe.listJava;
  const records: ProcessRecord[] = [];
  for (const snap of snaps) {
    const d = matchProcess(snap, { projectRoot: root, knownClasses });
    if (!d) continue;
    const logFile = yield* deriveLogFile(d.mainClass, d.pid);
    records.push({
      pid: d.pid,
      mainClass: d.mainClass,
      startedAt: d.startedAt,
      logFile,
      args: d.args,
      debugPort: d.debugPort,
    });
  }
  return records;
}).pipe(Effect.catchAll(() => Effect.succeed<ProcessRecord[]>([])));
```
(`findMainClasses` can fail if `rg` is missing; discovery degrades to empty rather than throwing in the TUI/status. The `hash` const and `pathSvc` are already in scope.)

- [ ] **Step 4: Update the service return + strip PID-file writes from `run` so the build stays green**

In the returned object (line ~393), change `{ run, listRunning, kill, killByPid, readLog }` to `{ run, listRunning, killByPid, readLog }`.

Keep the old `killByPid = (pid, group = false) =>` impl as-is for now — a 2-arg impl still satisfies the new 1-arg interface type, and Task 7 rewrites it. Delete the old `kill = (className) => …` block (lines ~342-361) entirely, and delete the now-unused `ProcessNotFound` references.

In `run`, remove **every** reference to the deleted PID-file helpers so it compiles:
- Detached branch: delete the `yield* writeRecord(record);` line (the record is just `return`ed). Remove the `detached: true` property from the returned record object.
- Foreground branch: delete the `yield* writeRecord(record);` line and remove the `detached: false` property. In the `proc.exitCode.pipe(...)` chain, delete the `Effect.ensuring(fs.remove(pidFile(config.mainClass)).pipe(Effect.ignore))` line — there is no PID file to reap. Keep the non-zero-exit-code failure mapping.

(Task 6 reworks the detached log naming; the current timestamp-based `logFile` stays valid until then.)

- [ ] **Step 5: Update `makeTestLayer` and rewrite the listRunning tests**

In `test/services/ProcessManager.test.ts`, replace the `PidDir` import and `makeTestLayer` with a probe-stub helper. Replace lines 1-38 with:
```ts
import { FileSystem } from "@effect/platform";
import { NodeContext } from "@effect/platform-node";
import { it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { describe, expect, test } from "vitest";
import {
  JavaProjectService,
  ProjectRoot,
} from "../../src/services/JavaProject.js";
import {
  JavaBin,
  LogDir,
  ProcessManagerLive,
  ProcessManagerService,
  buildJavaArgs,
  debugJvmArg,
} from "../../src/services/ProcessManager.js";
import {
  type ProcessSnapshot,
  ProcessProbeService,
} from "../../src/services/ProcessProbe.js";

const stubProbe = (snaps: ProcessSnapshot[]) =>
  Layer.succeed(ProcessProbeService, {
    listJava: Effect.succeed(snaps),
    inspect: (pid: number) =>
      Effect.succeed(snaps.find((s) => s.pid === pid) ?? null),
  });

const stubProject = (classes: string[]) =>
  Layer.succeed(JavaProjectService, {
    findMainClasses: Effect.succeed(classes),
    resolveClasspath: () => Effect.succeed("target/classes"),
  });

const makeLayer = (root: string, logDir: string, probe: Layer.Layer<ProcessProbeService>, classes: string[]) =>
  ProcessManagerLive.pipe(
    Layer.provide(stubProject(classes)),
    Layer.provide(Layer.succeed(ProjectRoot, root)),
    Layer.provide(Layer.succeed(LogDir, logDir)),
    Layer.provide(probe),
    Layer.provide(NodeContext.layer)
  );
```

Replace ALL the old PID-file `listRunning` tests (the `describe` cases that write `*.pid` files: "run spawns…", "cleans up stale…", "returns running…", "ignores PIDs from other projects", "legacy raw-integer", "does NOT remove malformed") with these discovery tests:
```ts
describe("ProcessManager.listRunning (discovery)", () => {
  const snap = (pid: number, cwd: string, argv: string[]): ProcessSnapshot => ({
    pid,
    pgid: pid,
    cwd,
    argv,
    startedAt: "2026-06-10T00:00:00.000Z",
  });

  it.effect("discovers multiple instances of the same class", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectory();
      const logDir = yield* fs.makeTempDirectory();
      const probe = stubProbe([
        snap(101, root, ["java", "-cp", "x", "com.example.ApiServer"]),
        snap(102, root, ["java", "-cp", "x", "com.example.ApiServer"]),
      ]);
      const running = yield* ProcessManagerService.pipe(
        Effect.flatMap((pm) => pm.listRunning),
        Effect.provide(makeLayer(root, logDir, probe, ["com.example.ApiServer"]))
      );
      expect(running.map((r) => r.pid).sort()).toEqual([101, 102]);
      expect(running.every((r) => r.mainClass === "com.example.ApiServer")).toBe(true);
    }).pipe(Effect.provide(NodeContext.layer))
  );

  it.effect("excludes processes whose cwd is not the project root", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectory();
      const logDir = yield* fs.makeTempDirectory();
      const probe = stubProbe([
        snap(201, "/somewhere/else", ["java", "-cp", "x", "com.example.ApiServer"]),
      ]);
      const running = yield* ProcessManagerService.pipe(
        Effect.flatMap((pm) => pm.listRunning),
        Effect.provide(makeLayer(root, logDir, probe, ["com.example.ApiServer"]))
      );
      expect(running).toEqual([]);
    }).pipe(Effect.provide(NodeContext.layer))
  );

  it.effect("derives the log file for a running instance by class+pid", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectory();
      const logDir = yield* fs.makeTempDirectory();
      const hash = require("node:crypto").createHash("md5").update(root).digest("hex");
      yield* fs.writeFileString(
        `${logDir}/${hash}-com.example.ApiServer-2026-06-10T00-00-00-000Z-303.log`,
        "log"
      );
      const probe = stubProbe([snap(303, root, ["java", "-cp", "x", "com.example.ApiServer"])]);
      const running = yield* ProcessManagerService.pipe(
        Effect.flatMap((pm) => pm.listRunning),
        Effect.provide(makeLayer(root, logDir, probe, ["com.example.ApiServer"]))
      );
      expect(running[0]!.logFile).toContain("-303.log");
    }).pipe(Effect.provide(NodeContext.layer))
  );
});
```

- [ ] **Step 6: Run the ProcessManager tests (listRunning + buildJavaArgs still pass)**

Run: `pnpm test:run test/services/ProcessManager.test.ts`
Expected: the discovery `listRunning` tests and the `buildJavaArgs`/`debugJvmArg` tests PASS. The `it.live` run/kill tests will be rewritten in Tasks 6-7 — if they fail to compile now, comment them out with a `// TODO(Task 6/7)` marker and a note in the commit; they are restored in those tasks.

- [ ] **Step 7: Commit**

```bash
git add src/services/ProcessManager.ts test/services/ProcessManager.test.ts
git commit -m "feat(pm): listRunning via OS discovery; drop PID-file registry and detached field"
```

---

## Task 6: `run` — temp-then-rename PID-encoded logs

**Files:**
- Modify: `src/services/ProcessManager.ts` (the `run` detached path)
- Modify: `test/services/ProcessManager.test.ts` (restore the detached-run test)

- [ ] **Step 1: Rewrite the detached branch of `run`**

In `src/services/ProcessManager.ts`, replace the detached block inside `run` (the `if (options.detached) { … }` section, ~lines 195-235) with:
```ts
if (options.detached) {
  const stampCompact = compactStamp(startedAt);
  const tmpLog = pathSvc.join(logDir, `${hash}-${config.mainClass}-${stampCompact}.tmp`);
  const record: ProcessRecord = yield* Effect.try({
    try: () => {
      const fd = nodeFs.openSync(tmpLog, "a");
      let child: childProcess.ChildProcess;
      try {
        child = childProcess.spawn(javaBin, args, {
          detached: true,
          stdio: ["ignore", fd, fd],
          cwd: root,
        });
      } finally {
        nodeFs.closeSync(fd);
      }
      child.unref();
      if (child.pid === undefined) {
        throw new Error("failed to spawn detached process (no pid)");
      }
      // Rename the temp log to its final PID-encoded name. The child's open fd
      // follows the inode through the rename, so output keeps flowing.
      const finalName = logFileName(hash, config.mainClass, stampCompact, child.pid);
      const finalLog = pathSvc.join(logDir, finalName);
      nodeFs.renameSync(tmpLog, finalLog);
      return {
        pid: child.pid,
        mainClass: config.mainClass,
        startedAt,
        logFile: finalLog,
        args: [...config.programArgs],
        debugPort: debug ? debug.port : null,
      };
    },
    catch: (e) => new JavaProcessError({ message: `Failed to start detached: ${String(e)}` }),
  });
  return record;
}
```
(Note: there is no `writeRecord` call — Task 5 already removed it. The foreground branch is unchanged from Task 5: it inherits stdio and its record has `logFile: null` and no `detached` field.)

- [ ] **Step 2: Restore/replace the detached-run test**

Replace the `it.live("detached run writes a record with a log file…")` test body's layer construction to use the new stubs and assert the PID-encoded name. Use:
```ts
it.live("detached run writes a PID-encoded log and redirects output", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const tmpDir = yield* fs.makeTempDirectory();
    const logDir = yield* fs.makeTempDirectory();
    const fakeJava = `${tmpDir}/fake-java`;
    yield* fs.writeFileString(fakeJava, `#!/bin/bash\necho "HELLO_FROM_FAKE_JAVA"\nsleep 2\n`);
    yield* Effect.sync(() => require("node:fs").chmodSync(fakeJava, 0o755));

    const layer = ProcessManagerLive.pipe(
      Layer.provide(stubProject([])),
      Layer.provide(Layer.succeed(ProjectRoot, tmpDir)),
      Layer.provide(Layer.succeed(LogDir, logDir)),
      Layer.provide(Layer.succeed(JavaBin, fakeJava)),
      Layer.provide(stubProbe([])),
      Layer.provide(NodeContext.layer)
    );

    const record = yield* ProcessManagerService.pipe(
      Effect.flatMap((pm) =>
        pm.run({ mainClass: "com.example.App", programArgs: [], jvmOpts: [] }, { detached: true, debug: null })
      ),
      Effect.provide(layer)
    );

    expect(record.mainClass).toBe("com.example.App");
    expect(record.logFile).toContain(`-${record.pid}.log`);

    yield* Effect.sleep("300 millis");
    const log = yield* fs.readFileString(record.logFile!);
    expect(log).toContain("HELLO_FROM_FAKE_JAVA");

    yield* ProcessManagerService.pipe(
      Effect.flatMap((pm) => pm.killByPid(record.pid)),
      Effect.provide(layer)
    );
  }).pipe(Effect.provide(NodeContext.layer))
);
```

- [ ] **Step 3: Run the test**

Run: `pnpm test:run test/services/ProcessManager.test.ts -t "detached run"`
Expected: PASS — `logFile` ends with `-<pid>.log` and contains the echoed output.

- [ ] **Step 4: Commit**

```bash
git add src/services/ProcessManager.ts test/services/ProcessManager.test.ts
git commit -m "feat(pm): PID-encoded detached logs via temp-then-rename"
```

---

## Task 7: `killByPid` — observed-pgid group signalling

**Files:**
- Modify: `src/services/ProcessManager.ts` (`killByPid`, `sendSignal`)
- Modify: `test/services/ProcessManager.test.ts` (replace the kill-by-class test with kill-by-pid)

- [ ] **Step 1: Rewrite `killByPid` to observe pgid via the probe**

Replace `sendSignal` (lines ~315-328) and `killByPid` (lines ~330-340) with:
```ts
const sendSignal = (pid: number, signal: NodeJS.Signals, group: boolean) => {
  try {
    process.kill(group ? -pid : pid, signal);
  } catch (e) {
    if (group && (e as NodeJS.ErrnoException).code === "ESRCH") {
      try {
        process.kill(pid, signal);
      } catch {
        /* already dead */
      }
    }
    /* otherwise already dead */
  }
};

const killByPid = (pid: number) =>
  Effect.gen(function* () {
    const snap = yield* probe.inspect(pid);
    // Group-signal only when the PID is its own group leader (everything jrun
    // spawns detached). A foreground JVM living in jrun's group must NOT have
    // its whole group signalled.
    const group = snap !== null && snap.pgid === pid;
    yield* Effect.sync(() => sendSignal(pid, "SIGTERM", group));
    yield* Effect.sleep("2 seconds");
    yield* Effect.sync(() => {
      if (isProcessRunning(pid)) sendSignal(pid, "SIGKILL", group);
    });
  });
```

- [ ] **Step 2: Replace the kill round-trip test with a kill-by-pid version**

Replace the `it.live("kill(className) terminates…")` test with:
```ts
it.live("killByPid terminates a detached process group", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const tmpDir = yield* fs.makeTempDirectory();
    const logDir = yield* fs.makeTempDirectory();
    const fakeJava = `${tmpDir}/fake-java`;
    yield* fs.writeFileString(fakeJava, `#!/bin/bash\nsleep 30\n`);
    yield* Effect.sync(() => require("node:fs").chmodSync(fakeJava, 0o755));

    const layer = ProcessManagerLive.pipe(
      Layer.provide(stubProject([])),
      Layer.provide(Layer.succeed(ProjectRoot, tmpDir)),
      Layer.provide(Layer.succeed(LogDir, logDir)),
      Layer.provide(Layer.succeed(JavaBin, fakeJava)),
      // Real probe so killByPid observes the spawned process's true pgid.
      Layer.provide(ProcessProbeLive),
      Layer.provide(NodeContext.layer)
    );

    const record = yield* ProcessManagerService.pipe(
      Effect.flatMap((pm) =>
        pm.run({ mainClass: "com.example.Killable", programArgs: [], jvmOpts: [] }, { detached: true, debug: null })
      ),
      Effect.provide(layer)
    );

    const aliveBefore = yield* Effect.sync(() => {
      try { process.kill(record.pid, 0); return true; } catch { return false; }
    });
    expect(aliveBefore).toBe(true);

    yield* ProcessManagerService.pipe(
      Effect.flatMap((pm) => pm.killByPid(record.pid)),
      Effect.provide(layer)
    );

    let aliveAfter = true;
    for (let i = 0; i < 20 && aliveAfter; i++) {
      aliveAfter = yield* Effect.sync(() => {
        try { process.kill(record.pid, 0); return true; } catch { return false; }
      });
      if (aliveAfter) yield* Effect.sleep("100 millis");
    }
    expect(aliveAfter).toBe(false);
  }).pipe(Effect.provide(NodeContext.layer))
);
```
Add `ProcessProbeLive` to the `ProcessProbe` import line in the test. Remove the `kill returns ProcessNotFound for unknown class` test (class addressing no longer lives in the service).

- [ ] **Step 3: Run the tests**

Run: `pnpm test:run test/services/ProcessManager.test.ts`
Expected: all PASS, including the live kill test.

- [ ] **Step 4: Commit**

```bash
git add src/services/ProcessManager.ts test/services/ProcessManager.test.ts
git commit -m "feat(pm): kill by PID with observed-pgid group signalling"
```

---

## Task 8: `readLog` (newest by class) + `readLogByPid`

**Files:**
- Modify: `src/services/ProcessManager.ts` (`readLog`, add `readLogByPid`, interface)
- Modify: `test/services/ProcessManager.test.ts` (update readLog test for new filename)

- [ ] **Step 1: Update the interface**

In the `ProcessManager` interface add:
```ts
  readonly readLogByPid: (
    mainClass: string,
    pid: number
  ) => Effect.Effect<string | null, PlatformError>;
```

- [ ] **Step 2: Rewrite `readLog` and add `readLogByPid`**

Replace the `readLog` body (lines ~363-391) with:
```ts
const readFileOrNull = (file: string) =>
  fs.readFileString(file).pipe(Effect.catchAll(() => Effect.succeed<string | null>(null)));

const readLog = (mainClass: string) =>
  Effect.gen(function* () {
    const exists = yield* fs.exists(logDir);
    if (!exists) return null;
    const entries = yield* fs.readDirectory(logDir);
    const name = pickNewestLog(entries, hash, mainClass);
    return name ? yield* readFileOrNull(pathSvc.join(logDir, name)) : null;
  });

const readLogByPid = (mainClass: string, pid: number) =>
  Effect.gen(function* () {
    const exists = yield* fs.exists(logDir);
    if (!exists) return null;
    const entries = yield* fs.readDirectory(logDir);
    const name = pickRunningLog(entries, hash, mainClass, pid);
    return name ? yield* readFileOrNull(pathSvc.join(logDir, name)) : null;
  });
```
Add `readLogByPid` to the returned object: `{ run, listRunning, killByPid, readLog, readLogByPid }`.

- [ ] **Step 3: Update the readLog test for the new filename**

In the `readLog returns the newest log for an exited class` test, change the two written log filenames to include a PID segment:
```ts
yield* fs.writeFileString(`${pidDir}/${hash}-${cls}-2026-06-08T00-00-00-000Z-1.log`, "OLD RUN\n");
yield* fs.writeFileString(`${pidDir}/${hash}-${cls}-2026-06-09T00-00-00-000Z-2.log`, "NEW RUN — Done.\n");
```
(Adjust the test's layer to `makeLayer(root, logDir, stubProbe([]), [])` and write logs into `logDir`, since `makeTestLayer` is gone.)

- [ ] **Step 4: Run the tests**

Run: `pnpm test:run test/services/ProcessManager.test.ts`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add src/services/ProcessManager.ts test/services/ProcessManager.test.ts
git commit -m "feat(pm): readLog by newest-per-class and by class+pid"
```

---

## Task 9: `JrunApi` — `kill(pid)` and `readLogByPid`

**Files:**
- Modify: `src/api/JrunApi.ts`
- Modify: `test/api/JrunApi.test.ts`

- [ ] **Step 1: Update the interface and implementation**

In `src/api/JrunApi.ts`:
- Change the interface method `kill(mainClass: string): Promise<void>;` to `kill(pid: number): Promise<void>;`
- Add `readLogByPid(mainClass: string, pid: number): Promise<string | null>;`
- Remove the now-stale `detached` references in the `start` doc comment (keep `detached: spec.detached ?? true` in the call — `RunOptions` still has it).

Replace the `kill` implementation (lines ~156-162) with:
```ts
kill: (pid) =>
  run(
    Effect.gen(function* () {
      const s = yield* ProcessManagerService;
      yield* s.killByPid(pid);
    })
  ),
readLogByPid: (mainClass, pid) =>
  run(
    Effect.gen(function* () {
      const pm = yield* ProcessManagerService;
      return yield* pm.readLogByPid(mainClass, pid);
    })
  ),
```

- [ ] **Step 2: Update `test/api/JrunApi.test.ts`**

Remove the `PidDir` import and layer wiring (mirror Task 5's `makeLayer`: provide `LogDir`, `ProjectRoot`, a `stubProbe`, and the real or stub `JavaProject`). Update any `api.kill("com.example.X")` call to `api.kill(<pid>)`. If a test asserted `ProcessNotFound`-style behavior through `kill`, replace it with: starting a fake process, then `api.kill(rec.pid)` resolves without throwing.

- [ ] **Step 3: Run the API tests + typecheck**

Run: `pnpm test:run test/api/JrunApi.test.ts && pnpm typecheck`
Expected: PASS / clean.

- [ ] **Step 4: Commit**

```bash
git add src/api/JrunApi.ts test/api/JrunApi.test.ts
git commit -m "feat(api): kill by PID, add readLogByPid"
```

---

## Task 10: CLI `kill` — PID or class with ambiguity handling

**Files:**
- Create: `src/commands/killResolve.ts` (pure resolver)
- Create: `test/commands/killResolve.test.ts`
- Modify: `src/commands/kill.ts`

- [ ] **Step 1: Write the failing resolver test**

`test/commands/killResolve.test.ts`:
```ts
import { describe, expect, test } from "vitest";
import { resolveKillTarget } from "../../src/commands/killResolve.js";
import type { ProcessRecord } from "../../src/services/ProcessManager.js";

const rec = (pid: number, mainClass: string): ProcessRecord => ({
  pid, mainClass, startedAt: null, logFile: null, args: [], debugPort: null,
});

describe("resolveKillTarget", () => {
  const running = [rec(101, "com.example.ApiServer"), rec(102, "com.example.ApiServer"), rec(200, "com.example.HelloWorld")];

  test("a numeric arg resolves to that PID", () => {
    expect(resolveKillTarget("101", running)).toEqual({ kind: "pid", pid: 101 });
  });
  test("a numeric arg for an untracked PID still resolves (best-effort kill)", () => {
    expect(resolveKillTarget("999", running)).toEqual({ kind: "pid", pid: 999 });
  });
  test("a class with one instance resolves to its PID", () => {
    expect(resolveKillTarget("com.example.HelloWorld", running)).toEqual({ kind: "pid", pid: 200 });
  });
  test("a class with multiple instances is ambiguous", () => {
    const r = resolveKillTarget("com.example.ApiServer", running);
    expect(r.kind).toBe("ambiguous");
    if (r.kind === "ambiguous") expect(r.instances.map((i) => i.pid)).toEqual([101, 102]);
  });
  test("an unknown class is not found", () => {
    expect(resolveKillTarget("com.example.Nope", running)).toEqual({ kind: "notfound" });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test:run test/commands/killResolve.test.ts`
Expected: FAIL — cannot find module.

- [ ] **Step 3: Write the resolver**

`src/commands/killResolve.ts`:
```ts
import type { ProcessRecord } from "../services/ProcessManager.js";

export type KillTarget =
  | { kind: "pid"; pid: number }
  | { kind: "ambiguous"; instances: ProcessRecord[] }
  | { kind: "notfound" };

/** Resolve a `kill` argument (a PID string or a class name) against the
 *  currently-running set. A numeric arg is always treated as a PID. */
export const resolveKillTarget = (arg: string, running: readonly ProcessRecord[]): KillTarget => {
  if (/^\d+$/.test(arg)) return { kind: "pid", pid: Number(arg) };
  const matches = running.filter((r) => r.mainClass === arg);
  if (matches.length === 0) return { kind: "notfound" };
  if (matches.length === 1) return { kind: "pid", pid: matches[0]!.pid };
  return { kind: "ambiguous", instances: [...matches] };
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test:run test/commands/killResolve.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Rewrite `src/commands/kill.ts` to use the resolver**

Replace the whole command body with logic that: lists running; if an arg is given, `resolveKillTarget`; act on the result. Full file:
```ts
import { Args, Command, Options } from "@effect/cli";
import { Console, Effect, Option } from "effect";
import { ProcessManagerService } from "../services/ProcessManager.js";
import { TerminalService } from "../services/Terminal.js";
import { resolveKillTarget } from "./killResolve.js";

const classArg = Args.text({ name: "class-or-pid" }).pipe(Args.optional);
const jsonOption = Options.boolean("json").pipe(
  Options.withDescription("Emit machine-readable JSON output")
);

export const kill = Command.make(
  "kill",
  { target: classArg, json: jsonOption },
  ({ target, json }) =>
    Effect.gen(function* () {
      const pm = yield* ProcessManagerService;
      const terminal = yield* TerminalService;
      const running = yield* pm.listRunning;

      if (Option.isSome(target)) {
        const resolved = resolveKillTarget(target.value, running);
        if (resolved.kind === "notfound") {
          if (json) {
            yield* Console.log(JSON.stringify({ ok: false, error: `No tracked process for ${target.value}` }));
          } else {
            yield* Console.error(`No tracked process for ${target.value}`);
          }
          yield* Effect.sync(() => { process.exitCode = 1; });
          return;
        }
        if (resolved.kind === "ambiguous") {
          if (json) {
            yield* Console.log(JSON.stringify({
              ok: false,
              error: "ambiguous",
              instances: resolved.instances.map((r) => ({ pid: r.pid, startedAt: r.startedAt })),
            }));
            yield* Effect.sync(() => { process.exitCode = 1; });
            return;
          }
          const chosen = yield* terminal.select({
            message: `Multiple ${target.value} running — which PID?`,
            choices: resolved.instances.map((r) => ({
              value: String(r.pid),
              label: `PID ${r.pid} (started ${r.startedAt ?? "?"})`,
            })),
          }).pipe(Effect.catchTag("UserCancelled", () => Effect.succeed(null)));
          if (chosen === null) return;
          yield* pm.killByPid(Number(chosen));
          yield* Console.log(`Stopped PID ${chosen}.`);
          return;
        }
        yield* pm.killByPid(resolved.pid);
        if (json) {
          yield* Console.log(JSON.stringify({ ok: true, pid: resolved.pid }));
        } else {
          yield* Console.log(`Stopped PID ${resolved.pid}.`);
        }
        return;
      }

      // No arg: existing behavior — 0/1/many.
      if (running.length === 0) {
        if (json) {
          yield* Console.log(JSON.stringify({ ok: false, error: "no tracked processes running" }));
          yield* Effect.sync(() => { process.exitCode = 1; });
        } else {
          yield* Console.log("No tracked processes running");
        }
        return;
      }
      if (running.length === 1) {
        const proc = running[0]!;
        yield* pm.killByPid(proc.pid);
        if (json) {
          yield* Console.log(JSON.stringify({ ok: true, pid: proc.pid }));
        } else {
          yield* Console.log(`Stopped ${proc.mainClass} (PID ${proc.pid}).`);
        }
        return;
      }
      if (json) {
        yield* Console.log(JSON.stringify({ ok: false, error: "ambiguous: specify a class or pid" }));
        yield* Effect.sync(() => { process.exitCode = 1; });
        return;
      }
      const selected = yield* terminal.select({
        message: "Which process to kill?",
        choices: running.map((p) => ({ value: String(p.pid), label: `${p.mainClass} (PID ${p.pid})` })),
      }).pipe(Effect.catchTag("UserCancelled", () => Effect.succeed(null)));
      if (selected === null) return;
      yield* pm.killByPid(Number(selected));
      yield* Console.log(`Stopped PID ${selected}.`);
    })
).pipe(Command.withDescription("Stop a running process (by class name or PID)"));
```

- [ ] **Step 6: Run tests + typecheck**

Run: `pnpm test:run test/commands/killResolve.test.ts && pnpm typecheck`
Expected: PASS / clean.

- [ ] **Step 7: Commit**

```bash
git add src/commands/killResolve.ts test/commands/killResolve.test.ts src/commands/kill.ts
git commit -m "feat(cli): kill by class or PID with ambiguity handling"
```

---

## Task 11: CLI `logs` — accept PID or class

**Files:**
- Modify: `src/commands/logs.ts`

- [ ] **Step 1: Accept a numeric arg as a PID**

In `src/commands/logs.ts`, after `const pm = yield* ProcessManagerService;`, branch on whether `cls` is numeric. Replace the non-follow tail (`const content = yield* pm.readLog(cls); …`) with:
```ts
const asPid = /^\d+$/.test(cls) ? Number(cls) : null;
if (asPid !== null) {
  const running = yield* pm.listRunning;
  const rec = running.find((r) => r.pid === asPid);
  const content = rec ? yield* pm.readLogByPid(rec.mainClass, asPid) : null;
  if (content === null) {
    yield* Console.error(`No log found for PID ${asPid}`);
    yield* Effect.sync(() => { process.exitCode = 1; });
    return;
  }
  yield* Console.log(content);
  return;
}
const content = yield* pm.readLog(cls);
if (content === null) {
  yield* Console.error(`No log found for ${cls} (has it been run detached?)`);
  yield* Effect.sync(() => { process.exitCode = 1; });
  return;
}
yield* Console.log(content);
```
For the `--follow` branch, change `running.find((r) => r.mainClass === cls)` to also accept a PID: `running.find((r) => (asPid !== null ? r.pid === asPid : r.mainClass === cls))` (compute `asPid` at the top of the handler so both branches see it).

- [ ] **Step 2: Verify build + typecheck**

Run: `pnpm typecheck && pnpm build`
Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add src/commands/logs.ts
git commit -m "feat(cli): logs accepts a PID or a class name"
```

---

## Task 12: TUI — kill by PID; drop `detached` from fixtures

**Files:**
- Modify: `src/tui/dashboard/Dashboard.tsx` (the `running` kill action)
- Modify: `test/tui/dashboard/Dashboard.test.tsx`, `test/tui/dashboard/navigation.test.ts`

- [ ] **Step 1: Kill by `rec.pid` in the dashboard**

In `src/tui/dashboard/Dashboard.tsx`, in the `running` case's `kill` action (lines ~205-213), change:
```ts
run: () => api.kill(rec.mainClass),
```
to:
```ts
run: () => api.kill(rec.pid),
```
The confirm prompt `target`/`done` text may stay as `rec.mainClass` for readability, or become `${rec.mainClass} (PID ${rec.pid})`.

- [ ] **Step 2: Drop `detached` from TUI test fixtures**

In `test/tui/dashboard/Dashboard.test.tsx` and `test/tui/dashboard/navigation.test.ts`, remove every `detached: true`/`detached: false` line from the `ProcessRecord` fixtures (the type no longer has the field). If `Dashboard.test.tsx` stubs `api.kill`, update the assertion to expect it called with a numeric pid.

- [ ] **Step 3: Run the TUI tests + typecheck**

Run: `pnpm test:run test/tui && pnpm typecheck`
Expected: PASS / clean.

- [ ] **Step 4: Commit**

```bash
git add src/tui/dashboard/Dashboard.tsx test/tui/dashboard/Dashboard.test.tsx test/tui/dashboard/navigation.test.ts
git commit -m "feat(tui): kill the selected row by PID"
```

---

## Task 13: Wire `main.ts` — provide probe, remove `PidDir`

**Files:**
- Modify: `src/main.ts`

- [ ] **Step 1: Update imports and layers**

In `src/main.ts`:
- Change `import { LogDir, PidDir, ProcessManagerLive } from "./services/ProcessManager.js";` to `import { LogDir, ProcessManagerLive } from "./services/ProcessManager.js";`
- Add `import { ProcessProbeLive } from "./services/ProcessProbe.js";`
- Delete `const PidDirLayer = Layer.succeed(PidDir, path.join(jrunHome, "pids"));`
- In `ProcessManagerLayer`, remove `Layer.provide(PidDirLayer)` and add `Layer.provide(ProcessProbeLive)`:
```ts
const ProcessManagerLayer = ProcessManagerLive.pipe(
  Layer.provide(JavaProjectLayer),
  Layer.provide(ProjectRootLayer),
  Layer.provide(LogDirLayer),
  Layer.provide(ProcessProbeLive),
  Layer.provide(NodeContext.layer)
);
```

- [ ] **Step 2: Full build + typecheck + lint**

Run: `pnpm typecheck && pnpm build && pnpm lint`
Expected: all clean. Fix any Biome findings (e.g. unused imports).

- [ ] **Step 3: Commit**

```bash
git add src/main.ts
git commit -m "chore(main): provide ProcessProbe, remove PidDir wiring"
```

---

## Task 14: Integration test — the original bug as a regression test

**Files:**
- Modify: `test/integration/example-project.test.ts`

- [ ] **Step 1: Remove `PidDir` from the harness**

Change the import to drop `PidDir`; delete `const pidDir = …` and `const PidDirLayer = …`; remove `pidDir` from the `mkdirSync` loop and `Layer.provide(PidDirLayer)` from `processManagerLayer`; add `Layer.provide(ProcessProbeLive)` (import it from `../../src/services/ProcessProbe.js`). Update the `afterEach` cleanup to kill by PID:
```ts
afterEach(async () => {
  const running = await api.listRunning().catch(() => []);
  for (const r of running) await api.kill(r.pid).catch(() => {});
  started.splice(0);
});
```

- [ ] **Step 2: Fix the existing `detached: false` foreground assertion**

The `rec.detached` assertion (line ~171) no longer compiles. Replace that test's assertion `expect(rec.detached).toBe(false);` with `expect(rec.logFile).toBeNull();` (foreground runs have no log file).

- [ ] **Step 3: Add the regression test — two instances, kill one**

Add inside the `describe`:
```ts
it("tracks two instances of the same class and kills only one", async () => {
  const cls = "com.example.ApiServer";
  started.push(cls);
  const a = await api.start({ mainClass: cls, args: ["--port", "8097"], detached: true });
  const b = await api.start({ mainClass: cls, args: ["--port", "8098"], detached: true });
  expect(a.pid).not.toBe(b.pid);

  // Both appear as distinct rows.
  const bothUp = await pollUntil(async () => {
    const running = await api.listRunning();
    const pids = running.filter((r) => r.mainClass === cls).map((r) => r.pid);
    return pids.includes(a.pid) && pids.includes(b.pid);
  }, 30_000);
  expect(bothUp).toBe(true);

  // Kill only A.
  await api.kill(a.pid);

  // A disappears, B survives.
  const aGone = await pollUntil(async () => {
    const running = await api.listRunning();
    return !running.some((r) => r.pid === a.pid);
  }, 30_000);
  expect(aGone).toBe(true);

  const running = await api.listRunning();
  expect(running.some((r) => r.pid === b.pid)).toBe(true);
}, 90_000);
```

- [ ] **Step 4: Run the full suite**

Run: `pnpm test:run`
Expected: all PASS (integration block runs only if `mvn`/`java`/`rg` are present; otherwise skipped).

- [ ] **Step 5: Commit**

```bash
git add test/integration/example-project.test.ts
git commit -m "test(integration): regression — two same-class instances, kill one"
```

---

## Task 15: Docs + manual verification

**Files:**
- Modify: `CLAUDE.md` (Quick reference — `kill`/`logs` now accept a PID), `README` if present.

- [ ] **Step 1: Update CLAUDE.md quick reference**

In the `## Quick reference` list, update the `kill`/`logs` bullets to note PID addressing:
```
- `jrun logs <class|pid> [--follow]` — print/stream a detached run's log
- `jrun kill [<class|pid>]` — stop a process; with multiple instances of a class, pass a PID (or pick interactively)
```

- [ ] **Step 2: Rebuild, relink, manual smoke test against the example project**

Run:
```bash
pnpm build && pnpm link --global
cd example && mvn -q compile
jrun start com.example.ApiServer --detached --args "--port 8097"
jrun start com.example.ApiServer --detached --args "--port 8098"
jrun status            # expect TWO ApiServer rows with distinct PIDs
jrun kill <pid-of-one> # kill one by PID
jrun status            # expect the OTHER still listed
jrun kill <pid-of-other>
```
Expected: two rows; killing one leaves the other; final kill clears it. Confirm no `~/.jrun/pids/` directory is created.

- [ ] **Step 3: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: kill/logs accept a PID; discovery-based tracking"
```

---

## Self-Review Notes (completed)

- **Spec coverage:** discovery (T2/T3/T5), zero-state (T5 removes PID files), PID-primary identity (T9/T10/T11/T12), Both-match (T3), `/proc` metadata (T2), PID-encoded logs + temp-rename (T4/T6), observed-pgid kill (T7), non-Linux guard (T1), `~/.jrun/pids` removal (T5/T13/T14). All covered.
- **`detached` field removal** is threaded through every consumer found by grep: ProcessManager, JrunApi, start CLI (the `--detached` *flag* stays — that's `RunOptions`, not the record), and all test fixtures (T5/T9/T12/T14).
- **Type consistency:** `DiscoveredProcess` (T3) = `ProcessRecord` (T5) minus `logFile`; `killByPid(pid)` signature consistent across PM (T7), API (T9), CLI (T10), TUI (T12). `readLogByPid(mainClass, pid)` consistent PM→API→CLI.
- **Open detail resolved in-plan:** main-class extraction handles `-cp`/garbage-classpath/known-token (T3). Module mode (`-m`) is out of scope — jrun only emits `-cp` form; the positional fallback covers `-cp` exactly, and the known-token primary covers anything else jrun launched.
