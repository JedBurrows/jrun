# Responsive lazygit-style Dashboard — Design Spec

**Date:** 2026-06-10
**Status:** Draft (awaiting review)

## Problem

The current TUI renders in a fixed `width={36}` box pinned to the top-left of the terminal: it
does not fill the available space, does not respond to terminal resize, and leads with **Configs**
— the least important thing. Logs are only viewable by an explicit action that swaps to a separate
full-screen mode. The result reads as a cramped form, not a live operations dashboard.

## Goals

1. **Fill the terminal** — full width and height, reflowing on resize (lazygit/vim feel). The TUI
   already owns the alternate screen buffer (`\x1b[?1049h`); the *content* should occupy it.
2. **Reprioritize** — lead with what matters: **Running** processes, then the project's **Targets**
   (runnable main classes), then **Configs** (a power-user convenience).
3. **Logs as the core interaction** — focusing a running process **live-tails its log** in the main
   pane (the "hover to tail" idea), instead of a separate explicit mode.

## Non-goals (YAGNI)

- Mouse support / actual pointer hover (terminal "hover" = the focused row).
- Log search/filter, multi-log split, log scrollback persistence.
- Reworking the action set (start/kill/debug/save keys stay as they are).
- Auto-refreshing `Targets`/`Configs` (they change rarely — refreshed on mount + after mutations).

## Layout

Full-screen, two regions stacked over a status bar:

```
┌─ Running ────────────────────┐┌─ Logs: com.example.ApiServer (PID 5512) ──────────┐
│▶ ApiServer        5512       ││ 12:03:41.882  Started ApiServer on :8097          │
│  ApiServer        5530  ●dbg ││ 12:03:42.104  GET /health → 200                   │
│  DataProcessor    5610       ││ …                                                 │
├─ Targets ────────────────────┤│ 12:03:50.880  GET /users/3 → 404                  │
│  com.example.ApiServer       ││ ▏live · newest at bottom                          │
│  com.example.DataProcessor   ││                                                   │
│  com.example.HelloWorld      ││                                                   │
├─ Configs ────────────────────┤│                                                   │
│  api-dev                     ││                                                   │
│  batch-nightly               ││                                                   │
└──────────────────────────────┘└───────────────────────────────────────────────────┘
 ↑↓ move   ⇥ panel   s run   d debug   k kill   ↵ zoom log   r refresh   ? help
```

- **Root** `<Box flexDirection="column" height={rows} width={cols}>`: a content row (`flexGrow=1`)
  over a one-line status bar.
- **Left column** — clamped width `Math.max(24, Math.min(36, Math.floor(cols * 0.32)))`,
  `flexDirection="column"`, three stacked panels.
- **Left panel heights — weighted split** (not accordion): Running `flexGrow={3}`, Targets
  `flexGrow={2}`, Configs `flexGrow={1}`, each `flexBasis={0}` + `minHeight` ~3 so titles always
  show. Running, the priority, gets the most room; all three are always visible.
- **Right pane** — `flexGrow={1}`, takes all remaining width and full content height.
- **Resize** — a `useTerminalSize()` hook reads `process.stdout.{columns,rows}` and subscribes to
  the `"resize"` event, triggering re-render. All sizing derives from it.

If the terminal is very small (e.g. `< 60` cols or `< 12` rows) fall back to a single stacked
column (left panels only, no side pane) with a hint to enlarge — Ink/Yoga won't crash, but the
split is unreadable below that.

## Information architecture

`Panel` type and ordering change from `["configs","running","mainClasses"]` to
**`["running","targets","configs"]`**. Concretely: the `Panel` union and the `NavState.selected`
keys become `running` / `targets` / `configs`; the `targets` panel reads from the **unchanged**
`DashboardData.mainClasses` field (only the dashboard-facing name changes, not the data shape or
the `JrunApi`). Initial focus is **`running`** (was `configs`). Tab / `h` / `l` cycle panels in the
new order; `j`/`k`/arrows move within.

## Interaction model — follows-focus

The right pane mirrors the focused panel's current selection:

| Focused panel | Right pane shows |
|---|---|
| Running | **Live log tail** of the selected process (`LogTail`) |
| Targets | Class details + run hints (`TargetDetail`) — main class, last-run note, `s run · d debug · S save` |
| Configs | Config details (`ConfigDetail`) — mainClass, programArgs, jvmOpts, `↵ run` |

- **Live tail:** while a running row is focused, poll `api.readLogByPid(mainClass, pid)` on the
  shared tick (~1.5s; see Live data), keep the **last N lines** where `N` = the right pane's content
  height, render newest at the bottom. On focus change / process exit / unmount the tail stops.
  `null`/empty → `"(no log yet)"`. A foreground or marker-but-no-log process → `"(no log file)"`.
- **Fullscreen zoom:** `↵` (or `+`) on a running row enters `mode="logs"` — the existing `LogView`,
  now full-window and **scrollable** (`j`/`k`/arrows line, `PgUp`/`PgDn` page, `g`/`G` top/bottom,
  default pinned to bottom/live). `q`/`esc` returns. This is the place to read a long log; the side
  pane is the glance.
