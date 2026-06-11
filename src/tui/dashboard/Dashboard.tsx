import { Box, Text, useInput } from "ink";
import React, { useCallback, useEffect, useRef, useState } from "react";
import type { JrunApi } from "../../api/JrunApi.js";
import type { RunConfig } from "../../services/ConfigStore.js";
import { HelpOverlay } from "./HelpOverlay.js";
import { LeftColumn } from "./LeftColumn.js";
import { LogView } from "./LogView.js";
import { ConfirmPrompt, TextPrompt } from "./Prompts.js";
import { RightPane } from "./RightPane.js";
import { StatusBar } from "./StatusBar.js";
import { useLogTail } from "./hooks/useLogTail.js";
import { useTerminalSize } from "./hooks/useTerminalSize.js";
import { type KeyFlags, resolveKey } from "./keymap.js";
import { clampNav, initialNav, reduceNav } from "./navigation.js";
import { sameRunning } from "./sameRunning.js";
import type { Action, DashboardData, NavState } from "./types.js";

export type DashboardIntent = { type: "quit" } | { type: "edit"; name: string };

interface Props {
  api: JrunApi;
  onExit: (intent: DashboardIntent) => void;
}

type Mode = "normal" | "help" | "confirm" | "prompt" | "logs";

interface Pending {
  // `verb`/`target` build the imperative confirm prompt ("delete alpha? (y/N)");
  // `done` is the past-tense note shown on success ("Deleted \"alpha\"").
  verb: string;
  target: string;
  done: string;
  run: () => Promise<void>;
}

interface LogState {
  mainClass: string;
  pid: number;
}

const EMPTY: DashboardData = {
  configs: [],
  running: [],
  mainClasses: [],
  configDetails: {},
};

const DEBUG = { port: 5005, suspend: false } as const;

const NAV_ACTIONS = new Set([
  "moveUp",
  "moveDown",
  "nextPanel",
  "prevPanel",
  "focusPanel",
  "top",
  "bottom",
]);

const errMsg = (err: unknown): string => {
  if (err instanceof Error) return err.message;
  const m = (err as { message?: string })?.message;
  return m ?? String(err);
};

