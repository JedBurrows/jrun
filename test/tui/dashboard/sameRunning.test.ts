import { describe, expect, test } from "vitest";
import type { ProcessRecord } from "../../../src/services/ProcessManager.js";
import { sameRunning } from "../../../src/tui/dashboard/sameRunning.js";

const rec = (pid: number): ProcessRecord => ({
  pid,
  mainClass: "C",
  startedAt: null,
  logFile: null,
  args: [],
  debugPort: null,
});

describe("sameRunning", () => {
  test("same pids same order → true", () => {
    expect(sameRunning([rec(1), rec(2)], [rec(1), rec(2)])).toBe(true);
  });
  test("different length → false", () => {
    expect(sameRunning([rec(1)], [rec(1), rec(2)])).toBe(false);
  });
  test("different pid → false", () => {
    expect(sameRunning([rec(1), rec(2)], [rec(1), rec(3)])).toBe(false);
  });
  test("reordered → false", () => {
    expect(sameRunning([rec(1), rec(2)], [rec(2), rec(1)])).toBe(false);
  });
  test("both empty → true", () => {
    expect(sameRunning([], [])).toBe(true);
  });
});
