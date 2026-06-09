import type { Action, Panel } from "./types.js";

export interface KeyFlags {
  upArrow?: boolean;
  downArrow?: boolean;
  leftArrow?: boolean;
  rightArrow?: boolean;
  tab?: boolean;
  shift?: boolean;
  return?: boolean;
  escape?: boolean;
}

const PANEL_ACTIONS: Record<Panel, Record<string, Action>> = {
  configs: {
    s: { type: "start" },
    S: { type: "startDebug" },
    e: { type: "edit" },
    d: { type: "delete" },
  },
  running: {
    x: { type: "kill" },
  },
  mainClasses: {
    s: { type: "start" },
    S: { type: "startDebug" },
    w: { type: "saveAsConfig" },
  },
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
