# jrun Process Tracking → OS Discovery — Design Spec

**Date:** 2026-06-10
**Status:** Draft (awaiting review)

## Problem

jrun tracks running processes with a per-class PID file: `~/.jrun/pids/<projectHash>-<mainClass>.pid`.
Because the **main class is the identity**, this model breaks in practice:

1. **Same-class clobbering.** Running `ApiServer` twice overwrites the first record. Only the
   latest instance is tracked; the first becomes an invisible orphan.
2. **Desync with reality.** The file is the source of truth for liveness, so any gap between the
   file and the OS (crash between spawn and write, a process killed out-of-band, a stale file)
   leaves jrun's view wrong.
3. **Orphans are unobservable.** A real, live JVM that jrun started is invisible the moment its
   record is lost — exactly the state we found during testing: two live `com.example.ApiServer`
   processes with an empty `~/.jrun/pids/`.

The CLI compounds this by addressing processes **by class** (`kill <class>`, `logs <class>`),
which is inherently ambiguous once a class can have multiple instances.

## Solution Overview

Make the **OS process table the single source of truth**. jrun *discovers* its running
processes by scanning live processes and matching them to the current project, rather than
consulting a file it wrote earlier. There is **no PID registry and no state directory** —
desync becomes structurally impossible because there is nothing to desync.

Everything jrun needs about a running process is reconstructed from `/proc`, except the path to
its log file, which is made **derivable** by encoding the PID into the log filename.

### Platform scope

Discovery reads `/proc`, which is Linux-only. WSL reports `os.platform() === 'linux'` and is
fully supported. Native macOS (`darwin`) and Windows (`win32`) are **not** supported. A blanket
startup guard (see below) exits early with a clear message on any non-Linux platform.

## Decisions (locked)

| Decision | Choice |
|---|---|
| Liveness / discovery | OS process table is authoritative; **zero state files** |
| Identity | PID-primary; class name as a convenience shortcut |
| Ownership | **Self-identifying launch marker** — jrun injects `-Djrun.project=<projectHash>` at spawn; a process is ours iff its `/proc/<pid>/cmdline` carries that exact token. `rg`/known-class set is **not** load-bearing for ownership. |
| Metadata source | `/proc/<pid>/{cmdline,stat}` |
| Logs | Filename encodes `(class, startedAt, pid)`; path is derived, never stored |
| Kill | By PID; group-signal when the PID is its own group leader, **defaulting to group-signal when `/proc` can't be read** |
| Non-Linux | Blanket startup guard → exit non-zero with a clear message |
| `~/.jrun/pids/` | **Removed entirely** |

> **Revised 2026-06-10 after adversarial review.** The original design matched by `cwd == projectRoot` AND a recognized main-class token ("Both"). Review found this (a) **false-positives on foreign JVMs** — an IntelliJ/Gradle process launched with cwd=project-root and a `-cp` flag would be claimed and could be killed by `jrun kill`; and (b) made `rg` a load-bearing hard dependency of `status`/`kill`/`logs` that **crashes** them when `rg` is absent (`findMainClasses` raises an Effect *defect*, which `catchAll` does not catch). The **self-identifying marker** fixes both at the root: foreign JVMs never carry it, and ownership no longer needs `rg` or the known-class set at all. See *Revisions from Review* at the end.

## Architecture

### The launch marker

At spawn, jrun injects a system property into the JVM args:

```
-Djrun.project=<projectHash>
```

where `projectHash = md5(projectRoot)` (the same hash already used for log filenames). It is
placed at the front of the JVM args (before `-cp`), is inert to the application, and travels with
the process in `/proc/<pid>/cmdline`. It is the **single source of ownership truth**:

- A foreign JVM (IntelliJ, Gradle, a hand-run `java …`) never carries it → never claimed, never
  killed by jrun.
- Every jrun-launched process carries it → discoverable regardless of whether its main class is
  visible to `rg`, under `target/`, generated, or from a dependency jar. The orphan-invisibility
  class of bugs cannot occur.
- The marker embeds the project hash, so it is inherently project-scoped — no `cwd` check needed.

One-time caveat: processes started by a *pre-upgrade* jrun lack the marker and won't be
discovered after upgrade; they must be killed manually (a one-time migration cost).

**Assumptions & known limitations** (verified by adversarial review against a real JVM/`/proc`):

- **`javaBin` must `exec` the JVM, not `spawn` it.** `run` records `child.pid` for the log
  filename and `start --json`. This is correct only if `child.pid` *is* the marked JVM — true for
  `exec`-style launchers (`/usr/bin/java`, and the user's `mise` shim, both verified to keep the
  same pid with the marker intact in `cmdline`). A wrapper that *forks* the real JVM as a child
  would leave `child.pid` pointing at the wrapper; discovery (marker-based) still finds the real
  JVM at its own pid via `status`, but the `start`-returned pid/`logFile` would be off and
  `kill <that-pid>` would hit the ownership guard. Documented assumption, not mitigated.
