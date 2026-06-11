import { describe, expect, test } from "vitest";
import { windowRows } from "../../../src/tui/dashboard/windowRows.js";

describe("windowRows", () => {
  test("everything fits → full range", () => {
    expect(windowRows(3, 0, 10)).toEqual({ start: 0, end: 3 });
  });
  test("scrolls to keep selection visible near the end", () => {
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
