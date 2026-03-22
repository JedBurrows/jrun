## Why This Exists

IntelliJ IDEA on WSL has issues:
1. The red square doesn't kill processes properly
2. Processes stay alive after closing the IDE
3. Ports stay bound, blocking subsequent runs

This tool is a personal project for work that is used to run java projects on wsl.

## Prerequisites

- Java (for running projects)
- Maven (for building projects and resolving classpath)

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
| `build` | Compile (`mvn compile -q`) |
| `list` | List all main classes in project |
| `start [--jvm <opts>] [class] [args...]` | Run main class (or saved config) |
| `save [--jvm <opts>] <name> <class> [args...]` | Save run configuration |
| `rerun` | Run last command again |
| `status` | Show tracked running processes |
| `kill [class]` | Gracefully stop a process |

**Examples:**

```bash
# List available main classes
jrun list

# Run a class with JVM options
jrun start --jvm "-Xmx512m -Dfoo=bar" com.example.App --port 8080

# Save and reuse a configuration
jrun save app com.example.App --port 8080
jrun start app

# Re-run the last command
jrun rerun

# Process management
jrun status
jrun kill com.example.App
```

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
