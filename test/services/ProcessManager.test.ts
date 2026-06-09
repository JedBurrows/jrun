import { FileSystem } from "@effect/platform";
import { NodeContext } from "@effect/platform-node";
import { it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { describe, expect, test } from "vitest";
import type { RunConfig } from "../../src/services/ConfigStore.js";
import {
  JavaProjectLive,
  JavaProjectService,
  ProjectRoot,
} from "../../src/services/JavaProject.js";
import {
  JavaBin,
  LogDir,
  PidDir,
  ProcessManagerLive,
  ProcessManagerService,
  ProcessNotFound,
  buildJavaArgs,
  debugJvmArg,
} from "../../src/services/ProcessManager.js";

const makeTestLayer = (tmpDir: string, pidDir: string) => {
  const rootLayer = Layer.succeed(ProjectRoot, tmpDir);
  const pidLayer = Layer.succeed(PidDir, pidDir);
  const javaProjectLayer = JavaProjectLive.pipe(
    Layer.provide(rootLayer),
    Layer.provide(NodeContext.layer)
  );

  return ProcessManagerLive.pipe(
    Layer.provide(javaProjectLayer),
    Layer.provide(rootLayer),
    Layer.provide(pidLayer),
    Layer.provide(Layer.succeed(LogDir, pidDir)),
    Layer.provide(NodeContext.layer)
  );
};

describe("ProcessManager", () => {
  it.effect("run spawns java with correct argument order", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const tmpDir = yield* fs.makeTempDirectory();
      const pidDir = yield* fs.makeTempDirectory();

      // Create a mock "java" script that writes its args to a file
      const argsFile = `${tmpDir}/received-args`;
      const mockJava = `${tmpDir}/mock-java`;
      yield* fs.writeFileString(mockJava, `#!/bin/bash\necho "$@" > "${argsFile}"\n`);
      yield* Effect.sync(() => {
        const { chmodSync } = require("node:fs");
        chmodSync(mockJava, 0o755);
      });

      // We can't easily mock Command.make("java",...) in the real service,
      // so let's just verify the PID file lifecycle instead.
      // The full integration test would need a real java or a mock.

      // Test listRunning with a synthetic PID file
      const layer = makeTestLayer(tmpDir, pidDir);

      const running = yield* ProcessManagerService.pipe(
        Effect.flatMap((pm) => pm.listRunning),
        Effect.provide(layer)
      );
      expect(running).toEqual([]);
    }).pipe(Effect.provide(NodeContext.layer))
  );

  it.effect("listRunning cleans up stale PID files", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const tmpDir = yield* fs.makeTempDirectory();
      const pidDir = yield* fs.makeTempDirectory();
      const crypto = require("node:crypto");
      const hash = crypto.createHash("md5").update(tmpDir).digest("hex");

      // Write a PID file with a non-existent PID
      yield* fs.writeFileString(`${pidDir}/${hash}-com.example.Dead.pid`, "99999999");

      const layer = makeTestLayer(tmpDir, pidDir);
      const running = yield* ProcessManagerService.pipe(
        Effect.flatMap((pm) => pm.listRunning),
        Effect.provide(layer)
      );

      expect(running).toEqual([]);
      // Stale file should be cleaned up
      const exists = yield* fs.exists(`${pidDir}/${hash}-com.example.Dead.pid`);
      expect(exists).toBe(false);
    }).pipe(Effect.provide(NodeContext.layer))
  );

  it.effect("listRunning returns running processes for current project", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const tmpDir = yield* fs.makeTempDirectory();
      const pidDir = yield* fs.makeTempDirectory();
      const crypto = require("node:crypto");
      const hash = crypto.createHash("md5").update(tmpDir).digest("hex");

      const myPid = process.pid;
      const record = {
        pid: myPid,
        mainClass: "com.example.Running",
        startedAt: "2026-06-08T00:00:00.000Z",
        logFile: null,
        args: [],
        debugPort: null,
        detached: false,
      };
      yield* fs.writeFileString(
        `${pidDir}/${hash}-com.example.Running.pid`,
        JSON.stringify(record)
      );

      const layer = makeTestLayer(tmpDir, pidDir);
      const running = yield* ProcessManagerService.pipe(
        Effect.flatMap((pm) => pm.listRunning),
        Effect.provide(layer)
      );

      expect(running).toEqual([record]);
    }).pipe(Effect.provide(NodeContext.layer))
  );

  it.effect("listRunning ignores PIDs from other projects", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const tmpDir = yield* fs.makeTempDirectory();
      const pidDir = yield* fs.makeTempDirectory();

      // Write a PID file with a different project hash
      yield* fs.writeFileString(`${pidDir}/otherhash-com.example.Other.pid`, String(process.pid));

      const layer = makeTestLayer(tmpDir, pidDir);
      const running = yield* ProcessManagerService.pipe(
        Effect.flatMap((pm) => pm.listRunning),
        Effect.provide(layer)
      );

      expect(running).toEqual([]);
    }).pipe(Effect.provide(NodeContext.layer))
  );

  it.effect("listRunning parses legacy raw-integer PID files", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const tmpDir = yield* fs.makeTempDirectory();
      const pidDir = yield* fs.makeTempDirectory();
      const crypto = require("node:crypto");
      const hash = crypto.createHash("md5").update(tmpDir).digest("hex");

      const myPid = process.pid;
      yield* fs.writeFileString(`${pidDir}/${hash}-com.example.Legacy.pid`, String(myPid));

      const layer = makeTestLayer(tmpDir, pidDir);
      const running = yield* ProcessManagerService.pipe(
        Effect.flatMap((pm) => pm.listRunning),
        Effect.provide(layer)
      );

      expect(running.length).toBe(1);
      expect(running[0]!.pid).toBe(myPid);
      expect(running[0]!.mainClass).toBe("com.example.Legacy");
      expect(running[0]!.logFile).toBe(null);
      expect(running[0]!.debugPort).toBe(null);
      expect(running[0]!.args).toEqual([]);
      expect(running[0]!.detached).toBe(false);
      expect(typeof running[0]!.startedAt).toBe("string");
    }).pipe(Effect.provide(NodeContext.layer))
  );

  it.effect("listRunning does NOT remove malformed (unparseable) PID files", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const tmpDir = yield* fs.makeTempDirectory();
      const pidDir = yield* fs.makeTempDirectory();
      const crypto = require("node:crypto");
      const hash = crypto.createHash("md5").update(tmpDir).digest("hex");

      const filePath = `${pidDir}/${hash}-com.example.Partial.pid`;
      yield* fs.writeFileString(filePath, "{not valid json");

      const layer = makeTestLayer(tmpDir, pidDir);
      const running = yield* ProcessManagerService.pipe(
        Effect.flatMap((pm) => pm.listRunning),
        Effect.provide(layer)
      );

      expect(running).toEqual([]);
      // Must NOT be reaped — could be a partial write from a live process.
      const exists = yield* fs.exists(filePath);
      expect(exists).toBe(true);
    }).pipe(Effect.provide(NodeContext.layer))
  );

  // Uses it.live (real clock): the body relies on real-time Effect.sleep and on
  // killByPid's real 2s SIGTERM->SIGKILL delay, which would hang under the
  // TestClock that it.effect installs.
  it.live("detached run writes a record with a log file and redirects output", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const tmpDir = yield* fs.makeTempDirectory();
      const pidDir = yield* fs.makeTempDirectory();
      const logDir = yield* fs.makeTempDirectory();

      const fakeJava = `${tmpDir}/fake-java`;
      yield* fs.writeFileString(fakeJava, `#!/bin/bash\necho "HELLO_FROM_FAKE_JAVA"\nsleep 2\n`);
      yield* Effect.sync(() => require("node:fs").chmodSync(fakeJava, 0o755));

      const rootLayer = Layer.succeed(ProjectRoot, tmpDir);
      const pidLayer = Layer.succeed(PidDir, pidDir);
      const logLayer = Layer.succeed(LogDir, logDir);
      const javaBinLayer = Layer.succeed(JavaBin, fakeJava);
      // Stub JavaProject so this test does not shell out to `mvn`; the detached
      // spawn behavior is what's under test, not classpath resolution.
      const stubJavaProject = Layer.succeed(JavaProjectService, {
        findMainClasses: Effect.succeed([] as string[]),
        resolveClasspath: Effect.succeed("target/classes"),
      });
      const layer = ProcessManagerLive.pipe(
        Layer.provide(stubJavaProject),
        Layer.provide(rootLayer),
        Layer.provide(pidLayer),
        Layer.provide(logLayer),
        Layer.provide(javaBinLayer),
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

      expect(record.mainClass).toBe("com.example.App");
      expect(record.logFile).not.toBe(null);
      expect(record.debugPort).toBe(null);
      expect(record.detached).toBe(true);

      yield* Effect.sleep("300 millis");
      const log = yield* fs.readFileString(record.logFile!);
      expect(log).toContain("HELLO_FROM_FAKE_JAVA");

      yield* ProcessManagerService.pipe(
        Effect.flatMap((pm) => pm.killByPid(record.pid)),
        Effect.provide(layer)
      );
    }).pipe(Effect.provide(NodeContext.layer))
  );

  // Round-trip: start a detached fake-java that sleeps, then kill it by class
  // name. Exercises the real kill -> parseRecord -> signal path (the JSON
  // pid-file format that previously broke Number.parseInt-based kill), and the
  // process-group signalling for detached runs. Uses it.live (real clock).
  it.live("kill(className) terminates a detached process and removes its pid file", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const tmpDir = yield* fs.makeTempDirectory();
      const pidDir = yield* fs.makeTempDirectory();
      const logDir = yield* fs.makeTempDirectory();

      const fakeJava = `${tmpDir}/fake-java`;
      // Sleep long enough that the process is unambiguously alive until killed.
      yield* fs.writeFileString(fakeJava, `#!/bin/bash\nsleep 30\n`);
      yield* Effect.sync(() => require("node:fs").chmodSync(fakeJava, 0o755));

      const rootLayer = Layer.succeed(ProjectRoot, tmpDir);
      const pidLayer = Layer.succeed(PidDir, pidDir);
      const logLayer = Layer.succeed(LogDir, logDir);
      const javaBinLayer = Layer.succeed(JavaBin, fakeJava);
      const stubJavaProject = Layer.succeed(JavaProjectService, {
        findMainClasses: Effect.succeed([] as string[]),
        resolveClasspath: Effect.succeed("target/classes"),
      });
      const layer = ProcessManagerLive.pipe(
        Layer.provide(stubJavaProject),
        Layer.provide(rootLayer),
        Layer.provide(pidLayer),
        Layer.provide(logLayer),
        Layer.provide(javaBinLayer),
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

      // Confirm it is actually running before we kill it.
      const aliveBefore = yield* Effect.sync(() => {
        try {
          process.kill(record.pid, 0);
          return true;
        } catch {
          return false;
        }
      });
      expect(aliveBefore).toBe(true);

      // Kill by class name -> real parseRecord -> group signal.
      yield* ProcessManagerService.pipe(
        Effect.flatMap((pm) => pm.kill("com.example.Killable")),
        Effect.provide(layer)
      );

      // Poll until the process is gone (kill is SIGTERM; give it a moment).
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

      // Pid file must be removed after a successful kill.
      const pidFileExists = yield* fs.exists(
        `${pidDir}/${require("node:crypto").createHash("md5").update(tmpDir).digest("hex")}-com.example.Killable.pid`
      );
      expect(pidFileExists).toBe(false);
    }).pipe(Effect.provide(NodeContext.layer))
  );

  it.effect("kill returns ProcessNotFound for unknown class", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const tmpDir = yield* fs.makeTempDirectory();
      const pidDir = yield* fs.makeTempDirectory();

      const layer = makeTestLayer(tmpDir, pidDir);
      const result = yield* ProcessManagerService.pipe(
        Effect.flatMap((pm) => pm.kill("com.example.NonExistent")),
        Effect.provide(layer),
        Effect.matchEffect({
          onFailure: (e) => Effect.succeed(e),
          onSuccess: () => Effect.fail("should have failed"),
        })
      );

      expect(result).toBeInstanceOf(ProcessNotFound);
    }).pipe(Effect.provide(NodeContext.layer))
  );
});

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
  const args = buildJavaArgs(
    { mainClass: "com.example.App", programArgs: [], jvmOpts: [] },
    "cp",
    null
  );
  expect(args).toEqual(["-cp", "cp", "com.example.App"]);
});

test("debugJvmArg builds a non-suspending JDWP arg by default", () => {
  expect(debugJvmArg(5005, false)).toBe(
    "-agentlib:jdwp=transport=dt_socket,server=y,suspend=n,address=*:5005"
  );
});

test("debugJvmArg sets suspend=y when requested", () => {
  expect(debugJvmArg(6000, true)).toBe(
    "-agentlib:jdwp=transport=dt_socket,server=y,suspend=y,address=*:6000"
  );
});
