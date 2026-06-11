import { Box } from "ink";
import { render } from "ink-testing-library";
import React from "react";
import { describe, expect, test } from "vitest";
import type { JrunApi } from "../../../src/api/JrunApi.js";
import type { ProcessRecord } from "../../../src/services/ProcessManager.js";
import { RightPane } from "../../../src/tui/dashboard/RightPane.js";
import type { DashboardData, NavState } from "../../../src/tui/dashboard/types.js";

const LOG = Array.from({ length: 20 }, (_, i) => `line-${String(i + 1).padStart(2, "0")}`).join(
  "\n"
);
const makeApi = (log: string | null): JrunApi =>
  ({ readLogByPid: async () => log }) as unknown as JrunApi;

const rec = (pid: number): ProcessRecord => ({
  pid,
  mainClass: "com.example.Server",
  startedAt: null,
  logFile: null,
  args: [],
  debugPort: null,
});

const baseData: DashboardData = {
  running: [rec(5512)],
  mainClasses: ["com.example.App"],
  configs: [],
  configDetails: {},
};
const nav = (focused: NavState["focused"]): NavState => ({
  focused,
  selected: { configs: 0, running: 0, mainClasses: 0 },
});
const settle = () => new Promise((r) => setTimeout(r, 60));

describe("RightPane", () => {
  test("running focus live-tails the newest lines + footer; oldest is clipped", async () => {
    const { lastFrame, unmount } = render(
      <Box height={10} width={64}>
        <RightPane api={makeApi(LOG)} data={baseData} nav={nav("running")} tickMs={1000} />
      </Box>
    );
    await settle(); // initial poll resolves + measureElement settles
    const f = lastFrame() ?? "";
    expect(f).toContain("Logs: com.example.Server (PID 5512)");
    expect(f).toContain("line-20"); // newest visible
    expect(f).toContain("zoom"); // footer not clipped
    expect(f).not.toContain("line-01"); // oldest windowed out (proves it fits, not render-all)
    unmount();
  });

  test("targets focus shows target detail", async () => {
    const { lastFrame, unmount } = render(
      <Box height={10} width={64}>
        <RightPane api={makeApi("")} data={baseData} nav={nav("mainClasses")} tickMs={1000} />
      </Box>
    );
    await settle();
    expect(lastFrame() ?? "").toContain("Target: com.example.App");
    unmount();
  });
});
