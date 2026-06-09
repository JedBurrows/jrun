# Lazygit-style Dashboard TUI Implementation Plan (Phase 4)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the unified, lazygit-style dashboard TUI: three panels (Configs / Running / Main classes) with a detail pane, vim + arrow navigation, a context-sensitive hint bar, a `?` help overlay, and per-panel actions (start / start-debug / edit / delete / kill / logs / save-as-config) — all driven through `JrunApi`. Launched by `jrun ui`, and by bare `jrun` when attached to an interactive terminal.

**Architecture:** Keep all decision logic in PURE, unit-tested modules (a `resolveKey` keymap and a navigation reducer), and keep the Ink/React components thin renderers that call `JrunApi` (no raw `fs`/process work in components, except the deliberate `$EDITOR` spawn which is lifted into the command layer via an exit-intent loop). The `ui` command builds a `JrunApi` from the live Effect runtime, renders the `Dashboard`, and runs an outer loop so actions that must leave the alt-screen (edit in `$EDITOR`) suspend and resume the TUI cleanly.

**Tech Stack:** TypeScript, Ink 6 / React 19, Effect (`Runtime`, `@effect/cli`), Vitest + `ink-testing-library`.

**Prerequisite:** Phase 3 (`JrunApi` seam) merged or stacked underneath. This branch (`feat/dashboard-tui`) is stacked on `feat/jrun-api-seam`; rebase onto `main` once Phase 3 (PR #3) merges.

---

## Keymap (the contract — note the spec correction)

The design spec listed `k` = kill, but `k` is **vim-up** in the navigation table — a collision. lazygit keeps `j`/`k` as universal up/down. **Resolution: kill is bound to `x` in the Running panel** (memorable as "terminate"; never collides with `j`/`k` nav or the config `d` delete). The save-as-config `w` and Enter-for-logs resolutions from the spec stand.

**Normal-mode keys (panel-agnostic nav + global):**

| Key(s) | Action |
|---|---|
| `j` / ↓ | move selection down |
| `k` / ↑ | move selection up |
| `l` / `Tab` / → | next panel |
| `h` / `Shift-Tab` / ← | previous panel |
| `1` `2` `3` | focus Configs / Running / Main classes |
| `g` / `G` | top / bottom of list |
| `r` | refresh all data |
| `?` | open help overlay |
| `q` | quit |
| `Esc` | (normal mode: no-op; in overlays/prompts: cancel) |

**Per-panel action keys (shown contextually in the hint bar):**

| Panel | Keys |
|---|---|
| Configs | `Enter`/`s` start · `S` start-debug · `e` edit · `d` delete |
| Running | `Enter` logs · `x` kill |
| Main classes | `Enter`/`s` start · `S` start-debug · `w` save-as-config |

Actions are semantic; the `Dashboard` validates an action against the focused panel and ignores ones that don't apply (e.g. `x` outside Running). The hint bar only advertises keys valid for the focused panel.

---

## File Map

| File | Responsibility |
|---|---|
| `src/tui/dashboard/types.ts` | `Panel`, `Action`, `Mode`, `DashboardData`, `NavState` types |
| `src/tui/dashboard/keymap.ts` | PURE `resolveKey(input, key, panel): Action \| null` (normal mode) |
| `src/tui/dashboard/navigation.ts` | PURE `reduceNav(nav, action, data): NavState` (focus + per-panel selection, clamping) |
| `src/tui/dashboard/Dashboard.tsx` | Orchestrator: data via `JrunApi`, mode/overlay state, `useInput`, renders everything |
| `src/tui/dashboard/Panels.tsx` | Left column of three panels with selection highlight (lazygit look) |
| `src/tui/dashboard/DetailPane.tsx` | Right pane: details for the focused panel's selected row |
| `src/tui/dashboard/StatusBar.tsx` | Context-sensitive hint bar + transient messages |
| `src/tui/dashboard/HelpOverlay.tsx` | `?` overlay listing all keys |
| `src/tui/dashboard/Prompts.tsx` | `ConfirmPrompt` (y/N) and `TextPrompt` (save-as name) |
| `src/tui/dashboard/LogView.tsx` | Snapshot log viewer (reads via `JrunApi.readLog`) |
| `src/api/JrunApi.ts` | add `readLog(mainClass): Promise<string \| null>` |
| `src/commands/ui.ts` | `jrun ui` command + the exit-intent loop (TTY guard, `$EDITOR` spawn) |
| `src/commands/configs.ts` | redirect no-subcommand `configs` to the dashboard; remove old `ConfigsTui` launch |
| `src/main.ts` | register `ui`; bare-`jrun` TTY-guarded launch |
| `src/tui/ConfigsTui.tsx` | DELETE (superseded by the dashboard) |
| tests | `keymap.test.ts`, `navigation.test.ts`, `Dashboard.test.tsx` (ink-testing-library), `JrunApi.test.ts` (+readLog) |

**Core types (`src/tui/dashboard/types.ts`):**

```ts
import type { RunConfig } from "../../services/ConfigStore.js";
import type { ProcessRecord } from "../../services/ProcessManager.js";

export type Panel = "configs" | "running" | "mainClasses";
export const PANELS: Panel[] = ["configs", "running", "mainClasses"];

export type Action =
  | { type: "moveUp" } | { type: "moveDown" }
  | { type: "nextPanel" } | { type: "prevPanel" }
  | { type: "focusPanel"; panel: Panel }
  | { type: "top" } | { type: "bottom" }
  | { type: "refresh" } | { type: "help" } | { type: "quit" }
  | { type: "primary" }        // Enter
  | { type: "start" }          // s
  | { type: "startDebug" }     // S
  | { type: "edit" }           // e
  | { type: "delete" }         // d
  | { type: "kill" }           // x
  | { type: "saveAsConfig" };  // w

export interface DashboardData {
  readonly configs: readonly string[];
  readonly running: readonly ProcessRecord[];
  readonly mainClasses: readonly string[];
  readonly configDetails: Readonly<Record<string, RunConfig>>;
}

export interface NavState {
  readonly focused: Panel;
  readonly selected: Readonly<Record<Panel, number>>;  // selection index per panel
}
```

---

## Task 1: Keymap (`resolveKey`) — pure, fully tested

**Files:** Create `src/tui/dashboard/types.ts`, `src/tui/dashboard/keymap.ts`, `test/tui/dashboard/keymap.test.ts`.

- [ ] **Step 1: Write failing tests** (`test/tui/dashboard/keymap.test.ts`). `resolveKey(input: string, key: KeyFlags, panel: Panel)` where `KeyFlags` mirrors Ink's `Key` (the booleans we use: `upArrow,downArrow,leftArrow,rightArrow,tab,shift,return,escape`). Cover:
  - vim/arrow equivalence: `resolveKey("j", {}, "configs")` and `resolveKey("", {downArrow:true}, "configs")` both → `{type:"moveDown"}`; `k`/`upArrow` → `moveUp`.
  - panel switching: `l`, `{tab:true}`, `{rightArrow:true}` → `nextPanel`; `h`, `{tab:true,shift:true}`, `{leftArrow:true}` → `prevPanel`.
  - `1`/`2`/`3` → `focusPanel` configs/running/mainClasses.
  - `g`→top, `G`→bottom (capital G via input==="G").
  - `r`→refresh, `?`→help, `q`→quit, `{return:true}`→primary.
  - per-panel: in `configs`, `s`→start, `S`→startDebug, `e`→edit, `d`→delete; `x`→null (kill invalid here). In `running`, `x`→kill; `s`→null, `d`→null. In `mainClasses`, `s`→start, `S`→startDebug, `w`→saveAsConfig.
  - unknown key → `null`.

  Example:
  ```ts
  import { describe, it, expect } from "vitest";
  import { resolveKey } from "../../../src/tui/dashboard/keymap.js";

  const K = (o: Partial<Record<string, boolean>> = {}) => o as any;

  it("maps j and downArrow to moveDown", () => {
    expect(resolveKey("j", K(), "configs")).toEqual({ type: "moveDown" });
    expect(resolveKey("", K({ downArrow: true }), "configs")).toEqual({ type: "moveDown" });
  });
  it("binds kill to x only in the running panel", () => {
    expect(resolveKey("x", K(), "running")).toEqual({ type: "kill" });
    expect(resolveKey("x", K(), "configs")).toBeNull();
  });
  ```

- [ ] **Step 2: Run, confirm FAIL.** `pnpm test:run -- test/tui/dashboard/keymap.test.ts`

- [ ] **Step 3: Implement `types.ts` (as above) and `keymap.ts`.** `resolveKey` first handles nav/global keys (panel-agnostic), then a per-panel action lookup. Capital letters come through `input` (`"S"`, `"G"`); do NOT rely on `key.shift` for letters. Return `null` for anything unmapped.

  Sketch:
  ```ts
  export interface KeyFlags {
    upArrow?: boolean; downArrow?: boolean; leftArrow?: boolean; rightArrow?: boolean;
    tab?: boolean; shift?: boolean; return?: boolean; escape?: boolean;
  }
  const PANEL_ACTIONS: Record<Panel, Record<string, Action>> = {
    configs:     { s:{type:"start"}, S:{type:"startDebug"}, e:{type:"edit"}, d:{type:"delete"} },
    running:     { x:{type:"kill"} },
    mainClasses: { s:{type:"start"}, S:{type:"startDebug"}, w:{type:"saveAsConfig"} },
  };
  export const resolveKey = (input: string, key: KeyFlags, panel: Panel): Action | null => {
    if (key.downArrow || input === "j") return { type: "moveDown" };
    if (key.upArrow || input === "k") return { type: "moveUp" };
    if (key.rightArrow || (key.tab && !key.shift) || input === "l") return { type: "nextPanel" };
    if (key.leftArrow || (key.tab && key.shift) || input === "h") return { type: "prevPanel" };
    if (input === "1") return { type: "focusPanel", panel: "configs" };
    if (input === "2") return { type: "focusPanel", panel: "running" };
    if (input === "3") return { type: "focusPanel", panel: "mainClasses" };
    if (input === "g") return { type: "top" };
    if (input === "G") return { type: "bottom" };
    if (input === "r") return { type: "refresh" };
    if (input === "?") return { type: "help" };
    if (input === "q") return { type: "quit" };
    if (key.return) return { type: "primary" };
    return PANEL_ACTIONS[panel][input] ?? null;
  };
  ```
  (Note: `Tab` arrives with `key.tab`; Ink sets `key.shift` for Shift-Tab. Verify against Ink 6's `Key` type and adjust.)

- [ ] **Step 4: Run, confirm PASS.** Then `pnpm typecheck`.

- [ ] **Step 5: Commit.** `git add src/tui/dashboard/types.ts src/tui/dashboard/keymap.ts test/tui/dashboard/keymap.test.ts && git commit -m "feat: pure keymap for dashboard (vim + arrows, per-panel actions)"`

---

## Task 2: Navigation reducer — pure, fully tested

**Files:** Create `src/tui/dashboard/navigation.ts`, `test/tui/dashboard/navigation.test.ts`.

- [ ] **Step 1: Write failing tests.** `reduceNav(nav: NavState, action: Action, data: DashboardData): NavState` handles ONLY the navigation actions (moveUp/moveDown/next/prevPanel/focusPanel/top/bottom); all other actions return `nav` unchanged. Cover:
  - `moveDown` increments the focused panel's selection, clamped to `len-1`; `moveUp` clamped to `0`.
  - moving with an empty list keeps selection at `0`.
  - `nextPanel`/`prevPanel` cycle focus through `["configs","running","mainClasses"]` (wrap or clamp — choose CLAMP at both ends, i.e. no wrap, and assert that).
  - `focusPanel` sets focus directly.
  - `top`→0, `bottom`→`len-1` for the focused panel.
  - selection is independent per panel (moving in configs doesn't change running's index).
  - clamping uses the right list length per panel (configs→data.configs.length, running→data.running.length, mainClasses→data.mainClasses.length).

- [ ] **Step 2: Run, confirm FAIL.**

- [ ] **Step 3: Implement `reduceNav`.** A helper `lenOf(panel, data)` selects the right array length. `moveDown`: `Math.min(sel+1, max(len-1,0))`. Initial nav: `{ focused:"configs", selected:{configs:0,running:0,mainClasses:0} }` (export an `initialNav`).

- [ ] **Step 4: Run, confirm PASS.** Then `pnpm typecheck`.

- [ ] **Step 5: Commit.** `git commit -m "feat: pure navigation reducer for dashboard panels"`

---

## Task 3: `JrunApi.readLog` for the in-TUI log viewer

**Files:** Modify `src/api/JrunApi.ts`, `test/api/JrunApi.test.ts`.

- [ ] **Step 1: Write a failing test.** Add `readLog(mainClass): Promise<string | null>` returning the contents of the running record's `logFile`, or `null` if the class isn't running / has no log file / the file is missing. Test the `null` path (no running process → `null`) using the existing JrunApi test harness; the happy path needs a real detached run (skip — covered manually).

- [ ] **Step 2: Run, confirm FAIL.**

- [ ] **Step 3: Implement.** Add to the interface and `makeJrunApi`. It needs `FileSystem` — run an Effect that gets `ProcessManagerService.listRunning`, finds the record by `mainClass`, and if it has a `logFile`, reads it via `FileSystem.FileSystem` (`yield* FileSystem.FileSystem`), returning `null` when absent/unreadable (`Effect.catchAll(() => Effect.succeed(null))` around the read). Note `Services` must now include `FileSystem` in the runtime — but the runtime already has it via `NodeContext.layer`; widen the `Services` type to include `FileSystem.FileSystem` OR access it through the existing context (it's present in AppLayer's runtime). Verify the type; if needed add `| FileSystem.FileSystem` to `Services`.

- [ ] **Step 4: Run, confirm PASS.** `pnpm test:run`, `pnpm typecheck`.

- [ ] **Step 5: Commit.** `git commit -m "feat: add JrunApi.readLog for the dashboard log viewer"`

---

## Task 4: Dashboard data + render skeleton (panels + detail + status bar)

**Files:** Create `Dashboard.tsx`, `Panels.tsx`, `DetailPane.tsx`, `StatusBar.tsx`; test `test/tui/dashboard/Dashboard.test.tsx`.

- [ ] **Step 1: Write a failing render test** with `ink-testing-library`. Pass a STUB `JrunApi` (a plain object whose methods return resolved Promises with fixed data — no real services). Assert that after an initial async load+tick, `lastFrame()` contains the panel titles ("Configs", "Running", "Main classes") and seeded data (a config name, a running mainClass, a discovered class). Example:
  ```ts
  import { render } from "ink-testing-library";
  import { Dashboard } from "../../../src/tui/dashboard/Dashboard.js";
  const stubApi = { listConfigs: async () => ["alpha"], loadConfig: async () => ({mainClass:"com.x.A",programArgs:[],jvmOpts:[]}), listRunning: async () => [{pid:1,mainClass:"com.x.Server",startedAt:null,logFile:null,args:[],debugPort:null,detached:true}], listMainClasses: async () => ["com.x.A","com.x.B"], /* others as no-ops */ } as any;
  // render(<Dashboard api={stubApi} onExit={()=>{}} />); flush microtasks; expect(lastFrame()).toContain("Running");
  ```
  (Flush pending promises — `await delay(0)` / `await Promise.resolve()` a couple times — before asserting, since data loads in an effect.)

- [ ] **Step 2: Run, confirm FAIL.**

- [ ] **Step 3: Implement the skeleton.**
  - `Dashboard({ api, onExit })`: on mount, load all data (`Promise.all([listConfigs→configDetails, listRunning, listMainClasses])`) into state; hold `nav` (useState, `initialNav`) and `data`; a `loading`/`error` flag; a transient `message`. Provide a `refresh()` that reloads. For now wire `useInput` minimally: `q` → `onExit({type:"quit"})`; full action handling comes in Task 6. (Use `resolveKey` already for nav so navigation works now.)
  - On each key: `const action = resolveKey(input, key, nav.focused)`; if it's a nav action → `setNav(reduceNav(nav, action, data))`; if `quit` → `onExit`; if `refresh` → `refresh()`. Ignore the rest for now.
  - `Panels`: renders the three panels in a left `<Box flexDirection="column">`, each a bordered box; the focused panel gets a highlighted border color; the selected row in each panel is marked (▶ + color). `running` rows show `mainClass (PID n)` + `[debug:p]` when set; `configs` rows show the name; `mainClasses` rows show the FQCN.
  - `DetailPane`: right box; for the focused panel's selected item show details (config → mainClass/programArgs/jvmOpts; running → pid/startedAt/args/logFile/debugPort; mainClass → the FQCN).
  - `StatusBar`: bottom line; for now show the focused panel's valid keys (hardcode per panel for this task; Task 5 makes it the single source) and any transient `message`.

- [ ] **Step 4: Run, confirm PASS.** `pnpm typecheck`, `pnpm test:run`.

- [ ] **Step 5: Commit.** `git commit -m "feat: dashboard data loading + panels/detail/status render"`

---

## Task 5: Help overlay + context hint bar

**Files:** Create `HelpOverlay.tsx`; finalize `StatusBar.tsx`; modify `Dashboard.tsx`. Extend `Dashboard.test.tsx`.

- [ ] **Step 1: Write a failing test.** After rendering and sending `?`, `lastFrame()` shows the help overlay (contains "start", "kill", "save", "quit", and the nav keys). Sending `?` or `Esc`/`q` again hides it. (Drive input via the test renderer's `stdin.write`.)

- [ ] **Step 2: Run, confirm FAIL.**

- [ ] **Step 3: Implement.** Add a `mode: "normal" | "help" | ...` to Dashboard state. `?` → `help`; in `help` mode any of `?`/`Esc`/`q` → back to `normal` (and the keymap is bypassed in help mode — Dashboard handles it before delegating). `HelpOverlay` lists the full keymap grouped (Navigation, Configs, Running, Main classes, Global). Make `StatusBar` derive the hint text from a single exported `hintsFor(panel)` map (also reused by the help overlay) so hints never drift from the keymap.

- [ ] **Step 4: Run, confirm PASS.** typecheck + suite.

- [ ] **Step 5: Commit.** `git commit -m "feat: dashboard help overlay and context hint bar"`

---

## Task 6: Action wiring (start / debug / delete / kill / save-as / logs / edit)

**Files:** Modify `Dashboard.tsx`; create `Prompts.tsx`, `LogView.tsx`. Extend `Dashboard.test.tsx`.

- [ ] **Step 1: Write failing tests** (with the stub api spying on calls):
  - In Configs, `s` (or Enter) calls `api.start({ configName: <selected> })` (detached defaults true) and shows a success message; `S` calls `api.start({ configName, debug:{port:5005, suspend:false} })`.
  - In Main classes, `s`/Enter calls `api.start({ mainClass: <selected> })`; `S` with debug; `w` enters a text prompt, and typing a name + Enter calls `api.saveConfig(name, {mainClass:<selected>, programArgs:[],jvmOpts:[]})`.
  - In Configs, `d` enters confirm mode; `y` calls `api.deleteConfig(<selected>)` then refreshes; `n`/`Esc` cancels without calling.
  - In Running, `x` enters confirm mode; `y` calls `api.kill(<selected mainClass>)` then refreshes.
  - In Running, `Enter` calls `api.readLog(<selected>)` and shows the log view containing the returned text; `q`/`Esc` closes it.
  Use the stub api with vitest `vi.fn()` mocks; assert calls + that a refresh re-pulls data.

- [ ] **Step 2: Run, confirm FAIL.**

- [ ] **Step 3: Implement action handling.** In `Dashboard`, after `resolveKey`, switch on the action for the focused panel:
  - `start`/`primary`(non-running): build `StartSpec` (configName for Configs, mainClass for Main classes) and `await api.start(spec)`; on success set message `Started <class> (PID …)`, then `refresh()`. Wrap in try/catch → show `err.message` in the status bar (red).
  - `startDebug`: same but `debug:{ port: 5005, suspend: false }`.
  - `delete` (Configs) / `kill` (Running): set `mode:"confirm"` with a pending action; `ConfirmPrompt` shows `Delete "x"? (y/N)` / `Kill com.x.Server? (y/N)`. `y` → run `api.deleteConfig`/`api.kill`, refresh, message; else cancel.
  - `saveAsConfig` (Main classes): `mode:"prompt"`; `TextPrompt` collects a name (Ink `useInput` or a controlled `<TextInput>`-style — implement a minimal controlled text field with `useInput` appending printable chars, Backspace deletes, Enter submits, Esc cancels); on submit `await api.saveConfig(name, {mainClass:<selected>, programArgs:[], jvmOpts:[]})`, refresh.
  - `primary` in Running → logs: `await api.readLog(mainClass)`; `mode:"logs"`; `LogView` renders the text (or "(no log)"), `q`/`Esc`/`r`(reload) handled in logs mode.
  - `edit` (Configs) → `onExit({ type:"edit", name:<selected> })` (the command layer spawns `$EDITOR` then relaunches — Task 7). Do NOT spawn the editor inside React.
  - All async actions: while pending, ignore further input or show a brief "…"; keep it simple (a boolean `busy`). Catch errors → status bar.
  Modes (`confirm`/`prompt`/`logs`/`help`) are handled at the TOP of `useInput` BEFORE `resolveKey`, so the keymap only runs in `normal` mode.

- [ ] **Step 4: Run, confirm PASS.** typecheck + full suite.

- [ ] **Step 5: Commit.** `git commit -m "feat: dashboard actions — start/debug/delete/kill/save-as/logs"`

---

## Task 7: `jrun ui` command + bare-`jrun` TTY launch + retire ConfigsTui

**Files:** Create `src/commands/ui.ts`; modify `src/main.ts`, `src/commands/configs.ts`; delete `src/tui/ConfigsTui.tsx`.

- [ ] **Step 1: Implement the `ui` command + exit-intent loop.** `src/commands/ui.ts` exports `ui = Command.make("ui", {}, () => uiEffect)`. `uiEffect` (an `Effect.gen`):
  - Obtain the runtime via `Effect.runtime<Services>()` and `const api = makeJrunApi(runtime)` (same pattern as the migrated configs handler).
  - Loop: render the `Dashboard` with `render(<Dashboard api={api} onExit={resolve}/>)`, await an exit intent (`{type:"quit"} | {type:"edit", name}`) via a Promise the `onExit` resolves; `waitUntilExit()` then inspect the intent. If `edit`: `cp.spawnSync($EDITOR, [configPathFor(name)], {stdio:"inherit"})`, then loop again (re-render). If `quit`: break. (`configPathFor` = the `~/.jrun/configs/<name>.json` path — or, better, expose the path via a tiny helper; raw path here is acceptable since it's the command/process layer, not React.)
  - Provide a helper `runDashboard(api): Promise<ExitIntent>` that wraps one render+waitUntilExit cycle.
- [ ] **Step 2: Register + TTY guard.** In `src/main.ts`: add `ui` to `withSubcommands`. For bare `jrun` (no subcommand), set the root command handler to launch the dashboard **only when `process.stdout.isTTY && process.stdin.isTTY`**; otherwise print help (the default). Implement by giving `Command.make("jrun", {}, handler)` a handler that checks `isTTY` → run the same `uiEffect` (export it from `ui.ts`), else show help via `@effect/cli`'s help mechanism (or print a short usage line and return). Verify how to render help programmatically in `@effect/cli`; if awkward, on non-TTY print a one-line "run `jrun --help`" message and return 0.
- [ ] **Step 3: Redirect `configs` no-subcommand to the dashboard.** In `configs.ts`, replace the `configsTui` body so the no-subcommand `configs` launches the dashboard (reuse `uiEffect`) instead of the old `ConfigsTui`. Remove the `ConfigsTui` import/usage and the `render(React.createElement(ConfigsTui, …))` block. Delete `src/tui/ConfigsTui.tsx`. Keep `configs list/show/edit/delete` subcommands unchanged.
- [ ] **Step 4: Verify.** `pnpm typecheck`, `pnpm build`. Manual (sandbox can't drive interactive Ink, but CAN verify the guard):
  - `node dist/main.js ui < /dev/null` or piped → must NOT hang; on a non-TTY it should either print help/usage and exit, or exit cleanly. Confirm it does not block. (Ink raw-mode on non-TTY throws — the TTY guard must prevent ever rendering on a non-TTY. For the explicit `jrun ui` on a non-TTY, print "jrun ui requires an interactive terminal" and exit non-zero rather than crashing.)
  - `echo | node dist/main.js` (bare, non-TTY) → prints help/usage, exits 0, does not hang.
  - Confirm `node dist/main.js --help` still lists `ui`.
- [ ] **Step 5: Commit.** `git commit -m "feat: jrun ui command, bare-jrun TTY launch; retire standalone ConfigsTui"`

---

## Task 8: Docs + full gate

**Files:** `README.md`, `CLAUDE.md`.

- [ ] **Step 1: Full gate.** `pnpm test:run && pnpm typecheck && pnpm lint && pnpm build` — all green; fix any biome findings in new files.
- [ ] **Step 2: Docs.** README: add a "Dashboard (TUI)" section — `jrun ui` (or bare `jrun` in a terminal) opens the lazygit-style dashboard; document the keymap (vim + arrows, panel switch, the per-panel actions incl. `x` kill and `Enter` logs, `?` help, `q` quit). Note humans use the TUI, agents use the CLI. CLAUDE.md: add `jrun ui` to the quick reference and a one-line keymap pointer.
- [ ] **Step 3: Commit.** `git commit -m "docs: document the dashboard TUI and keymap"`

---

## Spec Coverage

| Spec requirement | Task |
|---|---|
| lazygit-style 3-panel layout + detail pane | 4 |
| vim motions AND arrow keys everywhere | 1 (keymap), tested |
| panel switching (h/l, Tab/S-Tab, 1/2/3), g/G | 1, 2 |
| context-sensitive hint bar | 4, 5 |
| `?` help overlay | 5 |
| Configs: start / start-debug / edit / delete | 6, 7 (edit) |
| Running: kill (rebound `x`) + view logs (Enter) + debug port shown | 4 (detail), 6 |
| Main classes: start / start-debug / save-as-config | 6 |
| `r` refresh, `q` quit, no interval polling | 4, 6 |
| Detached start + debug from the TUI | 6 (via `JrunApi.start`) |
| `jrun` (TTY) / `jrun ui` launches dashboard | 7 |
| Pure reducer/keymap unit-tested; render smoke tests | 1, 2, 4, 5, 6 |
| Remove raw I/O from React (edit lifted to command layer) | 6, 7 |

## Design notes / deviations

- **`k` kill → `x` kill.** Required: `k` is vim-up. Documented in the keymap + help overlay.
- **Debug-start uses default port 5005, no prompt** (TUI ergonomics; the CLI still requires an explicit `--debug <port>`). A port prompt can be a later enhancement.
- **`$EDITOR` editing** is handled by the command-layer exit-intent loop (suspend TUI → spawn editor → resume), keeping React free of process spawning.
- **No live log follow in-TUI** (snapshot via `readLog`, `r` to reload); `jrun logs -f` remains the live-follow path on the CLI. YAGNI.

## Out of Scope

- Interval/live auto-refresh of the Running panel (manual `r` only).
- Mouse support, resizing niceties beyond Ink defaults.
- Editing program args / jvm opts inside the TUI (use `$EDITOR` / `configs edit`).
