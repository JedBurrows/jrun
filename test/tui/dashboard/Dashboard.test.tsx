import { render } from "ink-testing-library";
import React from "react";
import { describe, expect, it } from "vitest";
import type { JrunApi } from "../../../src/api/JrunApi.js";
import { Dashboard } from "../../../src/tui/dashboard/Dashboard.js";

const flush = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
  await new Promise((r) => setTimeout(r, 10));
};

const stubApi = (): JrunApi => ({
  listConfigs: async () => ["alpha"],
  loadConfig: async () => ({ mainClass: "com.x.A", programArgs: [], jvmOpts: [] }),
  loadLastRun: async () => null,
  saveConfig: async () => {},
  deleteConfig: async () => {},
  listMainClasses: async () => ["com.x.A", "com.x.B"],
  listRunning: async () => [
    {
      pid: 4321,
      mainClass: "com.x.Server",
      startedAt: null,
      logFile: null,
      args: [],
      debugPort: 5005,
      detached: true,
    },
  ],
  start: async () => ({
    pid: 1,
    mainClass: "com.x.A",
    startedAt: null,
    logFile: null,
    args: [],
    debugPort: null,
    detached: true,
  }),
  kill: async () => {},
  readLog: async () => "log output",
});

describe("Dashboard", () => {
  it("renders panels with loaded data", async () => {
    const { lastFrame } = render(<Dashboard api={stubApi()} onExit={() => {}} />);
    await flush();
    const frame = lastFrame() ?? "";
    expect(frame).toContain("Configs");
    expect(frame).toContain("Running");
    expect(frame).toContain("Main classes");
    expect(frame).toContain("alpha"); // config name
    expect(frame).toContain("com.x.Server"); // running process
    expect(frame).toContain("com.x.B"); // main class
  });
});
