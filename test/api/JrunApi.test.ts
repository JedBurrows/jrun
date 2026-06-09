import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { NodeContext } from "@effect/platform-node";
import { Layer, ManagedRuntime } from "effect";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type JrunApi, makeJrunApi } from "../../src/api/JrunApi.js";
import { ConfigDir, ConfigStoreLive, type RunConfig } from "../../src/services/ConfigStore.js";
import { JavaProjectLive, ProjectRoot } from "../../src/services/JavaProject.js";
import { LogDir, PidDir, ProcessManagerLive } from "../../src/services/ProcessManager.js";

describe("JrunApi", () => {
  // biome-ignore lint/suspicious/noExplicitAny: test-only runtime handle
  let mr: ManagedRuntime.ManagedRuntime<any, never>;
  let api: JrunApi;
  let tmpRoot: string;

  beforeAll(async () => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "jrun-api-test-"));
    const configDir = path.join(tmpRoot, "config");
    const projectRoot = path.join(tmpRoot, "project");
    const pidDir = path.join(tmpRoot, "pids");
    const logDir = path.join(tmpRoot, "logs");
    fs.mkdirSync(configDir, { recursive: true });
    fs.mkdirSync(projectRoot, { recursive: true });
    fs.mkdirSync(pidDir, { recursive: true });
    fs.mkdirSync(logDir, { recursive: true });

    const ProjectRootLayer = Layer.succeed(ProjectRoot, projectRoot);
    const ConfigDirLayer = Layer.succeed(ConfigDir, configDir);
    const PidDirLayer = Layer.succeed(PidDir, pidDir);
    const LogDirLayer = Layer.succeed(LogDir, logDir);

    const javaProjectLayer = JavaProjectLive.pipe(
      Layer.provide(ProjectRootLayer),
      Layer.provide(NodeContext.layer)
    );

    const configStoreLayer = ConfigStoreLive.pipe(
      Layer.provide(ConfigDirLayer),
      Layer.provide(NodeContext.layer)
    );

    const processManagerLayer = ProcessManagerLive.pipe(
      Layer.provide(javaProjectLayer),
      Layer.provide(ProjectRootLayer),
      Layer.provide(PidDirLayer),
      Layer.provide(LogDirLayer),
      Layer.provide(NodeContext.layer)
    );

    const appLayer = Layer.mergeAll(javaProjectLayer, configStoreLayer, processManagerLayer);
    mr = ManagedRuntime.make(appLayer);
    const runtime = await mr.runtime();
    api = makeJrunApi(runtime);
  });

  afterAll(async () => {
    await mr.dispose();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  const cfg: RunConfig = {
    mainClass: "com.example.Main",
    programArgs: ["--foo"],
    jvmOpts: ["-Xmx256m"],
  };

  it("listConfigs is empty initially", async () => {
    expect(await api.listConfigs()).toEqual([]);
  });

  it("saveConfig then listConfigs/loadConfig round-trips", async () => {
    await api.saveConfig("a", cfg);
    expect(await api.listConfigs()).toContain("a");
    expect(await api.loadConfig("a")).toEqual(cfg);
  });

  it("loadConfig returns null for a missing config", async () => {
    expect(await api.loadConfig("missing")).toBeNull();
  });

  it("deleteConfig removes the config", async () => {
    await api.saveConfig("a", cfg);
    await api.deleteConfig("a");
    expect(await api.listConfigs()).not.toContain("a");
  });

  it("listRunning is empty", async () => {
    expect(await api.listRunning()).toEqual([]);
  });

  it("listMainClasses returns an array", async () => {
    const result = await api.listMainClasses();
    expect(Array.isArray(result)).toBe(true);
  });
});
