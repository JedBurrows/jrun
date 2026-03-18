## Why This Exists

IntelliJ IDEA on WSL has issues:
1. The red square doesn't kill processes properly
2. Processes stay alive after closing the IDE
3. Ports stay bound, blocking subsequent runs

This tool is a personal project for work that is used to run java projects on wsl.

## Prerequisites

- Node.js >= 22
- pnpm
- Java (for running projects)
- Maven (for building projects and resolving classpath)

## Installation

```bash
git clone <repo-url> ~/jrun
cd ~/jrun
pnpm install
pnpm build
```

To make `jrun` available globally:

```bash
pnpm link --global
```

Or add the bin directory to your PATH:

```bash
export PATH="$HOME/jrun/bin:$PATH"
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
