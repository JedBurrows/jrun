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
| Ownership match | **Both** — `cwd == projectRoot` **AND** a recognized main-class token |
| Metadata source | `/proc/<pid>/{cwd,cmdline,stat}` |
| Logs | Filename encodes `(class, pid, startedAt)`; path is derived, never stored |
| Kill | By PID; group-signal only when the PID is its own group leader |
| Non-Linux | Blanket startup guard → exit non-zero with a clear message |
| `~/.jrun/pids/` | **Removed entirely** |

## Architecture

### Discovery: identifying "our" processes

A live process belongs to this project when **both** hold:

1. **`cwd == projectRoot`** — `readlink(/proc/<pid>/cwd)` equals the resolved project root.
   This is how jrun launches every JVM (`spawn({ cwd: root })`), so it is a reliable ownership
   signal and scopes results to the current project.
2. **A recognized main-class token** — some argv token in `/proc/<pid>/cmdline` is a member of
   the **known-class set** = (saved-config main classes) ∪ (`rg` main-class scan results).

Reading the candidate set:

- Enumerate `/proc/<pid>` for numeric PIDs. A java process is one whose `cmdline`'s argv[0]
  basename is `java` (or ends in `/java`).
- For each, `readlink` its `cwd`; skip if it is not the project root.
- Read `/proc/<pid>/cmdline` and split on `\0` to recover the **true argv**. (Critical: `ps`
  output space-flattens a classpath that contains spaces — the garbage-classpath case we hit —
  whereas `/proc/cmdline` preserves each argv element exactly.)

### Main-class extraction

Given the true argv:

- **Primary:** intersect argv tokens with the known-class set; the match is the main class.
  This survives a malformed `-cp` value (the broken-classpath case still had
  `com.example.ApiServer` as a clean token).
- **Fallback (positional):** the first non-option token after the classpath/jar/module flag —
  `-cp` / `-classpath` / `--class-path` → argv index + 2; `-jar` → the jar's main class is not a
  token (skip — jrun never launches via `-jar`); `-m` / `--module` → `module/MainClass` form.
  jrun always emits `-cp <classpath> <mainClass> <args…>`, so the positional rule is exact for
  jrun-launched processes; the fallback exists only for robustness.

If neither yields a token in the known set, the process is **not** owned (per the "Both" rule)
and is omitted.

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

If jrun dies between steps 2 and 3, the **process is still fully discoverable** (the scan does
not depend on the log name); only its log *link* is briefly under the `.tmp` name. Discovery
MAY additionally match a stray `…-<startedAtCompact>.tmp` whose mtime aligns, but this is a
best-effort nicety, not required for correctness.

### Identity & CLI surface

PID-primary, class as a convenience shortcut:

- `jrun kill <pid>` / `jrun logs <pid>` — always unambiguous.
- `jrun kill <class>` / `jrun logs <class>` — resolve when the class has **exactly one** running
  instance. With multiple:
  - **interactive:** present a picker (PID + startedAt) — reuse the existing `terminal.select`.
  - **`--json`:** `{ ok: false, error: "ambiguous", instances: [{ pid, startedAt }, …] }`,
    exit non-zero.
  - **non-json non-interactive:** print the instances and exit non-zero.
- `status` / `status --json` list every discovered instance, each with its PID (already the
  shape — just no longer deduped by class).
- The **TUI is unaffected**: a selected row already corresponds to a specific PID, so kill/logs
  act on that PID directly.

### Kill

Signal by PID, escalating SIGTERM → (2s) → SIGKILL (unchanged cadence). Group handling is now
**observed, not flagged**:

- Read the target's `pgid` from `/proc/<pid>/stat`.
- If `pgid == pid` (the process is its own group leader — true for everything jrun spawns
  detached), signal the **group** (`-pid`) so child processes holding ports die too.
- Otherwise signal the **single PID** (a foreground-launched JVM living in jrun's own group must
  not have its whole group signalled).
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

- The known-class set (saved configs + `rg` scan) is computed **once per invocation** and
  cached, so repeated `status`/refresh calls within one process do not re-run `rg`.
- Discovery cost is one `/proc` enumeration plus a `readlink` + small file read per java
  process — negligible for the expected handful of JVMs.

## Component Changes

- **`ProcessManager`** — `listRunning` is rewritten to scan `/proc` and match; `kill`/`killByPid`
  take a PID and use the observed-`pgid` rule; the PID-file read/write/parse code
  (`pidFile`, `writeRecord`, `parseRecord`, the `pidDir` reaping) is **deleted**. `run`'s
  detached path adopts the temp-then-rename log flow. `PidDir` tag and its wiring are removed.
- **`ProcessRecord`** — drop `detached`; add `pgid` (internal to kill, need not surface in JSON).
- **`JrunApi`** — `kill` gains a PID-or-class signature; `readLog`/log lookups use the new glob.
- **CLI `kill` / `logs`** — accept a PID or a class; implement the ambiguity behavior above.
- **`main.ts`** — add the non-Linux guard; remove `PidDir` provisioning.

## Testing

- **Discovery unit tests** against synthetic `/proc`-shaped fixtures (inject a `/proc` reader
  seam): same-class ×N all discovered; non-project cwd excluded; unknown class excluded;
  garbage-classpath cmdline still extracts the class; `debugPort` parsed.
- **Main-class extraction** table tests: `-cp` form, classpath-with-spaces, `-agentlib` present,
  program args present, module `-m` form.
- **Log derivation:** running glob by `(class, pid)`; finished glob by class newest; PID-reuse
  produces distinct files.
- **Kill:** group-signal when `pgid == pid`; single-signal otherwise; ESRCH fallback.
- **Ambiguity:** `--json` ambiguous shape; single-instance class resolves.
- **Integration** against the example project: start the same class twice → `status` shows two
  rows with distinct PIDs → kill one by PID → the other survives (the original bug, now a
  regression test).
- **Guard:** stub `os.platform()` → non-linux exits non-zero with the message.

## Out of Scope (YAGNI)

- macOS/Windows discovery shims.
- Log retention/cleanup (per-run files accumulate, as they already do — a separate concern).
- Any "started from config X" association (jrun does not track this today; no consumer needs it).
