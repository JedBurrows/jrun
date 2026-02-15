#!/usr/bin/env bash

CONFIG_DIR="$HOME/.jrun/configs"
LAST_RUN="$HOME/.jrun/last-run"
PID_DIR="$HOME/.jrun/pids"
CLASSPATH_CACHE="$HOME/.jrun/classpath-cache"

mkdir -p "$CONFIG_DIR" "$PID_DIR"

# --- Helpers ---

project_hash() {
  echo -n "$(pwd)" | md5sum | cut -d' ' -f1
}

pid_file() {
  local main_class="$1"
  echo "$PID_DIR/$(project_hash)-${main_class}.pid"
}

find_main_classes() {
  grep -Prl 'public\s+static\s+void\s+main\s*\(' src/main/java 2>/dev/null \
    | sed 's|src/main/java/||' \
    | sed 's|/|.|g' \
    | sed 's|\.java$||'
}

select_with_fzf() {
  local prompt="$1"
  local items="$2"
  if command -v fzf &>/dev/null; then
    echo "$items" | fzf --prompt="$prompt "
  else
    # Numbered list fallback
    local -a arr
    mapfile -t arr <<< "$items"
    echo "$prompt" >&2
    local i
    for i in "${!arr[@]}"; do
      echo "  $((i+1))) ${arr[$i]}" >&2
    done
    read -rp "Select [1-${#arr[@]}]: " choice >&2
    if [[ "$choice" =~ ^[0-9]+$ ]] && (( choice >= 1 && choice <= ${#arr[@]} )); then
      echo "${arr[$((choice-1))]}"
    fi
  fi
}

# --- Classpath ---

resolve_classpath() {
  local cache_valid=false
  if [[ -f "$CLASSPATH_CACHE" && -f pom.xml ]]; then
    if [[ "$CLASSPATH_CACHE" -nt pom.xml ]]; then
      cache_valid=true
    fi
  fi

  if $cache_valid; then
    cat "$CLASSPATH_CACHE"
  else
    local cp
    cp=$(mvn dependency:build-classpath -q -DincludeScope=runtime -Dmdep.outputFile=/dev/stdout 2>/dev/null)
    if [[ -n "$cp" ]]; then
      echo "$cp" > "$CLASSPATH_CACHE"
    fi
    echo "$cp"
  fi
}

# --- Config ---

save_config() {
  local name="$1"
  local main_class="$2"
  shift 2

  local quoted_args=""
  for arg in "$@"; do
    quoted_args+="$(printf '%q ' "$arg")"
  done

  cat > "$CONFIG_DIR/${name}.conf" <<EOF
MAIN_CLASS=$main_class
PROGRAM_ARGS=($quoted_args)
EOF
  echo "Saved config: $name"
}

load_config() {
  local name="$1"
  if [[ -f "$CONFIG_DIR/${name}.conf" ]]; then
    source "$CONFIG_DIR/${name}.conf"
    return 0
  fi
  return 1
}

# --- Run ---

run_java() {
  local main_class="$1"
  shift

  # Save for 'rerun' command — properly quoted
  {
    echo "$main_class"
    for arg in "$@"; do
      printf '%s\n' "$arg"
    done
  } > "$LAST_RUN"

  # Build classpath
  local dep_cp
  dep_cp=$(resolve_classpath)
  local cp="target/classes"
  [[ -n "$dep_cp" ]] && cp="$cp:$dep_cp"

  local pf
  pf=$(pid_file "$main_class")

  # Launch java
  java -cp "$cp" "$main_class" "$@" &
  local child_pid=$!
  echo "$child_pid" > "$pf"

  # Cleanup PID file on any exit
  cleanup() {
    rm -f "$pf"
  }
  trap cleanup EXIT

  # Graceful shutdown: forward signal to child, wait, then force kill
  forward_signal() {
    kill -TERM "$child_pid" 2>/dev/null
    local i=0
    while (( i < 50 )); do
      kill -0 "$child_pid" 2>/dev/null || return
      sleep 0.1
      (( i++ ))
    done
    kill -KILL "$child_pid" 2>/dev/null
  }
  trap forward_signal SIGINT SIGTERM

  wait "$child_pid"
}

# --- Status / kill helpers ---

list_running() {
  local hash
  hash=$(project_hash)
  for pf in "$PID_DIR/${hash}"-*.pid; do
    [[ -f "$pf" ]] || continue
    local pid
    pid=$(<"$pf")
    if kill -0 "$pid" 2>/dev/null; then
      local basename
      basename=$(basename "$pf" .pid)
      local main_class="${basename#"${hash}"-}"
      echo "$main_class $pid"
    else
      rm -f "$pf"
    fi
  done
}

graceful_kill() {
  local pid="$1"
  kill -TERM "$pid" 2>/dev/null || return
  local i=0
  while (( i < 50 )); do
    kill -0 "$pid" 2>/dev/null || return
    sleep 0.1
    (( i++ ))
  done
  kill -KILL "$pid" 2>/dev/null
}

# --- Commands ---

case "$1" in
  build)
    mvn compile -q
    ;;

  list)
    echo "Available main classes:"
    find_main_classes
    ;;

  start)
    shift
    if [[ -z "$1" ]]; then
      # Interactive selection via fzf
      classes=$(find_main_classes)
      if [[ -z "$classes" ]]; then
        echo "No main classes found in src/main/java"
        exit 1
      fi
      selected=$(select_with_fzf "Select main class:" "$classes")
      if [[ -z "$selected" ]]; then
        echo "No class selected"
        exit 1
      fi
      run_java "$selected"
    else
      # Try loading as config first
      if load_config "$1"; then
        shift
        run_java "$MAIN_CLASS" "${PROGRAM_ARGS[@]}" "$@"
      else
        run_java "$@"
      fi
    fi
    ;;

  save)
    # jrun save myapp com.example.App --port 8080
    save_config "$2" "${@:3}"
    ;;

  rerun)
    if [[ -f "$LAST_RUN" ]]; then
      mapfile -t _rerun_args < "$LAST_RUN"
      run_java "${_rerun_args[@]}"
    else
      echo "No previous run found"
      exit 1
    fi
    ;;

  status)
    running=$(list_running)
    if [[ -z "$running" ]]; then
      echo "No tracked processes running"
    else
      echo "Running processes:"
      while read -r class pid; do
        echo "  $class (PID $pid)"
      done <<< "$running"
    fi
    ;;

  kill)
    shift
    if [[ -n "$1" ]]; then
      # Kill specific class
      pf=$(pid_file "$1")
      if [[ -f "$pf" ]]; then
        pid=$(<"$pf")
        echo "Stopping $1 (PID $pid)..."
        graceful_kill "$pid"
        rm -f "$pf"
        echo "Stopped."
      else
        echo "No PID file for $1"
        exit 1
      fi
    else
      running=$(list_running)
      if [[ -z "$running" ]]; then
        echo "No tracked processes running"
        exit 0
      fi
      # Count lines
      count=$(echo "$running" | wc -l)
      if (( count == 1 )); then
        read -r class pid <<< "$running"
        echo "Stopping $class (PID $pid)..."
        graceful_kill "$pid"
        rm -f "$(pid_file "$class")"
        echo "Stopped."
      else
        # Interactive selection
        classes=$(echo "$running" | awk '{print $1}')
        selected=$(select_with_fzf "Select process to kill:" "$classes")
        if [[ -z "$selected" ]]; then
          echo "No process selected"
          exit 1
        fi
        pid=$(echo "$running" | awk -v c="$selected" '$1==c {print $2}')
        echo "Stopping $selected (PID $pid)..."
        graceful_kill "$pid"
        rm -f "$(pid_file "$selected")"
        echo "Stopped."
      fi
    fi
    ;;

  *)
    cat <<EOF
Usage: jrun <command> [options]

Commands:
  build                    Compile (mvn compile -q)
  list                     List all main classes in project
  start [class] [args]     Run main class (interactive if no class given)
  start <config> [args]    Run saved configuration
  save <name> <class> [args]  Save run configuration
  rerun                    Run last command again
  status                   Show tracked running processes
  kill [class]             Gracefully stop process (interactive if no class given)

Examples:
  jrun start com.example.App --port 8080
  jrun save app com.example.App --port 8080
  jrun start app
  jrun rerun
  jrun status
  jrun kill
EOF
    ;;
esac
