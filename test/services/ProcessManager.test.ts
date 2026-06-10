import * as crypto from "node:crypto";
import { FileSystem } from "@effect/platform";
import { NodeContext } from "@effect/platform-node";
import { it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { describe, expect, test } from "vitest";
import { JavaProjectService, ProjectRoot } from "../../src/services/JavaProject.js";
import {
  JavaBin,
  LogDir,
  ProcessManagerLive,
  ProcessManagerService,
  buildJavaArgs,
  debugJvmArg,
} from "../../src/services/ProcessManager.js";
import {
  ProcessProbeLive,
  ProcessProbeService,
  type ProcessSnapshot,
} from "../../src/services/ProcessProbe.js";
import { projectMarker } from "../../src/services/discovery.js";

const md5 = (s: string) => crypto.createHash("md5").update(s).digest("hex");

const stubProbe = (snaps: ProcessSnapshot[]) =>
  Layer.succeed(ProcessProbeService, {
    listJava: Effect.succeed(snaps),
    inspect: (pid: number) => Effect.succeed(snaps.find((s) => s.pid === pid) ?? null),
  });

const stubProject = Layer.succeed(JavaProjectService, {
  findMainClasses: Effect.succeed([] as string[]),
  resolveClasspath: () => Effect.succeed("target/classes"),
});

const baseLayer = (root: string, logDir: string, probe: Layer.Layer<ProcessProbeService>) =>
  ProcessManagerLive.pipe(
    Layer.provide(stubProject),
    Layer.provide(Layer.succeed(ProjectRoot, root)),
    Layer.provide(Layer.succeed(LogDir, logDir)),
    Layer.provide(probe),
    Layer.provide(NodeContext.layer)
  );

const snap = (pid: number, root: string, argv: string[]): ProcessSnapshot => ({
  pid,
  pgid: pid,
  cwd: root,
  argv,
  startedAt: "2026-06-10T00:00:00.000Z",
});

describe("listRunning (discovery)", () => {
  it.effect("discovers multiple marked instances of the same class with distinct pids", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectory();
      const logDir = yield* fs.makeTempDirectory();
      const m = projectMarker(md5(root));
      const probe = stubProbe([
        snap(101, root, ["java", m, "-cp", "x", "com.example.ApiServer"]),
        snap(102, root, ["java", m, "-cp", "x", "com.example.ApiServer"]),
      ]);
      const running = yield* ProcessManagerService.pipe(
        Effect.flatMap((pm) => pm.listRunning),
        Effect.provide(baseLayer(root, logDir, probe))
      );
      expect(running.map((r) => r.pid).sort()).toEqual([101, 102]);
      expect(running.every((r) => r.mainClass === "com.example.ApiServer")).toBe(true);
    }).pipe(Effect.provide(NodeContext.layer))
  );

  it.effect("EXCLUDES an unmarked java process even with a -cp class (foreign JVM)", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectory();
      const logDir = yield* fs.makeTempDirectory();
      const probe = stubProbe([snap(201, root, ["java", "-cp", "x", "com.example.ApiServer"])]);
      const running = yield* ProcessManagerService.pipe(
        Effect.flatMap((pm) => pm.listRunning),
        Effect.provide(baseLayer(root, logDir, probe))
      );
      expect(running).toEqual([]);
    }).pipe(Effect.provide(NodeContext.layer))
  );

  it.effect("derives the log file for a running instance by class+pid", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectory();
      const logDir = yield* fs.makeTempDirectory();
      const hash = md5(root);
      const m = projectMarker(hash);
      yield* fs.writeFileString(
        `${logDir}/${hash}-com.example.ApiServer-2026-06-10T00-00-00-000Z-303.log`,
        "log"
      );
      const probe = stubProbe([snap(303, root, ["java", m, "-cp", "x", "com.example.ApiServer"])]);
      const running = yield* ProcessManagerService.pipe(
        Effect.flatMap((pm) => pm.listRunning),
        Effect.provide(baseLayer(root, logDir, probe))
      );
      expect(running[0]!.logFile).toContain("-303.log");
    }).pipe(Effect.provide(NodeContext.layer))
  );
});

describe("run (detached) injects the marker + writes a PID-encoded log", () => {
  it.live("spawns with the -Djrun.project marker and a PID-named log capturing output", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const tmpDir = yield* fs.makeTempDirectory();
      const logDir = yield* fs.makeTempDirectory();
      // fake java: record its args, print a banner, linger briefly.
      const argsFile = `${tmpDir}/args`;
      const fakeJava = `${tmpDir}/fake-java`;
      yield* fs.writeFileString(
        fakeJava,
        `#!/bin/bash\nprintf '%s\\n' "$@" > "${argsFile}"\necho HELLO_FAKE_JAVA\nsleep 2\n`
      );
      yield* Effect.sync(() => require("node:fs").chmodSync(fakeJava, 0o755));

      const layer = ProcessManagerLive.pipe(
        Layer.provide(stubProject),
        Layer.provide(Layer.succeed(ProjectRoot, tmpDir)),
        Layer.provide(Layer.succeed(LogDir, logDir)),
        Layer.provide(Layer.succeed(JavaBin, fakeJava)),
        Layer.provide(stubProbe([])),
        Layer.provide(NodeContext.layer)
      );

      const record = yield* ProcessManagerService.pipe(
        Effect.flatMap((pm) =>
          pm.run(
            { mainClass: "com.example.App", programArgs: [], jvmOpts: [] },
            { detached: true, debug: null }
          )
        ),
        Effect.provide(layer)
      );

      expect(record.logFile).toContain(`-${record.pid}.log`);
      yield* Effect.sleep("300 millis");
      const spawnedArgs = yield* fs.readFileString(argsFile);
      expect(spawnedArgs).toContain(projectMarker(md5(tmpDir))); // marker injected
      const log = yield* fs.readFileString(record.logFile!);
      expect(log).toContain("HELLO_FAKE_JAVA");

      yield* ProcessManagerService.pipe(
        Effect.flatMap((pm) => pm.killByPid(record.pid)),
        Effect.provide(layer)
      );
    }).pipe(Effect.provide(NodeContext.layer))
  );
});

