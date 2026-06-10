import { render } from "ink-testing-library";
import React from "react";
import { describe, expect, it, vi } from "vitest";
import type { JrunApi } from "../../../src/api/JrunApi.js";
import { Dashboard } from "../../../src/tui/dashboard/Dashboard.js";

const flush = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
  await new Promise((r) => setTimeout(r, 20));
};

const RECORD = {
  pid: 1,
  mainClass: "com.x.A",
  startedAt: null,
  logFile: null,
  args: [],
  debugPort: null,
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
    },
  ],
  start: async () => RECORD,
  kill: async () => {},
  readLog: async () => "log output",
  readLogByPid: async () => "log output",
  readLogByPidAnyClass: async () => null,
});

// Build a stub from vi.fn() mocks so calls can be asserted. Defaults match the
// seeded shape used across the suite.
const mockApi = (overrides: Partial<Record<keyof JrunApi, unknown>> = {}) => {
  const api = {
    listConfigs: vi.fn().mockResolvedValue(["alpha"]),
    loadConfig: vi.fn().mockResolvedValue({ mainClass: "com.x.A", programArgs: [], jvmOpts: [] }),
    loadLastRun: vi.fn().mockResolvedValue(null),
    saveConfig: vi.fn().mockResolvedValue(undefined),
    deleteConfig: vi.fn().mockResolvedValue(undefined),
    listMainClasses: vi.fn().mockResolvedValue(["com.x.A", "com.x.B"]),
    listRunning: vi.fn().mockResolvedValue([
      {
        pid: 4321,
        mainClass: "com.x.Server",
        startedAt: null,
        logFile: null,
        args: [],
        debugPort: 5005,
      },
    ]),
    start: vi.fn().mockResolvedValue(RECORD),
    kill: vi.fn().mockResolvedValue(undefined),
    readLog: vi.fn().mockResolvedValue("log output"),
    readLogByPid: vi.fn().mockResolvedValue("log output"),
    readLogByPidAnyClass: vi.fn().mockResolvedValue(null),
    ...overrides,
  };
  return api as unknown as JrunApi & Record<keyof JrunApi, ReturnType<typeof vi.fn>>;
};

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

  it("shows the help overlay on ?", async () => {
    const { lastFrame, stdin } = render(<Dashboard api={stubApi()} onExit={() => {}} />);
    await flush();
    stdin.write("?");
    await flush();
    const frame = lastFrame() ?? "";
    expect(frame).toContain("Keybindings");
    expect(frame).toContain("start");
    expect(frame).toContain("kill");
    expect(frame).toContain("save");
    expect(frame).toContain("quit");
    expect(frame).toMatch(/navigate|\bj\b/);
  });

  it("toggles the help overlay off with ? without quitting", async () => {
    let quit = false;
    const { lastFrame, stdin } = render(
      <Dashboard
        api={stubApi()}
        onExit={() => {
          quit = true;
        }}
      />
    );
    await flush();
    stdin.write("?");
    await flush();
    expect(lastFrame() ?? "").toContain("Keybindings");
    stdin.write("?");
    await flush();
    expect(lastFrame() ?? "").not.toContain("Keybindings");
    expect(quit).toBe(false);
  });

  it("closes the help overlay with Esc without quitting", async () => {
    let quit = false;
    const { lastFrame, stdin } = render(
      <Dashboard
        api={stubApi()}
        onExit={() => {
          quit = true;
        }}
      />
    );
    await flush();
    stdin.write("?");
    await flush();
    expect(lastFrame() ?? "").toContain("Keybindings");
    stdin.write(""); // Esc
    await flush();
    expect(lastFrame() ?? "").not.toContain("Keybindings");
    expect(quit).toBe(false);
  });

  it("closes the help overlay with q without quitting", async () => {
    let quit = false;
    const { lastFrame, stdin } = render(
      <Dashboard
        api={stubApi()}
        onExit={() => {
          quit = true;
        }}
      />
    );
    await flush();
    stdin.write("?");
    await flush();
    stdin.write("q");
    await flush();
    expect(lastFrame() ?? "").not.toContain("Keybindings");
    expect(quit).toBe(false);
  });

  it("starts a config on s and refreshes", async () => {
    const api = mockApi();
    const { stdin } = render(<Dashboard api={api} onExit={() => {}} />);
    await flush();
    const callsBefore = api.listConfigs.mock.calls.length;
    stdin.write("s");
    await flush();
    expect(api.start).toHaveBeenCalledWith({ configName: "alpha" });
    expect(api.listConfigs.mock.calls.length).toBeGreaterThan(callsBefore);
  });

  it("starts a config in debug on S", async () => {
    const api = mockApi();
    const { stdin } = render(<Dashboard api={api} onExit={() => {}} />);
    await flush();
    stdin.write("S");
    await flush();
    expect(api.start).toHaveBeenCalledWith({
      configName: "alpha",
      debug: { port: 5005, suspend: false },
    });
  });

  it("deletes a config after confirming with y", async () => {
    const api = mockApi();
    const { stdin } = render(<Dashboard api={api} onExit={() => {}} />);
    await flush();
    stdin.write("d");
    await flush();
    stdin.write("y");
    await flush();
    expect(api.deleteConfig).toHaveBeenCalledWith("alpha");
  });

  it("does not delete a config when cancelling with n", async () => {
    const api = mockApi();
    const { stdin } = render(<Dashboard api={api} onExit={() => {}} />);
    await flush();
    stdin.write("d");
    await flush();
    stdin.write("n");
    await flush();
    expect(api.deleteConfig).not.toHaveBeenCalled();
  });

  it("emits an edit intent on e", async () => {
    const api = mockApi();
    const onExit = vi.fn();
    const { stdin } = render(<Dashboard api={api} onExit={onExit} />);
    await flush();
    stdin.write("e");
    await flush();
    expect(onExit).toHaveBeenCalledWith({ type: "edit", name: "alpha" });
  });

  it("kills a running process after confirming with y", async () => {
    const api = mockApi();
    const { stdin } = render(<Dashboard api={api} onExit={() => {}} />);
    await flush();
    stdin.write("2"); // focus running
    await flush();
    stdin.write("x");
    await flush();
    stdin.write("y");
    await flush();
    expect(api.kill).toHaveBeenCalledWith(4321);
  });

  it("opens and closes the log view from running", async () => {
    const api = mockApi();
    const { stdin, lastFrame } = render(<Dashboard api={api} onExit={() => {}} />);
    await flush();
    stdin.write("2"); // focus running
    await flush();
    stdin.write("\r"); // Enter
    await flush();
    expect(api.readLogByPid).toHaveBeenCalledWith("com.x.Server", 4321);
    expect(lastFrame() ?? "").toContain("Logs: com.x.Server");
    expect(lastFrame() ?? "").toContain("log output");
    stdin.write("q");
    await flush();
    expect(lastFrame() ?? "").not.toContain("Logs: com.x.Server");
  });

  it("saves a main class as a config via the prompt", async () => {
    const api = mockApi();
    const { stdin } = render(<Dashboard api={api} onExit={() => {}} />);
    await flush();
    stdin.write("3"); // focus mainClasses
    await flush();
    stdin.write("w");
    await flush();
    stdin.write("myname");
    await flush();
    stdin.write("\r"); // Enter
    await flush();
    expect(api.saveConfig).toHaveBeenCalledWith("myname", {
      mainClass: "com.x.A",
      programArgs: [],
      jvmOpts: [],
    });
  });

  it("treats printable action-keys as prompt text, not actions", async () => {
    const api = mockApi();
    const onExit = vi.fn();
    const { stdin } = render(<Dashboard api={api} onExit={onExit} />);
    await flush();
    stdin.write("3"); // focus mainClasses
    await flush();
    stdin.write("w");
    await flush();
    stdin.write("qdserver"); // contains q (quit) and d (delete)
    await flush();
    stdin.write("\r"); // Enter
    await flush();
    expect(api.saveConfig).toHaveBeenCalledWith("qdserver", {
      mainClass: "com.x.A",
      programArgs: [],
      jvmOpts: [],
    });
    expect(api.deleteConfig).not.toHaveBeenCalled();
    expect(onExit).not.toHaveBeenCalledWith({ type: "quit" });
  });

  it("re-clamps the selection after deleting the last config", async () => {
    // 3 configs first, then 1 after the delete refreshes.
    const listConfigs = vi.fn().mockResolvedValueOnce(["a", "b", "c"]).mockResolvedValue(["a"]);
    const loadConfig = vi.fn(async (name: string) => ({
      mainClass: `com.x.${name}`,
      programArgs: [],
      jvmOpts: [],
    }));
    const api = mockApi({ listConfigs, loadConfig });
    const { stdin, lastFrame } = render(<Dashboard api={api} onExit={() => {}} />);
    await flush();
    stdin.write("G"); // jump to the last config (index 2 = "c")
    await flush();
    expect(lastFrame() ?? "").toContain("mainClass: com.x.c");
    stdin.write("d");
    await flush();
    stdin.write("y"); // confirm delete
    await flush();
    expect(api.deleteConfig).toHaveBeenCalledWith("c");
    const frame = lastFrame() ?? "";
    // Selection must snap back into range — no out-of-range / blank detail.
    expect(frame).not.toContain("com.x.c");
    expect(frame).toContain("mainClass: com.x.a");
    expect(frame).not.toContain("(nothing selected)");
  });

  it("keeps the keybinding hints visible alongside a status message", async () => {
    const api = mockApi();
    const { stdin, lastFrame } = render(<Dashboard api={api} onExit={() => {}} />);
    await flush();
    stdin.write("s"); // start alpha -> sets "Started alpha" status
    await flush();
    const frame = lastFrame() ?? "";
    expect(frame).toContain("Started alpha"); // the status toast
    expect(frame).toContain("navigate"); // hint bar must remain visible
    expect(frame).toContain("quit");
  });

  it("surfaces an error from a failed action", async () => {
    const api = mockApi({ start: vi.fn().mockRejectedValue(new Error("boom")) });
    const { stdin, lastFrame } = render(<Dashboard api={api} onExit={() => {}} />);
    await flush();
    stdin.write("s");
    await flush();
    expect(lastFrame() ?? "").toContain("boom");
  });
});
