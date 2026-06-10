import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { NodeContext } from "@effect/platform-node";
import { Effect, Layer, ManagedRuntime } from "effect";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type JrunApi, makeJrunApi } from "../../src/api/JrunApi.js";
import {
  ConfigDir,
  ConfigStoreLive,
  ConfigStoreService,
  type RunConfig,
} from "../../src/services/ConfigStore.js";
import { JavaProjectLive, ProjectRoot } from "../../src/services/JavaProject.js";
import { LogDir, ProcessManagerLive } from "../../src/services/ProcessManager.js";
import { ProcessProbeService, type ProcessSnapshot } from "../../src/services/ProcessProbe.js";

// Discovery is stubbed: this suite never spawns, so listRunning sees nothing and
// killByPid inspects nothing — keeping the shared runtime deterministic.
const stubProbe = Layer.succeed(ProcessProbeService, {
  listJava: Effect.succeed([] as ProcessSnapshot[]),
  inspect: () => Effect.succeed<ProcessSnapshot | null>(null),
});

describe("JrunApi", () => {
  // biome-ignore lint/suspicious/noExplicitAny: test-only runtime handle
  let mr: ManagedRuntime.ManagedRuntime<any, never>;
  let api: JrunApi;
  let tmpRoot: string;

  beforeAll(async () => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "jrun-api-test-"));
    const configDir = path.join(tmpRoot, "config");
    const projectRoot = path.join(tmpRoot, "project");
    const logDir = path.join(tmpRoot, "logs");
    fs.mkdirSync(configDir, { recursive: true });
    fs.mkdirSync(projectRoot, { recursive: true });
    fs.mkdirSync(logDir, { recursive: true });

    const ProjectRootLayer = Layer.succeed(ProjectRoot, projectRoot);
    const ConfigDirLayer = Layer.succeed(ConfigDir, configDir);
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
      Layer.provide(LogDirLayer),
      Layer.provide(stubProbe),
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

  it("start with neither mainClass nor configName rejects", async () => {
    // Surfaces as a FiberFailure whose `.message` preserves the original Error
    // message, so the text is accessible to consumers.
    await expect(api.start({})).rejects.toThrow(/mainClass or configName/);
  });

  it("kill of an unknown pid resolves (killByPid is best-effort)", async () => {
    // A pid above pid_max can never name a live process or group, so this is a
    // safe no-op: killByPid signals nothing and resolves.
    await expect(api.kill(2_147_483_647)).resolves.toBeUndefined();
  });

  it("readLog returns null when the class is not running", async () => {
    await expect(api.readLog("com.example.NotRunning")).resolves.toBeNull();
  });

  it("readLogByPid returns the log for an exact class+pid", async () => {
    const hash = crypto.createHash("md5").update(path.join(tmpRoot, "project")).digest("hex");
    fs.writeFileSync(
      path.join(tmpRoot, "logs", `${hash}-com.example.Logged-2026-06-09T00-00-00-000Z-777.log`),
      "BYPID\n"
    );
    expect(await api.readLogByPid("com.example.Logged", 777)).toBe("BYPID\n");
    expect(await api.readLogByPid("com.example.Logged", 778)).toBeNull();
  });

  it("readLogByPidAnyClass returns the log for a pid regardless of class", async () => {
    const hash = crypto.createHash("md5").update(path.join(tmpRoot, "project")).digest("hex");
    fs.writeFileSync(
      path.join(tmpRoot, "logs", `${hash}-com.example.Whatever-2026-06-09T00-00-00-000Z-888.log`),
      "ANYCLASS\n"
    );
    expect(await api.readLogByPidAnyClass(888)).toBe("ANYCLASS\n");
    expect(await api.readLogByPidAnyClass(889)).toBeNull();
  });

  it("loadLastRun returns null when nothing has been run", async () => {
    await expect(api.loadLastRun()).resolves.toBeNull();
  });

  it("loadLastRun returns the saved last-run", async () => {
    // Seed last-run directly through the underlying store on the SAME runtime.
    await mr.runPromise(
      Effect.gen(function* () {
        const s = yield* ConfigStoreService;
        yield* s.saveLastRun(cfg);
      })
    );
    expect(await api.loadLastRun()).toEqual(cfg);
  });
});
