## Why This Exists

IntelliJ IDEA on WSL has issues:
1. The red square doesn't kill processes properly
2. Processes stay alive after closing the IDE
3. Ports stay bound, blocking subsequent runs

This tool is a personal project for work that is used to run java projects on wsl.

## Prerequisites

- Java (for running projects)
- Maven (for building projects and resolving classpath)
- [ripgrep](https://github.com/BurntSushi/ripgrep) (`rg` must be on your `PATH`) — used by `jrun list` to discover main classes across all source roots

## Installation

**Standalone binary** (no Node.js required):

```bash
curl -fsSL https://raw.githubusercontent.com/jedburrows/jrun/main/install.sh | bash
```

Or download the binary directly from [GitHub Releases](https://github.com/jedburrows/jrun/releases).

**Uninstall:**

```bash
curl -fsSL https://raw.githubusercontent.com/jedburrows/jrun/main/install.sh | bash -s -- --uninstall
```

**From source** (requires Node.js >= 22 and pnpm):

```bash
npm i -g github:jedburrows/jrun
```

## Usage

```
jrun <command> [options]
```

**Commands:**

| Command | Description |
|---|---|
| `ui` | Launch the interactive dashboard |
| `build` | Compile (`mvn compile -q`) |
| `list` | List all main classes in project |
| `start [--jvm <opts>] [--detached] [--debug <port>] [--debug-suspend] [class] [args...]` | Run main class (or saved config) |
| `logs <class> [--follow]` | Print (or stream) a detached run's log file |
| `save [--jvm <opts>] <name> <class> [args...]` | Save run configuration |
| `rerun` | Run last command again |
| `status` | Show tracked running processes |
| `kill [class]` | Gracefully stop a process |

Most commands also accept `--json` for machine-readable output (see [Agent / scripting use](#agent--scripting-use)).

**Examples:**

```bash
# List available main classes
jrun list

# Run a class with JVM options
jrun start --jvm "-Xmx512m -Dfoo=bar" com.example.App --port 8080

# Run in the background; output is redirected to a log file under ~/.jrun/logs
jrun start --detached com.example.App
jrun logs com.example.App            # print the log
jrun logs com.example.App --follow   # stream it

# Run with remote debugging enabled (jrun enables JDWP; attach your IDE to the port)
jrun start --debug 5005 com.example.App
jrun start --debug 5005 --debug-suspend com.example.App   # JVM waits for the debugger

# Save and reuse a configuration
jrun save app com.example.App --port 8080
jrun start app

# Re-run the last command
jrun rerun

# Process management
jrun status
jrun kill com.example.App
```

## Dashboard (TUI)

`jrun` ships with a lazygit-style interactive terminal dashboard. Launch it with:

```bash
jrun ui          # explicit
jrun             # bare, when run in an interactive terminal
jrun configs     # the configs command with no subcommand also opens it
```

The dashboard has three panels plus a detail pane and a context-sensitive hint bar:

- **Configs** — your saved run configurations.
- **Running** — currently tracked processes.
- **Main classes** — discoverable main classes in the project.

Select an item to see its details in the detail pane. Destructive actions
(delete, kill) prompt for `y/N` confirmation. Starts launched from the dashboard
run detached.

**Keybindings:**

| Keys | Action |
|---|---|
| `j` / `k` or ↓ / ↑ | Move down / up |
| `h` / `l`, Tab / Shift-Tab, ← / → | Previous / next panel |
| `1` / `2` / `3` | Jump to Configs / Running / Main classes |
| `g` / `G` | Jump to top / bottom of list |
| `r` | Refresh |
| `?` | Help overlay |
| `q` | Quit |

Per-panel actions:

| Panel | Keys |
|---|---|
| Configs | `s` start, `S` start in debug (port 5005), `e` edit (`$EDITOR`), `d` delete |
| Running | `Enter` view logs, `x` kill |
| Main classes | `s` start, `S` start in debug, `w` save as config |

Note: kill is `x` (not `k`, which is vim-up), and logs open with `Enter` (not
`l`, which switches panels).

The dashboard is for humans. Agents and scripts should drive the CLI directly
with `--json` (see [Agent / scripting use](#agent--scripting-use)).

## Agent / scripting use

Every query command (`list`, `status`, `configs list`, `configs show`) and action
command (`start`, `kill`, `save`, `configs delete`) accepts `--json` for
machine-readable output. Query commands print compact JSON; action commands print
`{"ok":true,...}` on success or `{"ok":false,"error":...}` and exit non-zero on
failure — so scripts and agents can branch on the exit code.

```bash
# JSON array of fully-qualified main classes
jrun list --json

# Launch in the background with debugging, get the pid/log/port back
jrun start com.example.App --detached --debug 5005 --json
# => {"ok":true,"pid":12345,"logFile":"/home/you/.jrun/logs/...","debugPort":5005}

# Array of running-process records ({ pid, mainClass, startedAt, logFile, args, debugPort, detached })
jrun status --json

# Read a detached run's log (use --follow to stream)
jrun logs com.example.App
```

**Debugging:** `--debug <port>` enables JDWP at launch — jrun *enables* debugging,
you attach your IDE/debugger to that port. Add `--debug-suspend` to make the JVM
wait for a debugger to attach before running.

## Try it out

The repo includes a demo Maven project in `example/`. Run these commands from that directory:

```bash
cd example
mvn compile

# See all discoverable main classes
jrun list

# Quick run — exits immediately
jrun start com.example.HelloWorld
jrun start com.example.HelloWorld Alice

# Run with flags
jrun start com.example.DataProcessor -- --count 5 --label order

# Long-running server (runs until killed)
jrun start com.example.ApiServer -- --port 9000 &
jrun status
jrun kill com.example.ApiServer

# Save a config and rerun it
jrun save hello com.example.HelloWorld World
jrun start hello
jrun rerun
```

## Development

```bash
# Run from source (no build needed)
pnpm tsx src/main.ts -- list
pnpm tsx src/main.ts -- start --jvm "-Xmx512m" com.example.App

# Run tests
pnpm test          # watch mode
pnpm test:run      # single run

# Build
pnpm build         # outputs to dist/
```

## For AI Agents

If you're an AI agent working with this CLI:

```bash
# From the jrun project directory:
pnpm tsx src/main.ts -- <command> [args]

# Or if built:
./bin/jrun <command> [args]

# Key commands for automation:
pnpm tsx src/main.ts -- list                    # discover main classes
pnpm tsx src/main.ts -- start com.example.App   # run a class
pnpm tsx src/main.ts -- status                  # check running processes
pnpm tsx src/main.ts -- kill com.example.App    # stop a process
```

All state is stored in `~/.jrun/`:
- `~/.jrun/configs/` — saved run configurations (JSON)
- `~/.jrun/pids/` — PID files for running processes
- `~/.jrun/last-run.json` — last run config (for `rerun`)
