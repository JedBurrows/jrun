import * as cp from "node:child_process";
import { FileSystem } from "@effect/platform";
import { NodeContext } from "@effect/platform-node";
import { it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { describe, expect } from "vitest";
import { JavaProjectService, ProjectRoot } from "../../src/services/JavaProject.js";
import {
  LogDir,
  ProcessManagerLive,
  ProcessManagerService,
} from "../../src/services/ProcessManager.js";
import { ProcessProbeLive } from "../../src/services/ProcessProbe.js";
import { projectMarker } from "../../src/services/discovery.js";

const md5 = (s: string) => require("node:crypto").createHash("md5").update(s).digest("hex");

const stubProject = Layer.succeed(JavaProjectService, {
  findMainClasses: Effect.succeed([] as string[]),
  resolveClasspath: () => Effect.succeed("target/classes"),
});

describe("real /proc discovery (no toolchain)", () => {
  it.live("listRunning discovers a real marked process by /proc + marker", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectory();
      const logDir = yield* fs.makeTempDirectory();
      const marker = projectMarker(md5(root));

      // Node argv0:"java" → /proc/<pid>/cmdline[0] basename is "java"; the marker
      // and -cp ride as POSITIONAL params to `sh -c`, so they aren't parsed as
      // options (sh keeps them in argv verbatim) and the process stays alive.
      const child = cp.spawn(
        "/bin/sh",
        ["-c", "while :; do sleep 1; done", "_", marker, "-cp", "x", "com.example.App"],
        { argv0: "java", cwd: root, stdio: "ignore" }
      );

      try {
        yield* Effect.sleep("250 millis"); // let it appear in /proc
        const layer = ProcessManagerLive.pipe(
          Layer.provide(stubProject),
          Layer.provide(Layer.succeed(ProjectRoot, root)),
          Layer.provide(Layer.succeed(LogDir, logDir)),
          Layer.provide(ProcessProbeLive), // REAL probe — scans real /proc
          Layer.provide(NodeContext.layer)
        );
        const running = yield* ProcessManagerService.pipe(
          Effect.flatMap((pm) => pm.listRunning),
          Effect.provide(layer)
        );
        const found = running.find((r) => r.pid === child.pid);
        expect(found).toBeDefined();
        expect(found?.mainClass).toBe("com.example.App");
      } finally {
        try {
          child.kill("SIGKILL");
        } catch {
          /* ignore */
        }
      }
    }).pipe(Effect.provide(NodeContext.layer))
  );
});
