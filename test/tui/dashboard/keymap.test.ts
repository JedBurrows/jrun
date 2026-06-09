import { describe, expect, it } from "vitest";
import { type KeyFlags, resolveKey } from "../../../src/tui/dashboard/keymap.js";
import type { Panel } from "../../../src/tui/dashboard/types.js";

const K = (o: Partial<KeyFlags> = {}): KeyFlags => o as KeyFlags;

describe("resolveKey navigation", () => {
  it("moves down on j and downArrow", () => {
    expect(resolveKey("j", K(), "configs")).toEqual({ type: "moveDown" });
    expect(resolveKey("", K({ downArrow: true }), "configs")).toEqual({ type: "moveDown" });
  });

  it("moves up on k and upArrow (k is UP, not kill)", () => {
    expect(resolveKey("k", K(), "configs")).toEqual({ type: "moveUp" });
    expect(resolveKey("", K({ upArrow: true }), "configs")).toEqual({ type: "moveUp" });
    expect(resolveKey("k", K(), "running")).toEqual({ type: "moveUp" });
  });

  it("goes to next panel on l, tab, rightArrow", () => {
    expect(resolveKey("l", K(), "configs")).toEqual({ type: "nextPanel" });
    expect(resolveKey("", K({ tab: true }), "configs")).toEqual({ type: "nextPanel" });
    expect(resolveKey("", K({ rightArrow: true }), "configs")).toEqual({ type: "nextPanel" });
  });

  it("goes to prev panel on h, shift+tab, leftArrow", () => {
    expect(resolveKey("h", K(), "configs")).toEqual({ type: "prevPanel" });
    expect(resolveKey("", K({ tab: true, shift: true }), "configs")).toEqual({ type: "prevPanel" });
    expect(resolveKey("", K({ leftArrow: true }), "configs")).toEqual({ type: "prevPanel" });
  });

  it("focuses panels via number keys", () => {
    expect(resolveKey("1", K(), "running")).toEqual({ type: "focusPanel", panel: "configs" });
    expect(resolveKey("2", K(), "configs")).toEqual({ type: "focusPanel", panel: "running" });
    expect(resolveKey("3", K(), "configs")).toEqual({ type: "focusPanel", panel: "mainClasses" });
  });

  it("jumps to top on g and bottom on G", () => {
    expect(resolveKey("g", K(), "configs")).toEqual({ type: "top" });
    expect(resolveKey("G", K(), "configs")).toEqual({ type: "bottom" });
  });
});

describe("resolveKey global actions", () => {
  it("refresh, help, quit, primary", () => {
    expect(resolveKey("r", K(), "configs")).toEqual({ type: "refresh" });
    expect(resolveKey("?", K(), "configs")).toEqual({ type: "help" });
    expect(resolveKey("q", K(), "configs")).toEqual({ type: "quit" });
    expect(resolveKey("", K({ return: true }), "configs")).toEqual({ type: "primary" });
  });
});

describe("resolveKey per-panel actions", () => {
  it("configs panel", () => {
    expect(resolveKey("s", K(), "configs")).toEqual({ type: "start" });
    expect(resolveKey("S", K(), "configs")).toEqual({ type: "startDebug" });
    expect(resolveKey("e", K(), "configs")).toEqual({ type: "edit" });
    expect(resolveKey("d", K(), "configs")).toEqual({ type: "delete" });
    expect(resolveKey("x", K(), "configs")).toBeNull();
    expect(resolveKey("w", K(), "configs")).toBeNull();
  });

  it("running panel", () => {
    expect(resolveKey("x", K(), "running")).toEqual({ type: "kill" });
    expect(resolveKey("s", K(), "running")).toBeNull();
    expect(resolveKey("d", K(), "running")).toBeNull();
    expect(resolveKey("e", K(), "running")).toBeNull();
    expect(resolveKey("w", K(), "running")).toBeNull();
  });

  it("mainClasses panel", () => {
    expect(resolveKey("s", K(), "mainClasses")).toEqual({ type: "start" });
    expect(resolveKey("S", K(), "mainClasses")).toEqual({ type: "startDebug" });
    expect(resolveKey("w", K(), "mainClasses")).toEqual({ type: "saveAsConfig" });
    expect(resolveKey("d", K(), "mainClasses")).toBeNull();
    expect(resolveKey("x", K(), "mainClasses")).toBeNull();
    expect(resolveKey("e", K(), "mainClasses")).toBeNull();
  });
});

describe("resolveKey unknown input", () => {
  it("returns null for unmapped keys", () => {
    const panels: Panel[] = ["configs", "running", "mainClasses"];
    for (const p of panels) {
      expect(resolveKey("z", K(), p)).toBeNull();
    }
  });
});
