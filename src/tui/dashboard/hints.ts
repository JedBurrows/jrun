import type { Panel } from "./types.js";

export interface Hint {
  readonly keys: string;
  readonly label: string;
}

// Global hints shown in every panel's hint bar.
export const GLOBAL_HINTS: readonly Hint[] = [
  { keys: "↑↓/jk", label: "navigate" },
  { keys: "h/l", label: "panel" },
  { keys: "r", label: "refresh" },
  { keys: "?", label: "help" },
  { keys: "q", label: "quit" },
];

// Panel-specific action hints.
export const PANEL_HINTS: Record<Panel, readonly Hint[]> = {
  configs: [
    { keys: "⏎/s", label: "start" },
    { keys: "S", label: "debug" },
    { keys: "e", label: "edit" },
    { keys: "d", label: "delete" },
  ],
  running: [
    { keys: "⏎", label: "logs" },
    { keys: "x", label: "kill" },
  ],
  mainClasses: [
    { keys: "⏎/s", label: "start" },
    { keys: "S", label: "debug" },
    { keys: "w", label: "save" },
  ],
};

export const hintsFor = (panel: Panel): readonly Hint[] => [...PANEL_HINTS[panel], ...GLOBAL_HINTS];