export function Dashboard({ api, onExit }: Props) {
  const [data, setData] = useState<DashboardData | null>(null);
  const [nav, setNav] = useState<NavState>(initialNav);
  const [message, setMessage] = useState<string | null>(null);
  const [isError, setIsError] = useState(false);
  const [mode, setMode] = useState<Mode>("normal");
  const [pending, setPending] = useState<Pending | null>(null);
  const [buffer, setBuffer] = useState("");
  const [pendingSaveClass, setPendingSaveClass] = useState<string | null>(null);
  const [log, setLog] = useState<LogState | null>(null);
  const [logOffset, setLogOffset] = useState(0);
  const [busy, setBusy] = useState(false);

  // RF5: terminal size + derived layout must be read above every early return.
  const { columns, rows } = useTerminalSize();
  const leftWidth = Math.max(24, Math.min(36, Math.floor(columns * 0.32)));
  const tooSmall = columns < 60 || rows < 12;

  // RF5: the zoom tail hook is called unconditionally (target null unless in
  // logs mode) so the hook order is stable when toggling into/out of logs mode.
  const zoomTarget = mode === "logs" && log ? { mainClass: log.mainClass, pid: log.pid } : null;
  const zoom = useLogTail(api, zoomTarget, 5000, 1500); // big buffer for scrollback

  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const note = useCallback((msg: string | null, error = false) => {
    if (!mounted.current) return;
    setMessage(msg);
    setIsError(error);
  }, []);

  const refresh = useCallback(async () => {
    const [configs, running, mainClasses] = await Promise.all([
      api.listConfigs(),
      api.listRunning(),
      api.listMainClasses(),
    ]);
    const configDetails: Record<string, RunConfig> = {};
    await Promise.all(
      configs.map(async (name) => {
        const cfg = await api.loadConfig(name);
        if (cfg) configDetails[name] = cfg;
      })
    );
    if (!mounted.current) return;
    const next = { configs, running, mainClasses, configDetails };
    setData(next);
    // Re-clamp selection: a shrink (delete/kill) can leave it past the new end.
    setNav((n) => clampNav(n, next));
  }, [api]);

  useEffect(() => {
    void (async () => {
      try {
        await refresh();
      } catch (err) {
        // Initial load failed: render an empty (but usable/quittable) dashboard
        // and surface the error rather than hanging on "Loading…".
        if (mounted.current) setData(EMPTY);
        note(errMsg(err), true);
      }
    })();
  }, [refresh, note]);

  // Run an async mutation: guard against overlap, surface errors, refresh.
  const runMutation = useCallback(
    async (work: () => Promise<void>, onOk?: () => void) => {
      setBusy(true);
      try {
        await work();
        onOk?.();
        await refresh();
      } catch (err) {
        note(errMsg(err), true);
      } finally {
        if (mounted.current) setBusy(false);
      }
    },
    [refresh, note]
  );

  // Dispatch a normal-mode action to the right JrunApi call / mode transition.
  const runAction = useCallback(
    (action: Action) => {
      const d = data ?? EMPTY;
      switch (nav.focused) {
        case "configs": {
          const name = d.configs[nav.selected.configs];
          if (!name) return;
          if (action.type === "start" || action.type === "primary") {
            note(null);
            void runMutation(
              () => api.start({ configName: name }).then(() => {}),
              () => note(`Started ${name}`)
            );
          } else if (action.type === "startDebug") {
            note(null);
            void runMutation(
              () => api.start({ configName: name, debug: DEBUG }).then(() => {}),
              () => note(`Started ${name} [debug:5005]`)
            );
          } else if (action.type === "edit") {
            onExit({ type: "edit", name });
          } else if (action.type === "delete") {
            setPending({
              verb: "delete",
              target: name,
              done: `Deleted "${name}"`,
              run: () => api.deleteConfig(name),
            });
            setMode("confirm");
          }
          return;
        }
        case "running": {
          const rec = d.running[nav.selected.running];
          if (!rec) return;
          if (action.type === "primary") {
            note(null); // clear any stale error before showing the zoom pane
            setLog({ mainClass: rec.mainClass, pid: rec.pid });
            setLogOffset(0);
            setMode("logs");
          } else if (action.type === "kill") {
            setPending({
              verb: "kill",
              target: `${rec.mainClass} (PID ${rec.pid})`,
              done: `Killed ${rec.mainClass} (PID ${rec.pid})`,
              run: () => api.kill(rec.pid),
            });
            setMode("confirm");
          }
          return;
        }
        case "mainClasses": {
          const fqcn = d.mainClasses[nav.selected.mainClasses];
          if (!fqcn) return;
          if (action.type === "start" || action.type === "primary") {
            note(null);
            void runMutation(
              () => api.start({ mainClass: fqcn }).then(() => {}),
              () => note(`Started ${fqcn}`)
            );
          } else if (action.type === "startDebug") {
            note(null);
            void runMutation(
              () => api.start({ mainClass: fqcn, debug: DEBUG }).then(() => {}),
              () => note(`Started ${fqcn} [debug:5005]`)
            );
          } else if (action.type === "saveAsConfig") {
            // Fix the target at the moment of choice, mirroring the confirm
            // Pending pattern — don't re-read selection at submit time.
            setPendingSaveClass(fqcn);
            setBuffer("");
            setMode("prompt");
          }
          return;
        }
      }
    },
    [nav, data, api, runMutation, onExit, note]
  );

  // RF4: poll only the running list. Deps are [api] (stable) so the interval
  // effect below isn't recreated every tick; functional updaters read the
  // latest state without widening deps; the equality gate skips a no-op
  // setData (no new object, no re-render) when nothing changed.
  const refreshRunning = useCallback(async () => {
    const running = await api.listRunning();
    if (!mounted.current) return;
    setData((d) => (!d || sameRunning(d.running, running) ? d : { ...d, running }));
    setNav((n) => {
      const max = Math.max(0, running.length - 1);
      return n.selected.running <= max
        ? n
        : { ...n, selected: { ...n.selected, running: Math.min(n.selected.running, max) } };
    });
  }, [api]);

  useEffect(() => {
    // Pause under modal modes so a poll can't churn the selection under a prompt.
    if (mode === "confirm" || mode === "prompt" || mode === "help") return;
    const id = setInterval(() => {
      void refreshRunning().catch(() => {});
    }, 1500);
    return () => clearInterval(id);
  }, [mode, refreshRunning]);

  useInput((input, key) => {
    if (mode === "help") {
      if (input === "?" || key.escape || input === "q") setMode("normal");
      return;
    }

    if (mode === "confirm") {
      if (input === "y" || input === "Y") {
        const p = pending;
        setMode("normal");
        setPending(null);
        if (p) void runMutation(p.run, () => note(p.done));
      } else {
        setMode("normal");
        setPending(null);
      }
      return;
    }

    if (mode === "prompt") {
      if (key.escape) {
        setMode("normal");
        setBuffer("");
        setPendingSaveClass(null);
        return;
      }
      if (key.return) {
        const name = buffer.trim();
        if (name.length === 0) return;
        const fqcn = pendingSaveClass;
        setMode("normal");
        setBuffer("");
        setPendingSaveClass(null);
        if (fqcn) {
          void runMutation(
            () => api.saveConfig(name, { mainClass: fqcn, programArgs: [], jvmOpts: [] }),
            () => note(`Saved config "${name}"`)
          );
        }
        return;
      }
      if (key.backspace || key.delete) {
        setBuffer((b) => b.slice(0, -1));
        return;
      }
      if (input && !key.ctrl && !key.meta) setBuffer((b) => b + input);
      return;
    }

    if (mode === "logs") {
      if (input === "q" || key.escape) {
        setMode("normal");
        setLog(null);
      } else if (input === "j" || key.downArrow) {
        setLogOffset((o) => Math.max(0, o - 1)); // down, toward newest
      } else if (input === "k" || key.upArrow) {
        setLogOffset((o) => Math.min(o + 1, zoom.lines.length)); // up, toward oldest
      } else if (input === "g") {
        setLogOffset(zoom.lines.length); // top (clamped to the top page by logSlice)
      } else if (input === "G") {
        setLogOffset(0); // bottom / live
      }
      return;
    }

    // Normal mode.
    const flags: KeyFlags = {
      upArrow: key.upArrow,
      downArrow: key.downArrow,
      leftArrow: key.leftArrow,
      rightArrow: key.rightArrow,
      tab: key.tab,
      shift: key.shift,
      return: key.return,
      escape: key.escape,
    };
    const action = resolveKey(input, flags, nav.focused);
    if (!action) return;
    if (NAV_ACTIONS.has(action.type)) {
      setNav((n) => reduceNav(n, action, data ?? EMPTY));
      return;
    }
    if (action.type === "quit") {
      onExit({ type: "quit" });
      return;
    }
    if (action.type === "refresh") {
      note(null);
      void runMutation(async () => {});
      return;
    }
    if (action.type === "help") {
      setMode("help");
      return;
    }
    // Action keys are ignored while a mutation is in flight to avoid overlap.
    if (busy) return;
    runAction(action);
  });

  if (data === null) {
    return (
      <Box padding={1}>
        <Text>Loading…</Text>
      </Box>
    );
  }

  if (mode === "help") {
    return (
      <Box flexDirection="column">
        <HelpOverlay />
        <StatusBar panel={nav.focused} message="press ? / Esc / q to close" />
      </Box>
    );
  }

  if (mode === "logs" && log) {
    return (
      <Box flexDirection="column" width={columns} height={rows}>
        <LogView
          mainClass={log.mainClass}
          pid={log.pid}
          lines={zoom.lines}
          offsetFromBottom={logOffset}
        />
        <StatusBar panel={nav.focused} message={isError ? message : null} isError={isError} />
      </Box>
    );
  }

  if (tooSmall) {
    return (
      <Box flexDirection="column" padding={1}>
        <Text>Terminal too small — enlarge to at least 60×12.</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" width={columns} height={rows}>
      <Box flexDirection="row" flexGrow={1}>
        <LeftColumn data={data} nav={nav} width={leftWidth} />
        <RightPane api={api} data={data} nav={nav} tickMs={1500} />
      </Box>
      {mode === "confirm" && pending ? (
        <ConfirmPrompt label={`${pending.verb} ${pending.target}? (y/N)`} />
      ) : mode === "prompt" ? (
        <TextPrompt label="Save as config name:" value={buffer} />
      ) : (
        // Bottom chrome ≤ 2 lines (RF9): optional message line + the status bar.
        <>
          {message !== null && (
            <Box paddingX={1}>
              <Text color={isError ? "red" : "green"} wrap="truncate">
                {message}
              </Text>
            </Box>
          )}
          <StatusBar panel={nav.focused} message={null} />
        </>
      )}
    </Box>
  );
}
