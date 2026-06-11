import { describe, expect, test } from "vitest";
import { logSlice } from "../../../src/tui/dashboard/logSlice.js";

describe("logSlice", () => {
  test("offset 0 → the last `view` lines (newest)", () => {
    expect(logSlice(100, 10, 0)).toEqual({ start: 90, end: 100 });
  });
  test("offset scrolls the window up", () => {
    expect(logSlice(100, 10, 5)).toEqual({ start: 85, end: 95 });
  });
  test("over-scroll up clamps to the TOP page, not empty", () => {
    expect(logSlice(100, 10, 1000)).toEqual({ start: 0, end: 10 });
  });
  test("g (offset = count) shows the top page", () => {
    expect(logSlice(100, 20, 100)).toEqual({ start: 0, end: 20 });
  });
  test("short log: g shows all lines", () => {
    expect(logSlice(3, 10, 3)).toEqual({ start: 0, end: 3 });
  });
  test("fewer lines than view → all", () => {
    expect(logSlice(3, 10, 0)).toEqual({ start: 0, end: 3 });
  });
  test("view <= 0 treated as 1", () => {
    expect(logSlice(5, 0, 0)).toEqual({ start: 4, end: 5 });
  });
});