- All existing actions keep their keys and confirm/prompt flows (`s` start, `d` debug, `k` kill by
  PID, `S` save, delete config, edit config). `?` help and the help overlay are unchanged.

## Live data

A single polling effect (one interval, ~1.5s) drives the "live" feel:

- Refreshes **`listRunning`** (so processes that appear/exit elsewhere show up) and, if a running
  row is focused, the **focused log**. Re-clamps selection on shrink (existing `clampNav`).
- Does **not** re-run `listMainClasses`/`listConfigs` each tick (rare to change; refreshed on mount
  and after any mutation, as today).
- Paused while a modal mode is active (`confirm`/`prompt`/`help`) to avoid selection churn under a
  prompt; resumes on return to `normal`. Cleared on unmount.
- Errors from a tick are surfaced in the status line but never crash the loop (mirror existing
  `runMutation` error handling).

## Visual design (frontend-design lens, terminal-adapted)

- **Focus affordance:** focused panel → bright/green rounded border + bold title; unfocused →
  `gray` border + dim title. Exactly one panel focused at a time.
- **Running rows:** `<name>  <pid>` with a debug badge `●dbg` when `debugPort != null`; selected row
  reverse/green highlight + `▶` marker (consistent with today).
- **Right pane header:** contextual title (`Logs: <class> (PID n)` / `Target: <class>` /
  `Config: <name>`) in the accent color.
- **Restraint:** one accent color (green, matching current focus color), consistent 1-col padding,
  section titles; no gratuitous color. Log lines are rendered raw (monospace), trimmed to pane
  width (no wrap — truncate with the terminal's own clipping).

## Component structure

Refactor the 389-line `Dashboard.tsx` into focused units (it's grown to do too much):

- **`Dashboard.tsx`** — stays the orchestrator: state, `useInput`, mode handling, the polling
  effect. Renders `<Box height width>` → `<LeftColumn>` + `<RightPane>` + `<StatusBar>`.
- **`hooks/useTerminalSize.ts`** — `{ columns, rows }`, resize-subscribed. (what: terminal dims;
  deps: `process.stdout`.)
- **`hooks/useLogTail.ts`** — `useLogTail(api, focusedRunning, lines, tick)` → `string[]` (last
  `lines` lines) + loading/empty state. Encapsulates the poll + slice; no-op when no running row is
  focused. (what: live log lines; deps: `JrunApi.readLogByPid`.)
- **`RightPane.tsx`** — switches on `nav.focused`: `LogTail` (running) / `TargetDetail` (targets) /
  `ConfigDetail` (configs). `TargetDetail`/`ConfigDetail` are the current `DetailPane` bodies,
  extracted.
- **`Panels.tsx`** → **`LeftColumn.tsx`** — the three weighted, full-height `PanelBox`es in the new
  order; width from `useTerminalSize`.
- **`LogView.tsx`** — extended for the fullscreen scroll mode (scroll offset state lives in
  `Dashboard`, passed in).
- `navigation.ts` / `keymap.ts` / `types.ts` — update `Panel` ordering/naming and the initial focus;
  add the `↵`/`+` zoom action and the scroll keys for `logs` mode.

This keeps each file small and single-purpose, and the layout/poll logic out of the render path.

## Error handling & edge cases

- Terminal too small → single-column fallback + "enlarge to ≥60×12" hint (no crash).
- Focused process exits mid-tail → next tick drops it from `listRunning`; `clampNav` moves
  selection; pane switches to whatever is now selected. Its log is still readable via fullscreen
  zoom by PID (`readLogByPidAnyClass`) until the user navigates away.
- Empty panels (no running / no targets / no configs) → `(none)` placeholder (as today).
- Very long single log lines → truncated to pane width; full content available in fullscreen zoom.
- Poll error (e.g. transient FS) → status-line note, loop continues.

## Testing

- **`useLogTail`** — unit test with a fake `JrunApi`: returns last-N lines, updates on tick, empties
  when no running row focused, handles `null`. (Pure-ish hook; test with React Testing Library /
  ink-testing-library or by extracting the slice logic as a pure `tailLines(content, n)` function +
  testing that directly.)
- **`tailLines(content, n)`** pure helper — table test (fewer than n, exactly n, more than n, empty,
  trailing newline).
- **`RightPane`** — given `nav.focused` + data, renders the right child (ink-testing-library
  snapshot of which header appears).
- **Navigation/keymap** — existing tests updated for the new panel order + initial focus + the zoom
  action; `reduceNav`/`clampNav` unchanged in logic.
- **Layout/responsiveness** — verified by actually running the TUI at a few terminal sizes (the
  `run` skill) + manual review; Ink/Yoga flexbox isn't meaningfully unit-testable for pixel layout.
- Existing `Dashboard.test.tsx` updated where the render tree shape changed (LeftColumn/RightPane),
  keeping behavioral assertions (kill by pid, log-by-pid).

## Out of scope (future)

- Auto-refresh of Targets/Configs lists.
- Log search/filter, wrap toggle, copy-to-clipboard.
- Accordion (focus-expands) panel mode — weighted split chosen for predictability with 3 panels.
- Mouse/scroll-wheel.
