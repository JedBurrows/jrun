# jrun

CLI tool for running and managing Java processes from the terminal. Built to solve IntelliJ/WSL process management issues — processes not dying, ports staying bound, etc.

## Install globally

npm i -g github:jedburrows/jrun

## Quick reference

Run `jrun --help` for all commands. Key commands:
- `jrun list` — find main classes in a Maven project
- `jrun start <class>` — run a main class (tracks the PID)
- `jrun start <saved-name>` — run a saved configuration
- `jrun status` / `jrun kill` — manage running processes
- `jrun save <name> <class> [args]` — save a run config
- `jrun rerun` — repeat last run

Must be run from a Maven project directory (where pom.xml lives).

## Development

- `pnpm install && pnpm build` — setup
- `pnpm test` — vitest in watch mode
- `pnpm dev` — run from source via tsx
- TypeScript + Effect, built with tsup targeting node22

## State

All state lives in `~/.jrun/` (configs, PIDs, last-run).
