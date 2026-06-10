# jrun

CLI tool for running and managing Java processes from the terminal. Built to solve IntelliJ/WSL process management issues — processes not dying, ports staying bound, etc.

## Install globally

mise use -g npm:@jed-dev/jrun   # mise also supplies Node; or: npm i -g @jed-dev/jrun

Published to npm as `@jed-dev/jrun`. Requires Node.js >= 22.

## Quick reference

Run `jrun --help` for all commands. Key commands:
- `jrun ui` — launch the interactive dashboard (also opened by bare `jrun` in a TTY, or `jrun configs`)
- `jrun list` — find main classes in a Maven project (uses `rg`)
- `jrun start <class>` — run a main class (tracks the PID). Flags: `--detached`/`-d` (background, logs to `~/.jrun/logs`), `--debug <port>` (enable JDWP; attach your IDE), `--debug-suspend`, `--json`
- `jrun start <saved-name>` — run a saved configuration
- `jrun logs <class|pid> [--follow]` — print/stream a detached run's log; a PID targets one specific instance (and an already-exited PID's log is still found)
- `jrun status` / `jrun kill [<class|pid>]` — manage running processes. With multiple instances of a class, kill by PID (or pick interactively); a class with one instance still works by name. `jrun kill <pid>` only signals jrun-managed processes — pass `--force` to kill an unmanaged PID
- `jrun save <name> <class> [args]` — save a run config
- `jrun rerun` — repeat last run

The dashboard is the interactive TUI (vim + arrow keys, `?` for help) for humans; agents drive the CLI. All query/action commands support `--json` for machine-readable output (the agent-facing contract).

Must be run from a Maven project directory (where pom.xml lives). Requires `ripgrep` (`rg`) on PATH for `jrun list`.

## Development

- `pnpm install && pnpm build` — setup
- `pnpm test` — vitest in watch mode
- `pnpm dev` — run from source via tsx
- TypeScript + Effect, built with tsup targeting node22

## State

Persistent state in `~/.jrun/` is just configs, logs, and last-run — there is **no PID registry**. Running processes are discovered live from the OS process table (`/proc`): `jrun start` injects a `-Djrun.project=<md5(projectRoot)>` marker into the JVM, and `status`/`kill`/`logs` find jrun's processes by scanning for that marker. This makes tracking immune to desync — multiple instances of the same class, orphans, and out-of-band kills are all reflected accurately. Linux/WSL only (relies on `/proc`; a startup guard exits on other platforms).
