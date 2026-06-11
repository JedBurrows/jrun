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

  test("configs focus shows config detail", async () => {
    const cfgData: DashboardData = {
      running: [],
      mainClasses: [],
      configs: ["api-dev"],
      configDetails: { "api-dev": { mainClass: "com.example.Api", programArgs: [], jvmOpts: [] } },
    };
    const { lastFrame, unmount } = render(
      <Box height={10} width={64}>
        <RightPane api={makeApi("")} data={cfgData} nav={nav("configs")} tickMs={1000} />
      </Box>
    );
    await settle();
    const f = lastFrame() ?? "";
    expect(f).toContain("Config: api-dev");
    expect(f).toContain("com.example.Api");
    unmount();
  });

  test("no stale-log flash when switching running rows (key remount)", async () => {
    const api = {
      readLogByPid: async (_c: string, pid: number) => `LOG-FOR-${pid}`,
    } as unknown as JrunApi;
    const twoData: DashboardData = {
      running: [rec(1111), rec(2222)],
      mainClasses: [],
      configs: [],
      configDetails: {},
    };
    const navSel = (i: number): NavState => ({
      focused: "running",
      selected: { configs: 0, running: i, mainClasses: 0 },
    });
    const view = (i: number) => (
      <Box height={10} width={64}>
        <RightPane api={api} data={twoData} nav={navSel(i)} tickMs={1000} />
      </Box>
    );
    const { lastFrame, rerender, unmount } = render(view(0));
    await settle();
    expect(lastFrame() ?? "").toContain("LOG-FOR-1111");
    rerender(view(1)); // switch focused running row
    const immediate = lastFrame() ?? ""; // BEFORE settle — the risky frame
    expect(immediate).toContain("PID 2222"); // new title
    expect(immediate).not.toContain("LOG-FOR-1111"); // key remount cleared the old body
    await settle();
    expect(lastFrame() ?? "").toContain("LOG-FOR-2222");
    unmount();
  });
});
