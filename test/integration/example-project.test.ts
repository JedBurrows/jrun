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
import { LogDir, PidDir, ProcessManagerLive } from "../../src/services/ProcessManager.js";

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
    const pidDir = path.join(stateRoot, "pids");
    const logDir = path.join(stateRoot, "logs");
    for (const d of [configDir, pidDir, logDir]) fs.mkdirSync(d, { recursive: true });

    const ProjectRootLayer = Layer.succeed(ProjectRoot, exampleRoot);
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
  }, 120_000); // mvn compile can be slow on a cold cache

  afterEach(async () => {
    // Best-effort: kill anything a scenario left running. kill() swallows
    // ProcessNotFound, so already-exited classes are harmless.
    for (const cls of started.splice(0)) {
      await api.kill(cls).catch(() => {});
    }
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
});
