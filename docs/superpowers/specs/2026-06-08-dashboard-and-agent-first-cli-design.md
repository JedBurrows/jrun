# jrun Dashboard + Agent-First CLI — Design Spec

**Date:** 2026-06-08
**Status:** Approved

## Problem

jrun currently has a thin, configs-only TUI and a CLI whose output is human-prose only.
Two goals are unmet:

1. **Humans** want a single interactive dashboard to manage saved configs, see what Java
   processes are running, start main classes, and kill processes — instead of remembering
   separate commands.
2. **AI agents** want to drive the same capabilities programmatically. The guiding
   principle from the user: *everything that can be done in the TUI can be done from the
   CLI. Users read the TUI; agents use the CLI.*

Additionally, `findMainClasses` is slow (per-file reads, `src/main/java` only) and needs the
already-specced `rg` rewrite as the foundation.

## Guiding Principles

- **CLI/TUI parity is structural, not aspirational.** Every TUI action is a call to a shared
  `JrunApi`; every `JrunApi` method has a corresponding CLI command. Parity is verified by a
  checklist mapping each TUI action to its CLI command.
- **Agents parse, humans read.** A `--json` flag on query/action commands yields structured
  output; default output stays human-friendly.
- **YAGNI.** No interval polling, no MCP server, no Gradle support, no live log streaming
  beyond a simple `--follow`. These can come later if needed.

## Architecture

### The `JrunApi` seam (Effect ↔ Ink bridge)

A single `JrunApi` object is the one place both the CLI and the TUI go through.

```ts
interface JrunApi {
  listConfigs(): Promise<string[]>;
  loadConfig(name: string): Promise<RunConfig | null>;
  saveConfig(name: string, cfg: RunConfig): Promise<void>;
  deleteConfig(name: string): Promise<void>;
  listMainClasses(): Promise<string[]>;
  listRunning(): Promise<RunningProcess[]>;
  start(spec: StartSpec): Promise<StartResult>;   // detached when spec.detached
  kill(target: string): Promise<void>;            // by mainClass (or pid string)
}
```

- `main.ts` builds the Effect `Runtime` **once** and constructs a `JrunApi` whose methods are
  `Runtime.runPromise(runtime, <service effect>)` wrappers over the existing services
  (`ConfigStore`, `JavaProject`, `ProcessManager`).
- The Ink dashboard receives `JrunApi` as a prop. React components stay logic-free: they call
  `JrunApi` methods and render results. No `fs`/`spawnSync` in React callbacks (removing the
  current anti-pattern in `ConfigsTui` / `configs.ts`).
- CLI commands call `JrunApi` where it removes duplication; existing direct-service usage that
  is already clean may remain, but new shared logic lives behind `JrunApi`.

**Trade-off accepted:** one thin adapter layer to maintain, in exchange for parity-by-construction
and a single tested path for both surfaces.

### Detached run model + logs

- New `jrun start --detached` (alias `-d`). Spawns `java` with `detached: true`, `stdio`
  redirected to a per-run log file, `unref()`s the child, writes the PID record, and returns
  immediately.
- **Log files** live at `~/.jrun/logs/<projectHash>-<mainClass>-<startedAt>.log`
  (`projectHash` is the existing md5-of-root scheme in `ProcessManager`).
- **PID record format upgrade.** PID files change from a raw integer to a small JSON object:

  ```json
  {
    "pid": 12345,
    "mainClass": "com.example.App",
    "startedAt": "2026-06-08T10:30:00.000Z",
    "logFile": "/home/u/.jrun/logs/ab12-com.example.App-....log",
    "args": ["--port", "8080"]
  }
  ```

  Foreground runs write the same record minus `logFile` (`logFile: null`). `listRunning()`
  returns these enriched records and still reaps dead PIDs as today.
- The TUI's "start" action always uses detached mode (the TUI owns the terminal). CLI `start`
  stays foreground by default; `--detached` opts in.

### CLI changes

| Command | Change |
|---|---|
| `list` | add `--json` → `string[]` of FQCNs |
| `status` | add `--json` → array of enriched `RunningProcess` records |
| `configs list` | add `--json` → `string[]` |
| `configs show <name>` | add `--json` → the config object (already prints JSON; flag makes it explicit/stable) |
| `start` | add `--detached`/`-d`; add `--json` → `{ ok, pid, logFile }` |
| `kill` | add `--json` → `{ ok, mainClass }`; stable non-zero exit on not-found |
| `save` | add `--json` → `{ ok, name }` |
| `configs delete` | add `--json` → `{ ok, name }` |
| `logs <class>` | **new**: print the detached log file for a running/last run; `--follow`/`-f` to stream. Raw log text (no `--json`). |
| `jrun` (no args) / `jrun ui` | **new**: launch the dashboard TUI |