- **Marker-only ownership has no `cwd` check** (the marker embeds the project hash, so it's
  project-scoped). On a *shared multi-user host* with world-readable `/proc`, user B working at the
  *identical* absolute project path computes the same marker and would see user A's marked JVMs in
  `status` (`kill` then EPERMs harmlessly). Single-user dev use — jrun's purpose — is unaffected.
- The marker is an argv token, not an env var, so app-forked child JVMs do **not** inherit it
  (correct — we don't want to claim them). The only exception is an app that deliberately
  relaunches itself by copying its own argv; rare and out of scope.

### Discovery: identifying "our" processes

- Enumerate `/proc/<pid>` for numeric PIDs. A java process is one whose `cmdline`'s argv[0]
  basename is `java` (or ends in `/java`).
- Read `/proc/<pid>/cmdline` and split on `\0` to recover the **true argv**. (Critical: `ps`
  output space-flattens a classpath that contains spaces — the garbage-classpath case we hit —
  whereas `/proc/cmdline` preserves each argv element exactly.)
- **Own it iff** `argv` contains the exact token `-Djrun.project=<thisProjectHash>`.

This needs **no `rg`, no known-class set, and no `ConfigStore`** — `status`/`kill`/`logs` no
longer depend on `rg` at all (a major robustness win over the original "Both" design).

### Main-class extraction (display only)

Because ownership is already established by the marker, the main class is read purely
**positionally** for display: locate `-cp` / `-classpath` / `--class-path` in argv and take the
token at `index + 2` (the classpath value is a single argv element even when it contains spaces,
thanks to the NUL-split, so this is exact for every jrun-launched process — jrun always emits
`… -cp <classpath> <mainClass> <args…>`). If no classpath flag is present, extraction yields
`null` and `matchProcess` records the class as `(unknown)` — it **never drops a marked process**
(that would reintroduce orphan-invisibility); the process stays visible in `status` and killable
by PID, only its display label degrades. jrun always emits `-cp`, so this can't occur for owned
processes. No intersection with a known-class set is required, so a missing/slow/failing `rg` can
never break discovery.

### Reconstructed metadata (the `ProcessRecord`)

All derived from `/proc`, no persisted state:

| Field | Source |
|---|---|
| `pid` | the `/proc/<pid>` entry |
| `mainClass` | extraction above |
| `startedAt` | process start time from `/proc/<pid>/stat` (btime + starttime/clk_tck), as ISO |
| `args` (programArgs) | argv tokens after the main class |
| `debugPort` | parse `-agentlib:jdwp=…address=*:<port>` (or `…address=<port>`) from argv |
| `pgid` | field 5 of `/proc/<pid>/stat` — needed for kill (see below) |

The `detached` field is **removed** — it was only ever a hint for kill, now replaced by an
observed `pgid == pid` check.

### Logs: derivable paths, never stored

Log filename becomes:

```
<projectHash>-<mainClass>-<startedAtCompact>-<pid>.log
```

The timestamp precedes the PID deliberately: it keeps `<hash>-<class>-*` filenames sorting
**by time**, so the finished-run lookup below still works by lexicographic sort.

- **Running process:** discovery yields `(class, pid)`; glob `logs/<hash>-<class>-*-<pid>.log`
  (the `*` absorbs the timestamp, the trailing `-<pid>.log` anchors the instance) for the exact
  file. No lookup table.
- **Finished process:** `jrun logs <class>` globs `logs/<hash>-<class>-*.log` and takes the
  newest by name (ISO timestamps sort lexicographically, and now sort *before* the PID segment)
  — preserving today's read-a-finished-batch-job behavior.
- **Multiple instances:** distinct PIDs → distinct files, no collision.
- **PID reuse:** the `startedAt` segment guarantees a fresh filename per run, so a reused PID
  never overwrites an earlier run's log.
- **Cross-project:** the `<hash>` prefix isolates projects.

**Spawn-time ordering (the chicken-and-egg).** The log fd must be opened *before* `spawn`, but
the PID is only known *after*. Resolution:

1. Open a temp log file: `logs/<hash>-<class>-<startedAtCompact>.tmp`.
2. `spawn` with that fd as stdout/stderr; read `child.pid`.
3. `rename` the temp to the final `…-<startedAtCompact>-<pid>.log`. On Linux the child's open fd
   follows the inode through the rename, so output is seamless and nothing is lost.

**The rename must be best-effort — never fail `run` after the JVM is live.** Once `spawn`
returns a `child.pid`, a real process exists. If step 3's `rename` throws, jrun must **not**
fail `run` and report "Failed to start" while a JVM keeps running (the user would retry and get a
*second* instance). Instead: attempt the rename; on failure, keep the `.tmp` path and return a
successful record (with `logFile` pointing at whatever path exists). The process is still fully
discoverable via the marker; only its log *link* may be missing. The `Effect.try` therefore wraps
only the pre-`spawn` setup and the `spawn` itself — the rename is a best-effort step whose failure
is swallowed.

### Identity & CLI surface

PID-primary, class as a convenience shortcut:

- `jrun kill <pid>` / `jrun logs <pid>` — always unambiguous.
- `jrun kill <class>` / `jrun logs <class>` — resolve when the class has **exactly one** running
  instance. With multiple:
  - **interactive:** present a picker (PID + startedAt) — reuse the existing `terminal.select`.
  - **`--json`:** `{ ok: false, error: "ambiguous", instances: [{ pid, startedAt }, …] }`,
    exit non-zero.
  - **non-json non-interactive:** print the instances and exit non-zero.
- **PID-kill ownership guard.** `jrun kill <pid>` only signals a PID that discovery currently
  owns (a jrun-marked process). A PID that jrun did not launch is refused unless `--force` is
  passed — so `jrun kill 1234` can never SIGKILL an arbitrary unrelated process.
- `jrun logs <pid>` resolves the log even for an **exited** PID via a class-agnostic glob
  (`<hash>-*-<pid>.log`), since a finished process is no longer in the scan to supply its class.
- `status` / `status --json` list every discovered instance, each with its PID (already the
  shape — just no longer deduped by class).
- The **TUI is unaffected for kill** (a selected row is a specific PID); **and its log view must
  also address by PID** — selecting one of two same-class rows calls `readLogByPid(class, pid)`,
  not the newest-by-class lookup, so it shows *that* instance's log.

### Kill

Signal by PID, escalating SIGTERM → (2s) → SIGKILL (unchanged cadence). Group handling is now
**observed, not flagged**:

- Read the target's `pgid` from `/proc/<pid>/stat` via the probe.
- If `pgid == pid` (the process is its own group leader — true for everything jrun spawns
  detached), signal the **group** (`-pid`) so child processes holding ports die too.
- If the `/proc` read **fails or returns null** (a race, or the entry vanished mid-read),
  **default to the group signal** (`-pid`). jrun's own processes are detached session leaders, so
  group-killing is the correct default; the old design knew this from the persisted `detached`
  flag, and we must not silently downgrade to a single-PID signal that would leave detached
  children — and their bound ports — alive (the exact bug jrun exists to fix).
- Only signal the **single PID** when we positively observe `pgid != pid` (a foreground-launched
  JVM living in jrun's own group must not have its whole group signalled).
- ESRCH on the group call falls back to the single PID (leader already gone), as today.

### Non-Linux startup guard

In `main.ts`, before dispatching any command:

```ts
if (os.platform() !== "linux") {
  console.error(
    `jrun requires Linux or WSL (detected ${os.platform()}). ` +
      `Process discovery relies on /proc, which is unavailable on this platform.`
  );
  process.exit(1);
}
```

Blanket and early — jrun's entire purpose is process management, so partial functionality on
unsupported platforms is not worth the per-command branching.

### Performance

- Discovery does **not** run `rg` (ownership is the marker), so `status`/`kill`/`logs`/TUI no
  longer pay for — or depend on — a source scan. No per-invocation known-set cache is needed.
- Discovery cost is one `/proc` enumeration plus a small `cmdline`+`stat` read per java
  process — negligible for the expected handful of JVMs.

## Component Changes

- **`ProcessManager`** — `listRunning` scans `/proc` (via the probe) and owns a process by the
  `-Djrun.project=<hash>` marker; `killByPid(pid)` uses the observed-`pgid` rule (group-default
  on read failure); the PID-file read/write/parse code (`pidFile`, `writeRecord`, `parseRecord`,
  the `pidDir` reaping) is **deleted**. `run` injects the marker (via `buildJavaArgs`) and adopts
  the best-effort temp-then-rename log flow. `PidDir` tag and its wiring are removed. **No
  `ConfigStore` / `rg` dependency is added.**
- **`buildJavaArgs`** — prepends `-Djrun.project=<projectHash>` to the JVM args.
- **`ProcessRecord`** — drop `detached`. `pgid` is **not** stored on the record; it is re-observed
  via `probe.inspect` at kill time (observed-not-stored).
- **`discovery`** — pure: `ownsProcess(argv, marker)`, `extractMainClass(argv)` (positional),
  `extractProgramArgs`, `extractDebugPort`, `matchProcess(snap, { marker })`.
- **`JrunApi`** — `kill(pid)`, `readLogByPid(class, pid)`.
- **CLI `kill` / `logs`** — accept a PID or a class; ambiguity behavior above; `kill <pid>` guards
  ownership (refuse unless owned or `--force`); `logs <pid>` resolves exited PIDs class-agnostically.
- **TUI** — kill **and** log-view address the selected row by PID.
- **`main.ts`** — add the non-Linux guard; provide `ProcessProbeLive`; remove `PidDir`.

## Testing

- **Discovery unit tests** (inject a `ProcessProbe` stub with synthetic snapshots): a marked
  process is owned; an **unmarked** java process with the same cwd/classpath (the IntelliJ/Gradle
  false-positive) is **excluded**; same-marker ×N all discovered with distinct PIDs;
  garbage-classpath cmdline still extracts the class positionally; `debugPort` parsed.
- **Real-`/proc` discovery test (not gated on `mvn`/`java`/`rg`):** spawn a fake `java` shell
  script that sleeps, *with the `-Djrun.project=<hash>` marker* and `cwd=root`, then assert the
  **live probe + listRunning** discovers it by marker. This exercises the real `/proc` glue
  (`snapshot`, `isJava`, `readlink`, stat parsing) that a stubbed probe never touches.
- **Live probe smoke test:** `inspect(process.pid)` returns correct `pgid` and non-empty `argv`
  (not just a non-null `pid`), so a field-offset regression is caught.
- **Main-class extraction** table tests: `-cp` form, classpath-with-spaces, `-agentlib` present,
  program args present, a program arg equal to a class name (first-occurrence slice holds).
- **Log derivation:** running glob by `(class, pid)`; finished glob by class newest; class-agnostic
  glob by pid; PID-reuse produces distinct files.
- **Kill:** group-signal when `pgid == pid`; single-signal when observed `pgid != pid`;
  **group-default when inspect returns null**; ESRCH fallback.
- **Ambiguity & ownership:** `--json` ambiguous shape; single-instance class resolves; `kill <pid>`
  of an unowned PID is refused without `--force`.
- **Integration** against the example project: start the same class twice → `status` shows two
  rows with distinct PIDs → kill one by PID → the other survives (the original bug, now a
  regression test).
- **Guard:** non-linux platform string → the pure helper returns the message (and `main.ts` exits
  non-zero).

> **Test-quality rule (from review):** a passing test must be able to *fail* if the feature
> breaks. Stub-only discovery tests are necessary but not sufficient — the real-`/proc` test above
> is mandatory, and no test may encode a known-wrong behavior as "expected".

## Out of Scope (YAGNI)

- macOS/Windows discovery shims.
- Log retention/cleanup (per-run files accumulate, as they already do — a separate concern).
- Any "started from config X" association (jrun does not track this today; no consumer needs it).

## Revisions from Review (2026-06-10)

Architect + adversarial review of the original ("Both" cwd+class) design surfaced these, all
folded into the spec above:

1. **Ownership → self-identifying marker.** *(was: cwd AND known-class token.)* Root-fixes the
   false-positive on foreign JVMs (IntelliJ/Gradle launched at project-root would be claimed and
   killed) and removes `rg`/known-class/`ConfigStore` from the ownership path. Also fixes the
   false-negative where an ad-hoc/dependency/generated main not visible to `rg` was invisible.
2. **`rg` no longer load-bearing.** `findMainClasses` raises an Effect *defect* on missing `rg`,
   which `Effect.catchAll` does not catch — the original `listRunning` would have *crashed*
   `status`/`kill`/`logs`. Discovery no longer calls it at all.
3. **Kill defaults to group-signal on `/proc` read failure** — a single-PID downgrade would leave
   detached children (and bound ports) alive.
4. **`run`'s log rename is best-effort** — never fail `run`/report a phantom failure after the JVM
   is already live (which would cause duplicate-instance retries).
5. **`kill <pid>` ownership guard** (`--force` to override) — never SIGKILL an unrelated PID.
6. **TUI log view and CLI `logs <pid>` address by PID** — show the selected instance, and resolve
   an exited PID's log class-agnostically.
7. **Test quality** — mandatory real-`/proc` discovery test (un-gated), stronger live-probe
   assertions, and no test may encode a known-wrong behavior as expected.

**Confirmed sound by review (not changed):** `parseProcStat` field offsets (pgid=field 5,
starttime=field 22, `lastIndexOf(")")`), `USER_HZ=100` on target, exact-token class matching vs
substring/program-arg attacks, log-glob anchoring vs PID-substring/class-prefix collisions,
temp-then-rename fd-follows-inode, ProcessProbe seam boundary, WSL reporting `linux`.
