import { describe, expect, test } from "vitest";
import { tailLines } from "../../../src/tui/dashboard/tailLines.js";

describe("tailLines", () => {
  test("null/empty → []", () => {
    expect(tailLines(null, 5)).toEqual([]);
    expect(tailLines("", 5)).toEqual([]);
  });
  test("returns the last n lines", () => {
    expect(tailLines("a\nb\nc\nd", 2)).toEqual(["c", "d"]);
  });
  test("drops a single trailing-newline empty line", () => {
    expect(tailLines("a\nb\n", 5)).toEqual(["a", "b"]);
  });
  test("n >= length returns all", () => {
    expect(tailLines("a\nb", 10)).toEqual(["a", "b"]);
  });
  test("n <= 0 → []", () => {
    expect(tailLines("a\nb", 0)).toEqual([]);
  });
});
