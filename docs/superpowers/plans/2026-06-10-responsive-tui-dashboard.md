# Responsive lazygit-style Dashboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the jrun TUI fill the terminal responsively, lead with Running > Targets > Configs, and live-tail the focused running process's log in a follows-focus main pane (with fullscreen zoom).

**Architecture:** Keep `Dashboard.tsx` as the orchestrator but extract the layout into focused units — pure helpers (`tailLines`/`readSize`/`windowRows`), two hooks (`useTerminalSize`, `useLogTail`), and two components (`LeftColumn`, `RightPane`). The root box sizes to the terminal; the left column holds three weighted, full-height panels; the right pane switches on the focused panel (live log tail / target details / config details). A gentle interval keeps the running list + focused log live.

**Tech Stack:** TypeScript, React + Ink (Yoga flexbox), Vitest + ink-testing-library, Effect (services unchanged).

**Reference spec:** `docs/superpowers/specs/2026-06-10-responsive-tui-dashboard-design.md`

**Branch:** `feat/responsive-tui` (stacked on `feat/process-discovery`, which provides `JrunApi.readLogByPid`).

**Implementation note (deviation from spec, intentional):** the spec proposed renaming the `Panel` union to `running/targets/configs`. To avoid churning every consumer (`navigation`/`keymap`/`hints`/tests), we keep the internal `Panel` ids (`configs`/`running`/`mainClasses`) and instead **reorder `PANELS`, set initial focus to `running`, and relabel the `mainClasses` panel's UI title to "Targets."** Same UX, much smaller diff.

---

## ⚠️ Review Fixes (post architect + devil's-advocate, verified vs ink@6.8.0) — READ FIRST, these OVERRIDE the task bodies below

The reviewers proved (scratch Yoga experiments) that **arithmetic line-budgets diverge from Yoga and `overflow:"hidden"` GARBLES an over-tall box rather than clipping it** — so estimating row counts clobbers the Running title / drops the selected row / drops un-scrollable log lines. The fixes:

**RF1 — `measureElement`, do NOT estimate heights (replaces T6/T7/T10 arithmetic).** Add a tiny hook and use it everywhere a list/log is fit to a pane:
```ts
// src/tui/dashboard/hooks/useElementHeight.ts
import { measureElement, type DOMElement } from "ink";
import { type RefObject, useEffect, useState } from "react";
/** Measured inner height (rows) of a ref'd Ink <Box>. Re-measures every render
 *  (cheap) so it tracks terminal resizes; React bails when the number is stable. */
export const useElementHeight = (ref: RefObject<DOMElement | null>): number => {
  const [h, setH] = useState(0);
  useEffect(() => {
    if (ref.current) setH(measureElement(ref.current).height);
  });
  return h;
};
```
Pattern: give each panel/log area an **inner `<Box ref={ref} flexGrow={1} flexDirection="column" overflow="hidden">`** that fills the space under the title; measure ITS height `h`; then `windowRows(rows.length, selected, h)` (LeftColumn) or `tailLines(content, h)` (RightPane/LogView). The measured height already excludes border+title, so feed it raw (no `-N`). First frame renders `h=0` (empty) then settles next frame — acceptable. This deletes the `cap()`/`logLines`/`view=height-N` math entirely.