Conventions:
- Under `--json`, query commands emit the data structure; action commands emit a single-line
  result object `{ ok: true, ... }` on success.
- Failures exit non-zero with a JSON `{ ok: false, error }` under `--json`, or a human message
  otherwise.

### The dashboard TUI

A single Ink app launched by `jrun` (no args) or `jrun ui`. Three tabs switched with Tab / ←→,
plus a shared status/help bar.

- **Configs tab** — list + detail pane (current `ConfigsTui` content). Actions: `s` start
  (detached), `e` edit (`$EDITOR`), `d` delete (with confirm).
- **Running tab** — list of `listRunning()` records (mainClass, PID, uptime). Actions: `k` kill
  (with confirm), `l` view logs (opens the log file in a pager or prints tail).
- **Main classes tab** — `listMainClasses()` output. Actions: `s` start (detached), `S`
  save-as-config (prompts for a name).
- Global: `r` refresh (re-pulls all state via `JrunApi`), `q`/Esc quit. **No interval polling.**

**Parity map** (each TUI action → CLI command):

| TUI action | CLI equivalent |
|---|---|
| Configs: start | `jrun start <name> --detached` |
| Configs: edit | `jrun configs edit <name>` |
| Configs: delete | `jrun configs delete <name>` |
| Running: kill | `jrun kill <class>` |
| Running: view logs | `jrun logs <class>` |
| Main classes: start | `jrun start <class> --detached` |
| Main classes: save-as-config | `jrun save <name> <class>` |
| Refresh | (stateless re-query; `jrun status` / `jrun list`) |

## Component Boundaries

- **Services** (`JavaProject`, `ProcessManager`, `ConfigStore`) — unchanged responsibilities;
  `ProcessManager` gains detached spawn + enriched PID records, `JavaProject` gets the rg
  rewrite.
- **`JrunApi`** (`src/api/JrunApi.ts`, new) — promise-returning adapter over services bound to a
  single `Runtime`. Depends on services only.
- **CLI commands** (`src/commands/*`) — argument parsing + output formatting (incl. `--json`).
  Depend on `JrunApi` / services.
- **TUI** (`src/tui/*`) — rendering + key handling only. Pure reducer/format logic extracted
  for testing; depends on `JrunApi` via props.

## Error Handling

- rg rewrite: per existing spec (rg exit 1 → `[]`; rg missing → clear fatal error; non-standard
  paths skipped).
- Detached start: if `java` is missing or spawn fails, surface a clear error and do not write a
  stale PID record.
- Kill: not-found → non-zero exit + message/`{ok:false}`; already-dead PID reaped silently.
- `logs`: missing log file → clear message + non-zero exit.
- TUI actions catch `JrunApi` rejections and show them in the status bar rather than crashing.

## Testing

- **Services** — `@effect/vitest`, where logic concentrates:
  - `JavaProject`: rg-based discovery incl. `src/test/java` and non-standard-path exclusion
    (per existing rg plan).
  - `ProcessManager`: detached spawn writes enriched record + log file; `listRunning` returns
    enriched records and reaps dead PIDs; foreground record has `logFile: null`.
  - `ConfigStore`: unchanged coverage.
- **`JrunApi`** — thin contract test that each method delegates to the right service effect.
- **TUI** — extract pure reducer/format functions and unit-test them; render-level smoke tests
  with `ink-testing-library` for tab switching and key handling. React glue stays minimal.
- Each build phase lands with a green suite and `pnpm typecheck` clean.

## Build Order

1. **rg rewrite** — execute the existing approved plan
   (`docs/superpowers/plans/2026-05-19-fast-main-class-discovery.md`).
2. **Detached runs + enriched PID records + `--json`** — `ProcessManager` + CLI flags + `logs`.
3. **`JrunApi` seam** — introduce the adapter; route commands/TUI through it.
4. **Dashboard TUI** — three-tab unified dashboard; remove raw I/O from React.
5. **Polish** — parity-map verification checklist, README/CLAUDE.md updates.

Each phase is independently shippable and green before the next begins.

## Out of Scope

- MCP server (parity is achieved via `--json` CLI; revisit later if agents need native tools).
- Gradle support; non-standard `<sourceDirectory>` in pom.xml.
- Interval/live polling in the dashboard; full TUI log streaming beyond `logs --follow`.
- Multi-module classpath resolution improvements.
