import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { NodeContext } from "@effect/platform-node";
import { Layer, ManagedRuntime } from "effect";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { type JrunApi, makeJrunApi } from "../../src/api/JrunApi.js";
import { ConfigDir, ConfigStoreLive } from "../../src/services/ConfigStore.js";
import { JavaProjectLive, ProjectRoot } from "../../src/services/JavaProject.js";
import { LogDir, ProcessManagerLive } from "../../src/services/ProcessManager.js";
import { ProcessProbeLive } from "../../src/services/ProcessProbe.js";

// example/ lives at the repo root, two levels up from test/integration/.
const exampleRoot = path.resolve(fileURLToPath(import.meta.url), "../../../example");

const onPath = (bin: string): boolean => {
  try {
    execFileSync(process.platform === "win32" ? "where" : "which", [bin], {
      stdio: "ignore",
    });
    return true;
  } catch {
    return false;
  }
};

// Faithful end-to-end run requires the full toolchain. On a box missing any of
// these, skip rather than fail so the suite stays green (e.g. minimal CI, or a
// dev machine without maven).
const toolchainPresent = onPath("mvn") && onPath("java") && onPath("rg");

// JVM startup is ~1-2s; poll an async predicate until it holds or we time out.
const pollUntil = async (
  predicate: () => Promise<boolean>,
  timeoutMs: number,
  intervalMs = 250
): Promise<boolean> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return false;
};

describe.skipIf(!toolchainPresent)("example project (integration)", () => {
  // biome-ignore lint/suspicious/noExplicitAny: test-only runtime handle
  let mr: ManagedRuntime.ManagedRuntime<any, never>;
  let api: JrunApi;
  let stateRoot: string;
  const started: string[] = [];

  beforeAll(async () => {
    // Compile the example exactly as a user would, into example/target/classes.
    execFileSync("mvn", ["-q", "compile"], { cwd: exampleRoot, stdio: "inherit" });

    stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), "jrun-example-it-"));
    const configDir = path.join(stateRoot, "config");
    const logDir = path.join(stateRoot, "logs");
    for (const d of [configDir, logDir]) fs.mkdirSync(d, { recursive: true });

    const ProjectRootLayer = Layer.succeed(ProjectRoot, exampleRoot);
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
      Layer.provide(ProcessProbeLive),
      Layer.provide(NodeContext.layer)
    );

    const appLayer = Layer.mergeAll(javaProjectLayer, configStoreLayer, processManagerLayer);
    mr = ManagedRuntime.make(appLayer);
    const runtime = await mr.runtime();
    api = makeJrunApi(runtime);
  }, 120_000); // mvn compile can be slow on a cold cache

  afterEach(async () => {
    const running = await api.listRunning().catch(() => []);
    for (const r of running) await api.kill(r.pid).catch(() => {});
    started.splice(0);
  });

  afterAll(async () => {
    if (mr) await mr.dispose();
    if (stateRoot) fs.rmSync(stateRoot, { recursive: true, force: true });
  });

  it("listMainClasses finds the three example classes", async () => {
    const classes = await api.listMainClasses();
    expect(classes).toEqual([
      "com.example.ApiServer",
      "com.example.DataProcessor",
      "com.example.HelloWorld",
    ]);
  });

  it("DataProcessor runs detached, logs Done., then exits", async () => {
    const cls = "com.example.DataProcessor";
    started.push(cls);
    const rec = await api.start({
      mainClass: cls,
      args: ["--count", "2", "--label", "order"],
      detached: true,
    });
    expect(rec.pid).toBeGreaterThan(0);

    // Log accrues as the JVM runs; wait for the completion marker.
    const logged = await pollUntil(async () => {
      const log = await api.readLog(cls);
      return log?.includes("Done.") ?? false;
    }, 30_000);
    expect(logged).toBe(true);

    // A batch job exits on its own; it should drop out of listRunning.
    const exited = await pollUntil(async () => {
      const running = await api.listRunning();
      return !running.some((r) => r.mainClass === cls);
    }, 30_000);
    expect(exited).toBe(true);
  }, 60_000);

  it("ApiServer runs until killed, then disappears from listRunning", async () => {
    const cls = "com.example.ApiServer";
    started.push(cls);
    await api.start({ mainClass: cls, args: ["--port", "8099"], detached: true });

    // Long-runner: it should appear in listRunning and log its banner.
    const appeared = await pollUntil(async () => {
      const running = await api.listRunning();
      return running.some((r) => r.mainClass === cls);
    }, 30_000);
    expect(appeared).toBe(true);

    const banner = await pollUntil(async () => {
      const log = await api.readLog(cls);
      return log?.includes("Server started") ?? false;
    }, 30_000);
    expect(banner).toBe(true);

    const target = (await api.listRunning()).find((r) => r.mainClass === cls);
    expect(target).toBeDefined();
    if (target) await api.kill(target.pid);

    const gone = await pollUntil(async () => {
      const running = await api.listRunning();
      return !running.some((r) => r.mainClass === cls);
    }, 30_000);
    expect(gone).toBe(true);
  }, 60_000);

  it("HelloWorld runs in the foreground and resolves on clean exit", async () => {
    const cls = "com.example.HelloWorld";
    // Foreground start blocks until the process exits; a clean exit (code 0)
    // resolves, a non-zero exit rejects with JavaProcessError.
    const rec = await api.start({ mainClass: cls, args: ["Alice"], detached: false });
    expect(rec.mainClass).toBe(cls);
    expect(rec.logFile).toBeNull();
  }, 60_000);
});
