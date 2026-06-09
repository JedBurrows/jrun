import type { Action, DashboardData, NavState, Panel } from "./types.js";
import { PANELS } from "./types.js";

export const initialNav: NavState = {
  focused: "configs",
  selected: { configs: 0, running: 0, mainClasses: 0 },
};

const lenOf = (panel: Panel, data: DashboardData): number =>
  panel === "configs"
    ? data.configs.length
    : panel === "running"
      ? data.running.length
      : data.mainClasses.length;

const clampSel = (panel: Panel, idx: number, data: DashboardData): number => {
  const max = Math.max(lenOf(panel, data) - 1, 0);
  return Math.min(Math.max(idx, 0), max);
};

const setSel = (
  nav: NavState,
  panel: Panel,
  idx: number,
  data: DashboardData,
): NavState => ({
  ...nav,
  selected: { ...nav.selected, [panel]: clampSel(panel, idx, data) },
});

/**
 * Pure navigation reducer for the dashboard. Handles only navigation actions
 * (moveUp/moveDown/nextPanel/prevPanel/focusPanel/top/bottom); any other action
 * returns `nav` unchanged. Selection is tracked per panel and clamped to that
 * panel's list length. Panel switching clamps at both ends (no wrap).
 */
export const reduceNav = (
  nav: NavState,
  action: Action,
  data: DashboardData,
): NavState => {
  const cur = nav.selected[nav.focused];
  switch (action.type) {
    case "moveDown":
      return setSel(nav, nav.focused, cur + 1, data);
    case "moveUp":
      return setSel(nav, nav.focused, cur - 1, data);
    case "top":
      return setSel(nav, nav.focused, 0, data);
    case "bottom":
      return setSel(nav, nav.focused, lenOf(nav.focused, data) - 1, data);
    case "nextPanel": {
      const i = Math.min(PANELS.indexOf(nav.focused) + 1, PANELS.length - 1);
      return { ...nav, focused: PANELS[i]! };
    }
    case "prevPanel": {
      const i = Math.max(PANELS.indexOf(nav.focused) - 1, 0);
      return { ...nav, focused: PANELS[i]! };
    }
    case "focusPanel":
      return { ...nav, focused: action.panel };
    default:
      return nav;
  }
};
