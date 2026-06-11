import { Box } from "ink";
import { render } from "ink-testing-library";
import React from "react";
import { describe, expect, test } from "vitest";
import type { ProcessRecord } from "../../../src/services/ProcessManager.js";
import { LeftColumn } from "../../../src/tui/dashboard/LeftColumn.js";
import type { DashboardData, NavState } from "../../../src/tui/dashboard/types.js";

const rec = (pid: number): ProcessRecord => ({
  pid,
  mainClass: "com.example.Server",
  startedAt: null,
  logFile: null,
  args: [],
  debugPort: null,
});

const data: DashboardData = {
  running: Array.from({ length: 30 }, (_, i) => rec(9000 + i)),
  mainClasses: ["com.example.A", "com.example.B"],
  configs: ["api-dev"],
  configDetails: {},
};

const nav = (selectedRunning: number): NavState => ({
  focused: "running",
  selected: { configs: 0, running: selectedRunning, mainClasses: 0 },
});

const settle = () => new Promise((r) => setTimeout(r, 50));

describe("LeftColumn", () => {
  test("titles survive and the selected row is visible with a long list in a short box", async () => {
    const { lastFrame, unmount } = render(
      <Box height={10} width={40}>
        <LeftColumn data={data} nav={nav(25)} width={32} />
      </Box>
    );
    await settle(); // let useElementHeight measure + re-render
    const frame = lastFrame() ?? "";
    // All three panel titles must be present (kill-shot #1: title must never be clobbered)
    expect(frame).toContain("Running");
    expect(frame).toContain("Targets");
    expect(frame).toContain("Configs");
    // The SELECTED running row (pid 9025) must be visible (windowed to it)
    expect(frame).toContain("9025");
    unmount();
  });

  test("renders the count badge when a panel overflows", async () => {
    const { lastFrame, unmount } = render(
      <Box height={8} width={40}>
        <LeftColumn data={data} nav={nav(0)} width={32} />
      </Box>
    );
    await settle();
    expect(lastFrame() ?? "").toContain("(30)"); // Running has 30 items, overflowing
    unmount();
  });
});
