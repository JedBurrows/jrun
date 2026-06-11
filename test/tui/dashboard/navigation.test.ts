import { describe, expect, it } from "vitest";
import { clampNav, initialNav, reduceNav } from "../../../src/tui/dashboard/navigation.js";
import type { DashboardData, NavState } from "../../../src/tui/dashboard/types.js";

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
  it("starts focused on running with all selections at 0", () => {
    expect(initialNav).toEqual({
      focused: "running",
      selected: { configs: 0, running: 0, mainClasses: 0 },
    });
  });
});

describe("reduceNav — moveUp/moveDown", () => {
  it("moveDown increments the focused panel's selection", () => {
    const nav: NavState = { ...initialNav, focused: "configs" };
    const next = reduceNav(nav, { type: "moveDown" }, data);
    expect(next.selected.configs).toBe(1);
  });

  it("moveDown clamps at len-1 (configs has 3 items → max 2)", () => {
    let nav: NavState = { ...initialNav, focused: "configs" };
    nav = reduceNav(nav, { type: "moveDown" }, data);
    nav = reduceNav(nav, { type: "moveDown" }, data);
    nav = reduceNav(nav, { type: "moveDown" }, data);
    nav = reduceNav(nav, { type: "moveDown" }, data);
    expect(nav.selected.configs).toBe(2);
  });

  it("moveUp clamps at 0", () => {
    const nav: NavState = { ...initialNav, focused: "configs" };
    const next = reduceNav(nav, { type: "moveUp" }, data);
    expect(next.selected.configs).toBe(0);
  });

  it("moveDown on an empty focused panel stays at 0", () => {
    const nav: NavState = { ...initialNav, focused: "configs" };
    const next = reduceNav(nav, { type: "moveDown" }, emptyData);
    expect(next.selected.configs).toBe(0);
  });
});

describe("reduceNav — panel switching clamps (no wrap)", () => {
  it("nextPanel: running → mainClasses → configs → configs", () => {
    let nav = initialNav;
    nav = reduceNav(nav, { type: "nextPanel" }, data);
    expect(nav.focused).toBe("mainClasses");
    nav = reduceNav(nav, { type: "nextPanel" }, data);
    expect(nav.focused).toBe("configs");
    nav = reduceNav(nav, { type: "nextPanel" }, data);
    expect(nav.focused).toBe("configs");
  });

  it("prevPanel: configs → mainClasses → running → running", () => {
    let nav: typeof initialNav = { ...initialNav, focused: "configs" };
    nav = reduceNav(nav, { type: "prevPanel" }, data);
    expect(nav.focused).toBe("mainClasses");
    nav = reduceNav(nav, { type: "prevPanel" }, data);
    expect(nav.focused).toBe("running");
    nav = reduceNav(nav, { type: "prevPanel" }, data);
    expect(nav.focused).toBe("running");
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
    let nav: NavState = { ...initialNav, focused: "configs" };
    nav = reduceNav(nav, { type: "moveDown" }, data);
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
    const nav = reduceNav({ ...initialNav, focused: "configs" }, { type: "bottom" }, data);
    expect(nav.selected.configs).toBe(2);
  });
});

describe("reduceNav — per-panel selection independence", () => {
  it("keeps each panel's selection independent", () => {
    let nav: NavState = { ...initialNav, focused: "configs" };
    nav = reduceNav(nav, { type: "moveDown" }, data);
    expect(nav.selected.configs).toBe(1);
    nav = reduceNav(nav, { type: "prevPanel" }, data);
    expect(nav.focused).toBe("mainClasses");
    expect(nav.selected.mainClasses).toBe(0);
    expect(nav.selected.configs).toBe(1);
  });
});

describe("reduceNav — non-navigation actions", () => {
  it("returns nav unchanged for a non-nav action", () => {
    const next = reduceNav(initialNav, { type: "start" }, data);
    expect(next).toEqual(initialNav);
  });
});

describe("clampNav", () => {
  it("clamps a selection beyond the new list length to len-1", () => {
    const nav: NavState = {
      focused: "configs",
      selected: { configs: 5, running: 0, mainClasses: 0 },
    };
    // data.configs has 3 items → max index 2
    expect(clampNav(nav, data).selected.configs).toBe(2);
  });

  it("clamps to 0 when the list is now empty", () => {
    const nav: NavState = {
      focused: "configs",
      selected: { configs: 2, running: 3, mainClasses: 1 },
    };
    expect(clampNav(nav, emptyData).selected).toEqual({
      configs: 0,
      running: 0,
      mainClasses: 0,
    });
  });

  it("leaves an in-range selection untouched and preserves focus", () => {
    const nav: NavState = {
      focused: "mainClasses",
      selected: { configs: 1, running: 0, mainClasses: 1 },
    };
    const next = clampNav(nav, data);
    expect(next).toEqual(nav);
  });
});