**RF2 — `useTerminalSize` must read Ink's `useStdout()`, not global `process.stdout`** (test determinism; a narrow dev terminal under `pnpm test` would otherwise flip the `tooSmall` fallback and fail Dashboard tests). Update T3's hook:
```ts
import { useStdout } from "ink";
// inside useTerminalSize: const { stdout } = useStdout(); read/subscribe on THAT stdout.
```
`readSize` stays pure and tested. (T3 is already committed with `process.stdout` — amend it as part of T8 when it's first consumed, or a tiny follow-up commit.)

**RF3 — `useLogTail` (T4): `setContent(null)` at the top of the effect when the target changes** (avoid a 1-frame stale-log flash on focus switch). Tests: assert only the **initial** poll under `vi.useFakeTimers()` (the plan's 2 tests are fine); do NOT add a later-tick assertion under fake timers — Ink throttles renders behind a real `setTimeout` that fake timers freeze, so it would stay stale. If you must test a later tick, use real timers.

**RF4 — Poll plumbing (T9): `refreshRunning` deps `[api]` only; merge+clamp inside functional `setData`/`setNav` updaters; skip the update when `running` is unchanged** (avoid minting a new object + recreating the interval every 1.5s):
```ts
const refreshRunning = useCallback(async () => {
  const running = await api.listRunning();
  if (!mounted.current) return;
  setData((d) => (d && sameRunning(d.running, running) ? d : d ? { ...d, running } : d));
  setNav((n) => clampNav(n, { configs: [], mainClasses: [], configDetails: {}, ...(/* current */ {}), running } as any));
}, [api]);
```
Use a cheap `sameRunning(a,b)` = same length AND same pids in order. (Keep `clampNav` against the latest data via a functional `setNav` that reads the merged running — simplest is to clamp inside the same `setData` updater and mirror into nav, or store running length in a ref.) Interval effect deps `[mode]` only.

**RF5 — Rules of Hooks (T8/T10):** `useTerminalSize`, `useElementHeight`, and the zoom `useLogTail` must be called **above every early return** (`data===null` / `help` / `logs` / `tooSmall`), and `contentRows`/sizes derived before use. The zoom `useLogTail` is always called with a `target` that is non-null only in logs mode.

**RF6 — Tests leak intervals (T9):** existing Dashboard tests do not `.unmount()`. Add `afterEach(() => instance?.unmount())` (or unmount each render) so the 1.5s interval and listeners don't leak / fire setState-after-unmount.

**RF7 — Zoom of a just-exited process (T10):** the zoom uses `readLogByPid(class, pid)` from the stored target; the log file persists post-exit (named `<hash>-<class>-…-<pid>.log`), so it still resolves — verify in the T11 run. (No need for `readLogByPidAnyClass` here since we still know the class from the row we zoomed from.)

**RF8 — T5 (already in flight):** the panel reorder breaks `Dashboard.test.tsx` interaction tests far beyond "tree shape" (every `s/S/d/e/x/w/Enter` lands on a different panel under the new focus + digit remap). T5's dispatch already folds in migrating `Dashboard.test.tsx` + `keymap.test.ts` in the same commit — confirmed required by both reviewers.

**Confirmed SOUND (don't second-guess):** root `height={rows}`+`flexGrow` fills with no gap and no flicker on modern terminals; `overflow:"hidden"` + `wrap="truncate"` are real in 6.8 and truncate long lines cleanly; `process.stdout.on("resize")` works under raw mode + alt-screen; the fill recipe is Ink-6-idiomatic (omits the trailing newline at full height). The structure ships; only the line-budgeting needed the measured-height fix.

---

---

## File Structure

**New files:**
- `src/tui/dashboard/tailLines.ts` — pure `tailLines(content, n)` (last N non-empty-trailing lines).
- `src/tui/dashboard/windowRows.ts` — pure `windowRows(count, selected, max)` (visible row window to prevent overflow).
- `src/tui/dashboard/hooks/useTerminalSize.ts` — `{columns, rows}` resize-subscribed + pure `readSize`.
- `src/tui/dashboard/hooks/useLogTail.ts` — polls `readLogByPid`, returns last-N lines.
- `src/tui/dashboard/LeftColumn.tsx` — the three weighted, full-height, responsive-width panels.
- `src/tui/dashboard/RightPane.tsx` — switches on focus: `LogTail` / `TargetDetail` / `ConfigDetail`.
- Tests: `test/tui/dashboard/tailLines.test.ts`, `windowRows.test.ts`, `hooks/useLogTail.test.tsx`, `hooks/useTerminalSize.test.ts`.

**Modified files:**
- `src/tui/dashboard/types.ts` — reorder `PANELS`.
- `src/tui/dashboard/navigation.ts` — initial focus `running`.
- `src/tui/dashboard/keymap.ts` — focus-digit order; running `↵` = zoom.
- `src/tui/dashboard/hints.ts` — labels for the new order + zoom.
- `src/tui/dashboard/LogView.tsx` — fullscreen scroll.
- `src/tui/dashboard/Dashboard.tsx` — terminal-filling root, render LeftColumn+RightPane, live poll, zoom mode.
- `src/tui/dashboard/Panels.tsx`, `DetailPane.tsx` — **deleted** (replaced by LeftColumn/RightPane).
- Tests: `test/tui/dashboard/navigation.test.ts`, `Dashboard.test.tsx` — updated for the new order/tree.

Every task keeps the project green (`pnpm typecheck && pnpm build && pnpm test:run`) — this is a single normal branch, no red window.

---

## Task 1: `tailLines` pure helper

**Files:** Create `src/tui/dashboard/tailLines.ts`, `test/tui/dashboard/tailLines.test.ts`.

- [ ] **Step 1: Failing test** (`test/tui/dashboard/tailLines.test.ts`):
```ts
import { describe, expect, test } from "vitest";
import { tailLines } from "../../../src/tui/dashboard/tailLines.js";

describe("tailLines", () => {
  test("null/empty → []", () => {
    expect(tailLines(null, 5)).toEqual([]);
    expect(tailLines("", 5)).toEqual([]);
  });
  test("returns the last n lines", () => {
    expect(tailLines("a\nb\nc\nd", 2)).toEqual(["c", "d"]);
  });
  test("drops a single trailing-newline empty line", () => {
    expect(tailLines("a\nb\n", 5)).toEqual(["a", "b"]);
  });
  test("n >= length returns all", () => {
    expect(tailLines("a\nb", 10)).toEqual(["a", "b"]);
  });
  test("n <= 0 → []", () => {
    expect(tailLines("a\nb", 0)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run, confirm FAIL:** `pnpm test:run test/tui/dashboard/tailLines.test.ts`

- [ ] **Step 3: Implement** (`src/tui/dashboard/tailLines.ts`):
```ts
/** The last `n` lines of `content`, dropping one trailing-newline empty line.
 *  Used to fit a growing log into a fixed-height pane (newest at the bottom). */
export const tailLines = (content: string | null, n: number): string[] => {
  if (!content) return [];
  const lines = content.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return n <= 0 ? [] : lines.slice(-n);
};
```

- [ ] **Step 4: Run, confirm PASS.**

- [ ] **Step 5: Commit:**
```bash
git add src/tui/dashboard/tailLines.ts test/tui/dashboard/tailLines.test.ts
git commit -m "feat(tui): tailLines helper for fitting logs to a pane"
```

---

## Task 2: `windowRows` pure helper

**Files:** Create `src/tui/dashboard/windowRows.ts`, `test/tui/dashboard/windowRows.test.ts`.

Keeps a list's visible rows within a panel's height by returning a `[start, end)` window that always contains the selected index (so long lists don't overflow the flex box and break layout).

- [ ] **Step 1: Failing test:**
```ts
import { describe, expect, test } from "vitest";
import { windowRows } from "../../../src/tui/dashboard/windowRows.js";

describe("windowRows", () => {
  test("everything fits → full range", () => {
    expect(windowRows(3, 0, 10)).toEqual({ start: 0, end: 3 });
  });
  test("scrolls to keep selection visible near the end", () => {
    // 20 rows, max 5 visible, selected 18 → window ends past 18
    const w = windowRows(20, 18, 5);
    expect(w.end - w.start).toBe(5);
    expect(w.start).toBeLessThanOrEqual(18);
    expect(w.end).toBeGreaterThan(18);
  });
  test("selection near start keeps window at 0", () => {
    expect(windowRows(20, 1, 5)).toEqual({ start: 0, end: 5 });
  });
  test("max >= count → full range", () => {
    expect(windowRows(4, 3, 9)).toEqual({ start: 0, end: 4 });
  });
  test("max <= 0 → empty window", () => {
    expect(windowRows(4, 2, 0)).toEqual({ start: 0, end: 0 });
  });
});
```

- [ ] **Step 2: Run, confirm FAIL.**

- [ ] **Step 3: Implement** (`src/tui/dashboard/windowRows.ts`):
```ts
export interface RowWindow {
  readonly start: number;
  readonly end: number;
}

/** A `[start, end)` slice of `count` rows, at most `max` tall, always containing
 *  `selected`. Centers the selection when scrolled into the middle of a long
 *  list so it never overflows a fixed-height panel. */
export const windowRows = (count: number, selected: number, max: number): RowWindow => {
  if (max <= 0) return { start: 0, end: 0 };
  if (max >= count) return { start: 0, end: count };
  let start = selected - Math.floor(max / 2);
  if (start < 0) start = 0;
  if (start + max > count) start = count - max;
  return { start, end: start + max };
};
```

- [ ] **Step 4: Run, confirm PASS.**

- [ ] **Step 5: Commit:**
```bash
git add src/tui/dashboard/windowRows.ts test/tui/dashboard/windowRows.test.ts
git commit -m "feat(tui): windowRows helper to keep panel rows within height"
```

---

## Task 3: `useTerminalSize` hook

**Files:** Create `src/tui/dashboard/hooks/useTerminalSize.ts`, `test/tui/dashboard/hooks/useTerminalSize.test.ts`.

- [ ] **Step 1: Failing test** (tests the pure `readSize`; the resize subscription is thin I/O):
```ts
import { describe, expect, test } from "vitest";
import { readSize } from "../../../../src/tui/dashboard/hooks/useTerminalSize.js";

describe("readSize", () => {
  test("reads columns/rows from a stdout-like object", () => {
    expect(readSize({ columns: 120, rows: 40 } as NodeJS.WriteStream)).toEqual({
      columns: 120,
      rows: 40,
    });
  });
  test("falls back to 80x24 when undefined", () => {
    expect(readSize(undefined)).toEqual({ columns: 80, rows: 24 });
    expect(readSize({} as NodeJS.WriteStream)).toEqual({ columns: 80, rows: 24 });
  });
});
```

- [ ] **Step 2: Run, confirm FAIL.**

- [ ] **Step 3: Implement** (`src/tui/dashboard/hooks/useTerminalSize.ts`):
```ts
import { useEffect, useState } from "react";

export interface TerminalSize {
  readonly columns: number;
  readonly rows: number;
}

/** Read terminal dimensions with sane fallbacks (e.g. a non-TTY). */
export const readSize = (stdout: NodeJS.WriteStream | undefined): TerminalSize => ({
  columns: stdout?.columns ?? 80,
  rows: stdout?.rows ?? 24,
});

/** Terminal size, updating on SIGWINCH ("resize"). */
export const useTerminalSize = (): TerminalSize => {
  const [size, setSize] = useState<TerminalSize>(() => readSize(process.stdout));
  useEffect(() => {
    const onResize = () => setSize(readSize(process.stdout));
    process.stdout.on("resize", onResize);
    return () => {
      process.stdout.off("resize", onResize);
    };
  }, []);
  return size;
};
```

- [ ] **Step 4: Run, confirm PASS.**

- [ ] **Step 5: Commit:**
```bash
git add src/tui/dashboard/hooks/useTerminalSize.ts test/tui/dashboard/hooks/useTerminalSize.test.ts
git commit -m "feat(tui): useTerminalSize hook (responsive, resize-subscribed)"
```

---

## Task 4: `useLogTail` hook

**Files:** Create `src/tui/dashboard/hooks/useLogTail.ts`, `test/tui/dashboard/hooks/useLogTail.test.tsx`.

- [ ] **Step 1: Failing test** (ink-testing-library + fake timers; a fake api):
```tsx
import { render } from "ink-testing-library";
import { Text } from "ink";
import React from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { useLogTail } from "../../../../src/tui/dashboard/hooks/useLogTail.js";
import type { JrunApi } from "../../../../src/api/JrunApi.js";

const makeApi = (text: string | null): JrunApi =>
  ({ readLogByPid: async () => text }) as unknown as JrunApi;

function Probe({ api, target }: { api: JrunApi; target: { mainClass: string; pid: number } | null }) {
  const { lines } = useLogTail(api, target, 2, 1000);
  return <Text>{lines.join("|")}</Text>;
}

describe("useLogTail", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  test("polls readLogByPid and returns the last n lines", async () => {
    const api = makeApi("a\nb\nc");
    const { lastFrame } = render(<Probe api={api} target={{ mainClass: "C", pid: 1 }} />);
    await vi.advanceTimersByTimeAsync(0); // initial poll resolves
    expect(lastFrame()).toBe("b|c");
  });

  test("no target → empty", async () => {
    const api = makeApi("x\ny");
    const { lastFrame } = render(<Probe api={api} target={null} />);
    await vi.advanceTimersByTimeAsync(0);
    expect(lastFrame()).toBe("");
  });
});
```

- [ ] **Step 2: Run, confirm FAIL.**

- [ ] **Step 3: Implement** (`src/tui/dashboard/hooks/useLogTail.ts`):
```ts
import { useEffect, useState } from "react";
import type { JrunApi } from "../../../api/JrunApi.js";
import { tailLines } from "../tailLines.js";

export interface TailTarget {
  readonly mainClass: string;
  readonly pid: number;
}

/** Live-tail a running process's log: polls `readLogByPid` every `tickMs` and
 *  returns the last `lines` lines. No-op (empty) when `target` is null. */
export const useLogTail = (
  api: JrunApi,
  target: TailTarget | null,
  lines: number,
  tickMs: number
): { lines: string[]; empty: boolean } => {
  const [content, setContent] = useState<string | null>(null);

  useEffect(() => {
    if (!target) {
      setContent(null);
      return;
    }
    let cancelled = false;
    const poll = async () => {
      try {
        const text = await api.readLogByPid(target.mainClass, target.pid);
        if (!cancelled) setContent(text);
      } catch {
        /* keep last content on a transient error */
      }
    };
    void poll();
    const id = setInterval(poll, tickMs);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [api, target?.mainClass, target?.pid, tickMs]);

  const out = tailLines(content, lines);
  return { lines: out, empty: content === null || out.length === 0 };
};
```

- [ ] **Step 4: Run, confirm PASS.** (If `ink-testing-library` isn't a dep, check `package.json`; it's already used by `Dashboard.test.tsx`.)

- [ ] **Step 5: Commit:**
```bash
git add src/tui/dashboard/hooks/useLogTail.ts test/tui/dashboard/hooks/useLogTail.test.tsx
git commit -m "feat(tui): useLogTail hook (poll readLogByPid, last-N lines)"
```

---

## Task 5: Reorder panels + relabel + initial focus

**Files:** Modify `src/tui/dashboard/types.ts`, `navigation.ts`, `keymap.ts`, `hints.ts`; Modify `test/tui/dashboard/navigation.test.ts`.

- [ ] **Step 1: Update the failing navigation test first.** In `test/tui/dashboard/navigation.test.ts`, the initial-focus and panel-cycle expectations must change to the new order `running → mainClasses → configs`. Find the assertion(s) about `initialNav.focused` (expect `"running"`) and any `nextPanel`/`prevPanel` ordering, and update them to the new order. Run it → it should FAIL against the current code.

- [ ] **Step 2: `types.ts` — reorder `PANELS`** (the `Panel` union stays the same):
```ts
export const PANELS: Panel[] = ["running", "mainClasses", "configs"];
```

- [ ] **Step 3: `navigation.ts` — initial focus:**
```ts
export const initialNav: NavState = {
  focused: "running",
  selected: { configs: 0, running: 0, mainClasses: 0 },
};
```

- [ ] **Step 4: `keymap.ts` — focus digits follow the new order** (replace the three `focusPanel` lines):
```ts
  if (input === "1") return { type: "focusPanel", panel: "running" };
  if (input === "2") return { type: "focusPanel", panel: "mainClasses" };
  if (input === "3") return { type: "focusPanel", panel: "configs" };
```

- [ ] **Step 5: `hints.ts` — relabel running's primary hint** (the side pane now shows the log; `↵` zooms it fullscreen). Change the `running` hints:
```ts
  running: [
    { keys: "⏎", label: "zoom log" },
    { keys: "x", label: "kill" },
  ],
```

- [ ] **Step 6: Run navigation test, confirm PASS.** Then `pnpm test:run test/tui/dashboard/` — keymap test (if any focus-digit assertions) may need the same reorder; update to match. Then `pnpm typecheck && pnpm build`.

- [ ] **Step 7: Commit:**
```bash
git add src/tui/dashboard/types.ts src/tui/dashboard/navigation.ts src/tui/dashboard/keymap.ts src/tui/dashboard/hints.ts test/tui/dashboard/navigation.test.ts
git commit -m "feat(tui): lead with Running > Targets > Configs"
```

---

## Task 6: `LeftColumn` — full-height, weighted, responsive panels

**Files:** Create `src/tui/dashboard/LeftColumn.tsx`. (We'll delete `Panels.tsx` in Task 8 once Dashboard switches.)

Renders the three panels in the new order, full height with weighted `flexGrow` (Running 3 / Targets 2 / Configs 1), width derived from the terminal, "Main classes" relabelled **"Targets"**, and rows windowed to the panel's height so long lists don't overflow.

- [ ] **Step 1: Implement** (`src/tui/dashboard/LeftColumn.tsx`):
```tsx
import { Box, Text } from "ink";
import React from "react";
import type { ProcessRecord } from "../../services/ProcessManager.js";
import type { DashboardData, NavState, Panel } from "./types.js";
import { windowRows } from "./windowRows.js";

interface Props {
  data: DashboardData;
  nav: NavState;
  width: number;
  contentRows: number; // height available to the whole left column
}

const runningLabel = (r: ProcessRecord): string =>
  `${r.mainClass}  ${r.pid}${r.debugPort ? "  ●dbg" : ""}`;

const rowsFor = (panel: Panel, data: DashboardData): string[] => {
  if (panel === "configs") return [...data.configs];
  if (panel === "running") return data.running.map(runningLabel);
  return [...data.mainClasses];
};

interface PanelBoxProps {
  panel: Panel;
  title: string;
  rows: string[];
  focused: boolean;
  selected: number;
  grow: number;
  maxRows: number;
}

function PanelBox({ panel, title, rows, focused, selected, grow, maxRows }: PanelBoxProps) {
  const win = windowRows(rows.length, selected, maxRows);
  const shown = rows.slice(win.start, win.end);
  return (
    <Box
      flexDirection="column"
      flexGrow={grow}
      flexBasis={0}
      minHeight={3}
      borderStyle="round"
      borderColor={focused ? "green" : "gray"}
      paddingX={1}
      overflow="hidden"
    >
      <Text bold={focused} color={focused ? "green" : "cyan"}>
        {title}
        {rows.length > shown.length ? <Text dimColor>  ({rows.length})</Text> : null}
      </Text>
      {rows.length === 0 ? (
        <Text dimColor>(none)</Text>
      ) : (
        shown.map((row, i) => {
          const idx = win.start + i;
          const isSelected = focused && idx === selected;
          return (
            <Text key={`${panel}-${idx}`} color={isSelected ? "green" : undefined} bold={isSelected} wrap="truncate">
              {isSelected ? "▶ " : "  "}
              {row}
            </Text>
          );
        })
      )}
    </Box>
  );
}

export function LeftColumn({ data, nav, width, contentRows }: Props) {
  // Approximate per-panel row capacity from the 3:2:1 weight split; each panel
  // spends 2 lines on border+title, so subtract them before windowing.
  const cap = (weight: number) => Math.max(1, Math.floor((contentRows * weight) / 6) - 2);
  return (
    <Box flexDirection="column" width={width} flexShrink={0}>
      <PanelBox panel="running" title="Running" rows={rowsFor("running", data)}
        focused={nav.focused === "running"} selected={nav.selected.running} grow={3} maxRows={cap(3)} />
      <PanelBox panel="mainClasses" title="Targets" rows={rowsFor("mainClasses", data)}
        focused={nav.focused === "mainClasses"} selected={nav.selected.mainClasses} grow={2} maxRows={cap(2)} />
      <PanelBox panel="configs" title="Configs" rows={rowsFor("configs", data)}
        focused={nav.focused === "configs"} selected={nav.selected.configs} grow={1} maxRows={cap(1)} />
    </Box>
  );
}
```

- [ ] **Step 2: Typecheck/build:** `pnpm typecheck && pnpm build` (LeftColumn isn't rendered yet — this just confirms it compiles).

- [ ] **Step 3: Commit:**
```bash
git add src/tui/dashboard/LeftColumn.tsx
git commit -m "feat(tui): LeftColumn — weighted full-height responsive panels"
```

---

## Task 7: `RightPane` — follows-focus (log tail / target / config)

**Files:** Create `src/tui/dashboard/RightPane.tsx`.

Switches on the focused panel. Running → `useLogTail` of the selected process; Targets/Configs → the detail bodies lifted from `DetailPane.tsx`.

- [ ] **Step 1: Implement** (`src/tui/dashboard/RightPane.tsx`):
```tsx
import { Box, Text } from "ink";
import React from "react";
import type { JrunApi } from "../../api/JrunApi.js";
import { useLogTail } from "./hooks/useLogTail.js";
import type { DashboardData, NavState } from "./types.js";

interface Props {
  api: JrunApi;
  data: DashboardData;
  nav: NavState;
  logLines: number; // how many tail lines fit the pane
  tickMs: number;
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <Text>
      <Text bold>{label}:</Text> {value}
    </Text>
  );
}

function Frame({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="gray" paddingX={1} flexGrow={1} overflow="hidden">
      <Text bold color="cyan">{title}</Text>
      <Box flexDirection="column" marginTop={1}>{children}</Box>
    </Box>
  );
}

function LogTail({ api, data, nav, logLines, tickMs }: Props) {
  const rec = data.running[nav.selected.running];
  const target = rec ? { mainClass: rec.mainClass, pid: rec.pid } : null;
  const { lines, empty } = useLogTail(api, target, logLines, tickMs);
  if (!rec) return <Frame title="Logs"><Text dimColor>(no process selected)</Text></Frame>;
  return (
    <Frame title={`Logs: ${rec.mainClass} (PID ${rec.pid})`}>
      {empty ? (
        <Text dimColor>(no log yet)</Text>
      ) : (
        lines.map((l, i) => (
          <Text key={i} wrap="truncate">{l}</Text>
        ))
      )}
      <Text dimColor>▏live · ↵ zoom</Text>
    </Frame>
  );
}

function TargetDetail({ data, nav }: Props) {
  const fqcn = data.mainClasses[nav.selected.mainClasses];
  if (!fqcn) return <Frame title="Target"><Text dimColor>(nothing selected)</Text></Frame>;
  return (
    <Frame title={`Target: ${fqcn}`}>
      <Field label="mainClass" value={fqcn} />
      <Text dimColor>s run · S debug · w save</Text>
    </Frame>
  );
}

function ConfigDetail({ data, nav }: Props) {
  const name = data.configs[nav.selected.configs];
  const cfg = name ? data.configDetails[name] : undefined;
  if (!cfg) return <Frame title="Config"><Text dimColor>(nothing selected)</Text></Frame>;
  return (
    <Frame title={`Config: ${name}`}>
      <Field label="mainClass" value={cfg.mainClass} />
      <Field label="programArgs" value={cfg.programArgs.length ? cfg.programArgs.join(" ") : "(none)"} />
      <Field label="jvmOpts" value={cfg.jvmOpts.length ? cfg.jvmOpts.join(" ") : "(none)"} />
      <Text dimColor>⏎/s run · S debug · e edit · d delete</Text>
    </Frame>
  );
}

export function RightPane(props: Props) {
  if (props.nav.focused === "running") return <LogTail {...props} />;
  if (props.nav.focused === "mainClasses") return <TargetDetail {...props} />;
  return <ConfigDetail {...props} />;
}
```

- [ ] **Step 2: Typecheck/build:** `pnpm typecheck && pnpm build`.

- [ ] **Step 3: Commit:**
```bash
git add src/tui/dashboard/RightPane.tsx
git commit -m "feat(tui): RightPane — follows-focus log tail / target / config"
```

---

## Task 8: Dashboard — fill the terminal, render LeftColumn + RightPane

**Files:** Modify `src/tui/dashboard/Dashboard.tsx`; Delete `src/tui/dashboard/Panels.tsx`, `src/tui/dashboard/DetailPane.tsx`; Modify `test/tui/dashboard/Dashboard.test.tsx`.

- [ ] **Step 1: Rewire imports + the normal-mode render.** In `Dashboard.tsx`:
  - Replace `import { Panels } from "./Panels.js";` and `import { DetailPane } from "./DetailPane.js";` with `import { LeftColumn } from "./LeftColumn.js";`, `import { RightPane } from "./RightPane.js";`, and `import { useTerminalSize } from "./hooks/useTerminalSize.js";`.
  - Inside the component, add `const { columns, rows } = useTerminalSize();` near the other hooks, and derive sizes:
```ts
const contentRows = Math.max(3, rows - 1); // minus the status bar line
const leftWidth = Math.max(24, Math.min(36, Math.floor(columns * 0.32)));
const logLines = Math.max(1, contentRows - 4); // borders + title + hint
const tooSmall = columns < 60 || rows < 12;
```
  - Replace the final `return ( <Box flexDirection="column"> <Box flexDirection="row"> <Panels .../> <DetailPane .../> </Box> ... )` block with the terminal-filling version:
```tsx
  if (tooSmall) {
    return (
      <Box flexDirection="column" padding={1}>
        <Text>Terminal too small — enlarge to at least 60×12.</Text>
        <StatusBar panel={nav.focused} message={null} />
      </Box>
    );
  }

  return (
    <Box flexDirection="column" width={columns} height={rows}>
      <Box flexDirection="row" flexGrow={1}>
        <LeftColumn data={data} nav={nav} width={leftWidth} contentRows={contentRows} />
        <RightPane api={api} data={data} nav={nav} logLines={logLines} tickMs={1500} />
      </Box>
      {mode === "confirm" && pending ? (
        <ConfirmPrompt label={`${pending.verb} ${pending.target}? (y/N)`} />
      ) : mode === "prompt" ? (
        <TextPrompt label="Save as config name:" value={buffer} />
      ) : (
        <>
          {message !== null && (
            <Box paddingX={1}>
              <Text color={isError ? "red" : "green"}>{message}</Text>
            </Box>
          )}
          <StatusBar panel={nav.focused} message={null} />
        </>
      )}
    </Box>
  );
```
  (Leave the `help` and `logs` mode returns as they are for now — Task 10 reworks `logs`.)

- [ ] **Step 2: Delete the replaced components:**
```bash
git rm src/tui/dashboard/Panels.tsx src/tui/dashboard/DetailPane.tsx
```

- [ ] **Step 3: Update `Dashboard.test.tsx`.** Its render-tree assertions referenced the old `Panels`/`DetailPane` output. Read the test; update any text/snapshot assertions to the new output (e.g. the "Targets" title instead of "Main classes", running-row label `<class>  <pid>`, the right-pane header `Logs: …`/`Target: …`/`Config: …`). Keep the behavioral assertions (kill calls `api.kill(pid)`, log path calls `api.readLogByPid`). The mock `api` already has `readLogByPid` (from the discovery work); ensure it returns a deterministic string for the log-tail assertions. If a test drove the old full-screen `openLogs` via `↵`, see Task 10 (zoom) — for now keep it asserting the mock call.

- [ ] **Step 4: Verify:** `pnpm typecheck && pnpm build && pnpm test:run test/tui/dashboard/`. The TUI tests must pass. Then full `pnpm test:run`.

- [ ] **Step 5: Visual check (the run skill).** Build, then run the dashboard against the example project and confirm it fills the terminal, leads with Running, and the right pane shows context. (See Task 11 for the exact run recipe — you may do a quick check now.)

- [ ] **Step 6: Commit:**
```bash
git add -A
git commit -m "feat(tui): fill the terminal — LeftColumn + RightPane, responsive root"
```

---

## Task 9: Live poll — keep the running list fresh

**Files:** Modify `src/tui/dashboard/Dashboard.tsx`.

The focused log already live-tails (via `useLogTail` inside `RightPane`). Add a gentle interval that refreshes only the **running list** so processes that start/exit elsewhere appear/disappear without a manual `r`.

- [ ] **Step 1: Add a running-only refresh + interval.** Near `refresh`, add:
```ts
const refreshRunning = useCallback(async () => {
  const running = await api.listRunning();
  if (!mounted.current) return;
  setData((d) => (d ? { ...d, running } : d));
  setNav((n) => clampNav(n, { ...(data ?? EMPTY), running }));
}, [api, data]);
```
Then an effect (pause under modal prompts to avoid selection churn):
```ts
useEffect(() => {
  if (mode === "confirm" || mode === "prompt" || mode === "help") return;
  const id = setInterval(() => {
    void refreshRunning().catch(() => {});
  }, 1500);
  return () => clearInterval(id);
}, [mode, refreshRunning]);
```

- [ ] **Step 2: Verify nothing regresses:** `pnpm typecheck && pnpm build && pnpm test:run test/tui/dashboard/`. (The interval uses real timers; existing tests render once and unmount, so it won't fire — but confirm no test hangs.)

- [ ] **Step 3: Commit:**
```bash
git add src/tui/dashboard/Dashboard.tsx
git commit -m "feat(tui): live-refresh the running list (~1.5s)"
```

---

## Task 10: Fullscreen log zoom (scrollable)

**Files:** Modify `src/tui/dashboard/LogView.tsx`, `src/tui/dashboard/Dashboard.tsx`.

`↵` on a running row already enters `mode="logs"` (the existing `primary` → `openLogs`). Make that view fill the screen and scroll.

- [ ] **Step 1: `LogView.tsx` — accept pre-split lines + a scroll offset and fill height:**
```tsx
import { Box, Text } from "ink";
import React from "react";

interface Props {
  mainClass: string;
  pid: number;
  lines: string[];
  offsetFromBottom: number; // 0 = pinned to newest
  height: number;
}

export function LogView({ mainClass, pid, lines, offsetFromBottom, height }: Props) {
  const view = Math.max(1, height - 3); // border+title+hint
  const end = Math.max(0, lines.length - offsetFromBottom);
  const start = Math.max(0, end - view);
  const shown = lines.slice(start, end);
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1} flexGrow={1} overflow="hidden">
      <Text bold color="cyan">Logs: {mainClass} (PID {pid})</Text>
      <Box flexDirection="column" marginTop={1}>
        {shown.length === 0 ? <Text dimColor>(no log available)</Text> : shown.map((l, i) => <Text key={start + i} wrap="truncate">{l}</Text>)}
      </Box>
      <Box marginTop={1}>
        <Text dimColor>q/Esc close · j/k scroll · g/G top/bottom{offsetFromBottom > 0 ? "  [scrolled]" : "  [live]"}</Text>
      </Box>
    </Box>
  );
}
```

- [ ] **Step 2: `Dashboard.tsx` — drive zoom from `useLogTail` + a scroll offset.**
  - Change `LogState` to carry the target: `interface LogState { mainClass: string; pid: number; }` (drop the stored `text`).
  - Add scroll state: `const [logOffset, setLogOffset] = useState(0);`.
  - When entering logs mode (the `running` `primary` action), set `setLog({ mainClass: rec.mainClass, pid: rec.pid }); setLogOffset(0); setMode("logs");` (replace the old `openLogs` body; the live content now comes from a hook).
  - Compute zoom lines with the existing hook at the top of the component (always called, target only when in logs mode):
```ts
const zoomTarget = mode === "logs" && log ? { mainClass: log.mainClass, pid: log.pid } : null;
const zoom = useLogTail(api, zoomTarget, Math.max(50, contentRows * 3), 1500); // keep a generous buffer to scroll
```
  (Import `useLogTail` at the top.)
  - In the `logs` mode `useInput` branch, handle scrolling: `j`/down → `setLogOffset((o) => o + 1)`; `k`/up → `setLogOffset((o) => Math.max(0, o - 1))`; `g` → `setLogOffset(zoom.lines.length)`; `G` → `setLogOffset(0)`; keep `q`/`esc` close. Remove the old `r` reload (it's live now).
  - Replace the `logs` mode return with:
```tsx
  if (mode === "logs" && log) {
    return (
      <Box flexDirection="column" width={columns} height={rows}>
        <LogView mainClass={log.mainClass} pid={log.pid} lines={zoom.lines} offsetFromBottom={logOffset} height={contentRows} />
        <StatusBar panel={nav.focused} message={isError ? message : null} isError={isError} />
      </Box>
    );
  }
