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
- `jrun logs <class> [--follow]` — print/stream a detached run's log
- `jrun status` / `jrun kill` — manage running processes
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

All state lives in `~/.jrun/` (configs, PIDs, last-run).
