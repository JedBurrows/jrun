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
  start(spec: StartSpec): Promise<StartResult>;   // spec carries detached + debug options
  kill(target: string): Promise<void>;            // by mainClass (or pid string)
  // StartSpec: { mainClass | configName, args?, jvmOpts?, detached?, debug?: { port, suspend } }
  // StartResult: { pid, logFile, debugPort }
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
- **Debug (JDWP) support.** `jrun start --debug [port]` injects the JDWP agent arg
  (`-agentlib:jdwp=transport=dt_socket,server=y,suspend=n,address=*:<port>`) before the
  user's `--jvm` opts; default port **5005**. `--debug-suspend` flips `suspend=y` so the JVM
  waits for a debugger before running `main`. **jrun only enables debugging and reports the
  port — it never implements a debugger; attaching is the IDE's job.** `--debug` composes with
  `--detached` (the common case: start a debuggable process in the background, then attach an
  IDE). The chosen `debugPort` is recorded in the PID record and surfaced everywhere a running
  process is shown.
- **Log files** live at `~/.jrun/logs/<projectHash>-<mainClass>-<startedAt>.log`
  (`projectHash` is the existing md5-of-root scheme in `ProcessManager`).
- **PID record format upgrade.** PID files change from a raw integer to a small JSON object:

  ```json
  {
    "pid": 12345,
    "mainClass": "com.example.App",
    "startedAt": "2026-06-08T10:30:00.000Z",
    "logFile": "/home/u/.jrun/logs/ab12-com.example.App-....log",
    "args": ["--port", "8080"],
    "debugPort": 5005
  }
  ```

  Foreground runs write the same record minus `logFile` (`logFile: null`). `debugPort` is
  `null` when debugging is not enabled. `listRunning()` returns these enriched records and still
  reaps dead PIDs as today.
- The TUI's "start" action always uses detached mode (the TUI owns the terminal). CLI `start`
  stays foreground by default; `--detached` opts in.

### CLI changes

| Command | Change |
|---|---|
| `list` | add `--json` → `string[]` of FQCNs |
| `status` | add `--json` → array of enriched `RunningProcess` records |
| `configs list` | add `--json` → `string[]` |
| `configs show <name>` | add `--json` → the config object (already prints JSON; flag makes it explicit/stable) |
| `start` | add `--detached`/`-d`, `--debug [port]`, `--debug-suspend`; add `--json` → `{ ok, pid, logFile, debugPort }` |
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