```
  - Delete the now-unused `openLogs`/`reloadLogs` callbacks and the `setLog({…text…})` shape.

- [ ] **Step 3: Update `Dashboard.test.tsx`** if it asserted the old `openLogs`/`reloadLogs` text behavior — assert instead that pressing `↵` on a running row shows the `Logs: <class> (PID <pid>)` zoom header (the mock `readLogByPid` supplies content).

- [ ] **Step 4: Verify:** `pnpm typecheck && pnpm build && pnpm test:run`.

- [ ] **Step 5: Commit:**
```bash
git add -A
git commit -m "feat(tui): fullscreen scrollable live log zoom"
```

---

## Task 11: Visual verification + polish pass + docs

**Files:** Modify `CLAUDE.md` (UI key reference if needed); final visual check.

- [ ] **Step 1: Build + run against the example project** (the `run` skill / manual). The dashboard requires a TTY, so run it interactively:
```bash
pnpm build && cd example && mvn -q compile
# In an interactive terminal:  jrun ui   (or: jrun)
```
Confirm: fills the terminal; Running leads and is focused; `j/k` + `⇥` navigate; focusing a running process live-tails its log on the right; `↵` zooms fullscreen + `j/k` scroll + `q` back; resizing the terminal reflows; small terminal shows the fallback. Start a couple of example processes (`s` on a Target) to exercise the tail.

- [ ] **Step 2: Polish any rough edges found** (spacing, truncation, a title color) — keep changes minimal and re-run the visual check.

- [ ] **Step 3: Update `CLAUDE.md`** if the UI line needs it (the dashboard is still "vim + arrow keys, `?` for help"; add that focusing a running process tails its log, `↵` zooms). Keep it one line.

- [ ] **Step 4: Final full gate:** `pnpm typecheck && pnpm build && pnpm lint && pnpm test:run` — all green.

- [ ] **Step 5: Commit:**
```bash
git add -A
git commit -m "feat(tui): polish + docs for the responsive dashboard"
```

---

## Self-Review Notes (completed)

- **Spec coverage:** fill-terminal (T8, `useTerminalSize` T3), weighted left panels + responsive width + windowing (T6/T2), reorder running-first (T5), follows-focus right pane (T7), live log tail (T4/T7), fullscreen scroll zoom (T10), single-ish live poll — running list (T9) + focused log via `useLogTail` (T4/T7; **deviation from spec's "single loop":** two gentle intervals — the log via the hook, the list via a Dashboard effect — simpler and unnoticeable), visual polish (T6/T7/T11), small-terminal fallback (T8), component refactor + delete Panels/DetailPane (T8). All covered.
- **Type consistency:** `Panel` ids unchanged (`configs`/`running`/`mainClasses`); `TailTarget`/`useLogTail` signature consistent T4→T7→T10; `LeftColumn`/`RightPane` prop shapes consistent with the Dashboard call sites in T8; `LogView` new props (T10) match the Dashboard render.
- **Placeholders:** none — every code step has full content.
- **YAGNI:** no auto-refresh of Targets/Configs, no log search/wrap/mouse — explicitly out of scope.
