## Why This Exists

IntelliJ IDEA on WSL has issues:
1. The red square doesn't kill processes properly
2. Processes stay alive after closing the IDE
3. Ports stay bound, blocking subsequent runs

This tool is a personal project for work that is used to run java projects on wsl.

## Installation

```bash
git clone <repo-url> ~/jrun
cd ~/jrun
./install.sh
source ~/.bashrc
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
| `start [class] [args]` | Run main class (interactive if no class given) |
| `start <config> [args]` | Run saved configuration |
| `save <name> <class> [args]` | Save run configuration |
| `rerun` | Run last command again |
| `status` | Show tracked running processes |
| `kill [class]` | Gracefully stop process (interactive if no class given) |

**Examples:**

```bash
jrun start com.example.App --port 8080
jrun save app com.example.App --port 8080
jrun start app
jrun rerun
jrun status
jrun kill
```