describe("killByPid", () => {
  it.live("terminates a detached process (real probe observes its own group)", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const tmpDir = yield* fs.makeTempDirectory();
      const logDir = yield* fs.makeTempDirectory();
      const fakeJava = `${tmpDir}/fake-java`;
      yield* fs.writeFileString(fakeJava, `#!/bin/bash\nsleep 30\n`);
      yield* Effect.sync(() => require("node:fs").chmodSync(fakeJava, 0o755));

      const layer = ProcessManagerLive.pipe(
        Layer.provide(stubProject),
        Layer.provide(Layer.succeed(ProjectRoot, tmpDir)),
        Layer.provide(Layer.succeed(LogDir, logDir)),
        Layer.provide(Layer.succeed(JavaBin, fakeJava)),
        Layer.provide(ProcessProbeLive),
        Layer.provide(NodeContext.layer)
      );

      const record = yield* ProcessManagerService.pipe(
        Effect.flatMap((pm) =>
          pm.run(
            { mainClass: "com.example.Killable", programArgs: [], jvmOpts: [] },
            { detached: true, debug: null }
          )
        ),
        Effect.provide(layer)
      );
      const aliveBefore = yield* Effect.sync(() => {
        try {
          process.kill(record.pid, 0);
          return true;
        } catch {
          return false;
        }
      });
      expect(aliveBefore).toBe(true);

      yield* ProcessManagerService.pipe(
        Effect.flatMap((pm) => pm.killByPid(record.pid)),
        Effect.provide(layer)
      );

      let aliveAfter = true;
      for (let i = 0; i < 20 && aliveAfter; i++) {
        aliveAfter = yield* Effect.sync(() => {
          try {
            process.kill(record.pid, 0);
            return true;
          } catch {
            return false;
          }
        });
        if (aliveAfter) yield* Effect.sleep("100 millis");
      }
      expect(aliveAfter).toBe(false);
    }).pipe(Effect.provide(NodeContext.layer))
  );
});

describe("readLog family", () => {
  it.effect("readLog returns the newest log for an exited class", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectory();
      const logDir = yield* fs.makeTempDirectory();
      const hash = md5(root);
      const cls = "com.example.Batch";
      yield* fs.writeFileString(`${logDir}/${hash}-${cls}-2026-06-08T00-00-00-000Z-1.log`, "OLD\n");
      yield* fs.writeFileString(
        `${logDir}/${hash}-${cls}-2026-06-09T00-00-00-000Z-2.log`,
        "NEW Done.\n"
      );
      const log = yield* ProcessManagerService.pipe(
        Effect.flatMap((pm) => pm.readLog(cls)),
        Effect.provide(baseLayer(root, logDir, stubProbe([])))
      );
      expect(log).toBe("NEW Done.\n");
    }).pipe(Effect.provide(NodeContext.layer))
  );

  it.effect("readLogByPidAnyClass finds a log by pid regardless of class", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectory();
      const logDir = yield* fs.makeTempDirectory();
      const hash = md5(root);
      yield* fs.writeFileString(
        `${logDir}/${hash}-com.example.X-2026-06-09T00-00-00-000Z-555.log`,
        "BYPID\n"
      );
      const log = yield* ProcessManagerService.pipe(
        Effect.flatMap((pm) => pm.readLogByPidAnyClass(555)),
        Effect.provide(baseLayer(root, logDir, stubProbe([])))
      );
      expect(log).toBe("BYPID\n");
    }).pipe(Effect.provide(NodeContext.layer))
  );

  it.effect("readLog returns null when no log matches", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectory();
      const logDir = yield* fs.makeTempDirectory();
      const log = yield* ProcessManagerService.pipe(
        Effect.flatMap((pm) => pm.readLog("com.example.NoLog")),
        Effect.provide(baseLayer(root, logDir, stubProbe([])))
      );
      expect(log).toBe(null);
    }).pipe(Effect.provide(NodeContext.layer))
  );
});

// buildJavaArgs is unchanged (the marker is prepended by `run`, not buildJavaArgs).
test("buildJavaArgs injects debug arg before user jvm opts and orders cp/main/args", () => {
  const args = buildJavaArgs(
    { mainClass: "com.example.App", programArgs: ["--port", "8080"], jvmOpts: ["-Xmx512m"] },
    "target/classes:dep.jar",
    { port: 5005, suspend: false }
  );
  expect(args).toEqual([
    "-agentlib:jdwp=transport=dt_socket,server=y,suspend=n,address=*:5005",
    "-Xmx512m",
    "-cp",
    "target/classes:dep.jar",
    "com.example.App",
    "--port",
    "8080",
  ]);
});

test("buildJavaArgs omits debug arg when debug is null", () => {
  expect(
    buildJavaArgs({ mainClass: "com.example.App", programArgs: [], jvmOpts: [] }, "cp", null)
  ).toEqual(["-cp", "cp", "com.example.App"]);
});

test("debugJvmArg builds JDWP args", () => {
  expect(debugJvmArg(5005, false)).toBe(
    "-agentlib:jdwp=transport=dt_socket,server=y,suspend=n,address=*:5005"
  );
  expect(debugJvmArg(6000, true)).toBe(
    "-agentlib:jdwp=transport=dt_socket,server=y,suspend=y,address=*:6000"
  );
});
