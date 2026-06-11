import type { RunConfig } from "../../services/ConfigStore.js";
import type { ProcessRecord } from "../../services/ProcessManager.js";

export type Panel = "configs" | "running" | "mainClasses";
export const PANELS: Panel[] = ["running", "mainClasses", "configs"];

export type Action =
  | { type: "moveUp" }
  | { type: "moveDown" }
  | { type: "nextPanel" }
  | { type: "prevPanel" }
  | { type: "focusPanel"; panel: Panel }
  | { type: "top" }
  | { type: "bottom" }
  | { type: "refresh" }
  | { type: "help" }
  | { type: "quit" }
  | { type: "primary" }
  | { type: "start" }
  | { type: "startDebug" }
  | { type: "edit" }
  | { type: "delete" }
  | { type: "kill" }
  | { type: "saveAsConfig" };

export interface DashboardData {
  readonly configs: readonly string[];
  readonly running: readonly ProcessRecord[];
  readonly mainClasses: readonly string[];
  readonly configDetails: Readonly<Record<string, RunConfig>>;
}

export interface NavState {
  readonly focused: Panel;
  readonly selected: Readonly<Record<Panel, number>>;
}
