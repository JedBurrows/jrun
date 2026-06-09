import { describe, expect, it } from "vitest";
import { initialNav, reduceNav } from "../../../src/tui/dashboard/navigation.js";
import type { DashboardData } from "../../../src/tui/dashboard/types.js";

const data: DashboardData = {
  configs: ["a", "b", "c"],
  running: [
    {
      pid: 1,
      mainClass: "X",
      startedAt: null,
      logFile: null,
      args: [],
      debugPort: null,
      detached: true,
    },
  ],
  mainClasses: ["com.A", "com.B"],
  configDetails: {},
};

const emptyData: DashboardData = {
  configs: [],
  running: [],
  mainClasses: [],
  configDetails: {},
};

describe("initialNav", () => {
  it("starts focused on configs with all selections at 0", () => {
    expect(initialNav).toEqual({
      focused: "configs",
      selected: { configs: 0, running: 0, mainClasses: 0 },
    });
  });
});

describe("reduceNav — moveUp/moveDown", () => {
  it("moveDown increments the focused panel's selection", () => {
    const next = reduceNav(initialNav, { type: "moveDown" }, data);
    expect(next.selected.configs).toBe(1);
  });

  it("moveDown clamps at len-1 (configs has 3 items → max 2)", () => {
    let nav = initialNav;
    nav = reduceNav(nav, { type: "moveDown" }, data);
    nav = reduceNav(nav, { type: "moveDown" }, data);
    nav = reduceNav(nav, { type: "moveDown" }, data);
    nav = reduceNav(nav, { type: "moveDown" }, data);
    expect(nav.selected.configs).toBe(2);
  });

  it("moveUp clamps at 0", () => {
    const next = reduceNav(initialNav, { type: "moveUp" }, data);
    expect(next.selected.configs).toBe(0);
  });

  it("moveDown on an empty focused panel stays at 0", () => {
    const next = reduceNav(initialNav, { type: "moveDown" }, emptyData);
    expect(next.selected.configs).toBe(0);
  });
});

describe("reduceNav — panel switching clamps (no wrap)", () => {
  it("nextPanel: configs → running → mainClasses → mainClasses", () => {
    let nav = initialNav;
    nav = reduceNav(nav, { type: "nextPanel" }, data);
    expect(nav.focused).toBe("running");
    nav = reduceNav(nav, { type: "nextPanel" }, data);
    expect(nav.focused).toBe("mainClasses");
    nav = reduceNav(nav, { type: "nextPanel" }, data);
    expect(nav.focused).toBe("mainClasses");
  });

  it("prevPanel: mainClasses → running → configs → configs", () => {
    let nav: typeof initialNav = { ...initialNav, focused: "mainClasses" };
    nav = reduceNav(nav, { type: "prevPanel" }, data);
    expect(nav.focused).toBe("running");
    nav = reduceNav(nav, { type: "prevPanel" }, data);
    expect(nav.focused).toBe("configs");
    nav = reduceNav(nav, { type: "prevPanel" }, data);
    expect(nav.focused).toBe("configs");
  });
});

describe("reduceNav — focusPanel", () => {
  it("sets focus directly", () => {
    const next = reduceNav(initialNav, { type: "focusPanel", panel: "mainClasses" }, data);
    expect(next.focused).toBe("mainClasses");
  });
});

describe("reduceNav — top/bottom", () => {
  it("top sets focused selection to 0", () => {
    let nav = reduceNav(initialNav, { type: "moveDown" }, data);
    nav = reduceNav(nav, { type: "top" }, data);
    expect(nav.selected.configs).toBe(0);
  });

  it("bottom sets focused selection to len-1 (mainClasses 2 items → 1)", () => {
    let nav: typeof initialNav = { ...initialNav, focused: "mainClasses" };
    nav = reduceNav(nav, { type: "bottom" }, data);
    expect(nav.selected.mainClasses).toBe(1);
  });

  it("bottom on running (1 item) → 0", () => {
    let nav: typeof initialNav = { ...initialNav, focused: "running" };
    nav = reduceNav(nav, { type: "bottom" }, data);
    expect(nav.selected.running).toBe(0);
  });

  it("bottom on configs (3 items) → 2", () => {
    const nav = reduceNav(initialNav, { type: "bottom" }, data);
    expect(nav.selected.configs).toBe(2);
  });
});

describe("reduceNav — per-panel selection independence", () => {
  it("keeps each panel's selection independent", () => {
    let nav = reduceNav(initialNav, { type: "moveDown" }, data);
    expect(nav.selected.configs).toBe(1);
    nav = reduceNav(nav, { type: "nextPanel" }, data);
    expect(nav.focused).toBe("running");
    expect(nav.selected.running).toBe(0);
    expect(nav.selected.configs).toBe(1);
  });
});

describe("reduceNav — non-navigation actions", () => {
  it("returns nav unchanged for a non-nav action", () => {
    const next = reduceNav(initialNav, { type: "start" }, data);
    expect(next).toEqual(initialNav);
  });
});