A single Ink app launched by `jrun` (no args) or `jrun ui`. **The UX is modeled on
[lazygit](https://github.com/jesseduffield/lazygit):** panel-based, vim-first navigation, with a
context-sensitive keybinding hint bar at the bottom and a `?` help overlay.

**Layout (lazygit-style).** A left column of stacked panels and a main detail pane on the right.
The three panels are **Configs**, **Running**, and **Main classes**. The focused panel is
highlighted; its selected row drives the right-hand detail pane.

**Navigation — vim motions and arrow keys both work everywhere:**

| Intent | Vim | Also |
|---|---|---|
| Move selection down / up | `j` / `k` | ↓ / ↑ |
| Next / previous panel | `l` / `h` or `Tab` / `Shift-Tab` | → / ← |
| Jump to panel 1/2/3 | `1` `2` `3` | — |
| Top / bottom of list | `g` / `G` | Home / End |
| Confirm / activate | `Enter` | — |
| Cancel / back | `Esc` | — |
| Help overlay | `?` | — |
| Quit | `q` | `Ctrl-C` |

**Per-panel actions** (single-key, shown contextually in the hint bar like lazygit):

- **Configs** — `s` start (detached), `S` start in debug mode, `e` edit (`$EDITOR`), `d` delete
  (confirm).
- **Running** — `k` kill (confirm); the detail pane shows the **debug port** when set so you know
  where to point your IDE. (`l` is "next panel"; logs open with `Enter` — see Ambiguity
  resolution below.)
- **Main classes** — `s` start (detached), `S` start in debug mode, `w` save-as-config (prompts
  for a name).

The `s`/`S` pairing (start / start-with-debug) is consistent across the Configs and Main classes
panels; capital `S` never collides with the lower-case action keys.

**Keybinding conventions (from lazygit):**
- Lower-case = act on the selected item; the hint bar always shows the keys valid in the focused
  panel.
- Destructive actions (`d` delete, `k` kill) require a confirm prompt.
- `r` refresh (re-pulls all state via `JrunApi`); **no interval polling.**

**Ambiguity resolution — `l`/logs collision.** Because `l` is reserved for "next panel"
(vim `h`/`l` movement), viewing logs in the Running panel is bound to `Enter` (open log view for
the selected process) rather than `l`. The save-as-config action in Main classes uses `w`
(write) to avoid colliding with `s` start. These bindings are listed in the `?` overlay.

**Parity map** (each TUI action → CLI command):

| TUI action | CLI equivalent |
|---|---|
| Configs: start | `jrun start <name> --detached` |
| Configs: start in debug | `jrun start <name> --detached --debug` |
| Configs: edit | `jrun configs edit <name>` |
| Configs: delete | `jrun configs delete <name>` |
| Running: kill | `jrun kill <class>` |
| Running: view logs | `jrun logs <class>` |
| Main classes: start | `jrun start <class> --detached` |
| Main classes: start in debug | `jrun start <class> --detached --debug` |
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
- Debug start: jrun does not check whether the debug port is free (it lets the JVM fail loudly
  if the port is taken); the requested port is still recorded so the failure is diagnosable from
  the log file. `--debug-suspend` is documented as blocking `main` until a debugger attaches.
- Kill: not-found → non-zero exit + message/`{ok:false}`; already-dead PID reaped silently.
- `logs`: missing log file → clear message + non-zero exit.
- TUI actions catch `JrunApi` rejections and show them in the status bar rather than crashing.

## Testing

- **Services** — `@effect/vitest`, where logic concentrates:
  - `JavaProject`: rg-based discovery incl. `src/test/java` and non-standard-path exclusion
    (per existing rg plan).
  - `ProcessManager`: detached spawn writes enriched record + log file; `listRunning` returns
    enriched records and reaps dead PIDs; foreground record has `logFile: null`; debug start
    injects the correct JDWP arg (port + `suspend` flag) ahead of user `--jvm` opts and records
    `debugPort`.
  - `ConfigStore`: unchanged coverage.
- **`JrunApi`** — thin contract test that each method delegates to the right service effect.
- **TUI** — extract pure reducer/format functions and unit-test them, including the keymap:
  vim motions (`j`/`k`/`h`/`l`/`g`/`G`) and arrow keys resolve to the same actions, panel
  focus cycling, and contextual action dispatch. Render-level smoke tests with
  `ink-testing-library` for panel switching and key handling. React glue stays minimal.
- Each build phase lands with a green suite and `pnpm typecheck` clean.

## Build Order

1. **rg rewrite** — execute the existing approved plan
   (`docs/superpowers/plans/2026-05-19-fast-main-class-discovery.md`).
2. **Detached runs + debug (JDWP) + enriched PID records + `--json`** — `ProcessManager` (detached
   spawn, JDWP arg injection, enriched records) + CLI flags (`--detached`, `--debug`,
   `--debug-suspend`, `--json`) + `logs`.
3. **`JrunApi` seam** — introduce the adapter; route commands/TUI through it.
4. **Dashboard TUI** — lazygit-style three-panel dashboard with vim + arrow navigation; remove
   raw I/O from React.
5. **Polish** — parity-map verification checklist, README/CLAUDE.md updates.

Each phase is independently shippable and green before the next begins.

## Out of Scope

- MCP server (parity is achieved via `--json` CLI; revisit later if agents need native tools).
- Implementing a debugger or auto-attaching one. jrun only enables JDWP and reports the port;
  attaching is the IDE's responsibility. Debug-port liveness/conflict checking is also out of
  scope.
- Gradle support; non-standard `<sourceDirectory>` in pom.xml.
- Interval/live polling in the dashboard; full TUI log streaming beyond `logs --follow`.
- Multi-module classpath resolution improvements.
