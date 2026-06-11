import { describe, expect, test } from "vitest";
import { readSize } from "../../../../src/tui/dashboard/hooks/useTerminalSize.js";

describe("readSize", () => {
  test("reads columns/rows from a stdout-like object", () => {
    expect(readSize({ columns: 120, rows: 40 } as NodeJS.WriteStream)).toEqual({
      columns: 120,
      rows: 40,
    });
  });
  test("falls back to 80x24 when undefined or missing dims", () => {
    expect(readSize(undefined)).toEqual({ columns: 80, rows: 24 });
    expect(readSize({} as NodeJS.WriteStream)).toEqual({ columns: 80, rows: 24 });
  });
});
