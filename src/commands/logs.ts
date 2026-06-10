import * as childProcess from "node:child_process";
import { Args, Command, Options } from "@effect/cli";
import { FileSystem } from "@effect/platform";
import { Console, Effect } from "effect";
import { ProcessManagerService } from "../services/ProcessManager.js";

const targetArg = Args.text({ name: "class-or-pid" });
const followOption = Options.boolean("follow").pipe(
  Options.withAlias("f"),
  Options.withDescription("Stream new log output as it is written")
);

export const logs = Command.make(
  "logs",
  { target: targetArg, follow: followOption },
  ({ target, follow }) =>
    Effect.gen(function* () {
      const pm = yield* ProcessManagerService;
      const asPid = /^\d+$/.test(target) ? Number(target) : null;

      if (follow) {
        const fs = yield* FileSystem.FileSystem;
        const running = yield* pm.listRunning;
        const record = running.find((r) =>
          asPid !== null ? r.pid === asPid : r.mainClass === target
        );
        if (!record || !record.logFile) {
          yield* Console.error(`No live log to follow for ${target} (is it running detached?)`);
          yield* Effect.sync(() => {
            process.exitCode = 1;
          });
          return;
        }
        const exists = yield* fs.exists(record.logFile);
        if (!exists) {
          yield* Console.error(`Log file missing: ${record.logFile}`);
          yield* Effect.sync(() => {
            process.exitCode = 1;
          });
          return;
        }
        const logFile = record.logFile;
        yield* Effect.async<void>((resume) => {
          const child = childProcess.spawn("tail", ["-f", logFile], { stdio: "inherit" });
          child.on("exit", () => resume(Effect.void));
          return Effect.sync(() => {
            child.kill();
          });
        });
        return;
      }

      // Non-follow: a PID resolves to a running instance's log, or — if the PID
      // has exited and is no longer discoverable — a class-agnostic by-PID glob.
      if (asPid !== null) {
        const running = yield* pm.listRunning;
        const rec = running.find((r) => r.pid === asPid);
        const content = rec
          ? yield* pm.readLogByPid(rec.mainClass, asPid)
          : yield* pm.readLogByPidAnyClass(asPid);
        if (content === null) {
          yield* Console.error(`No log found for PID ${asPid}`);
          yield* Effect.sync(() => {
            process.exitCode = 1;
          });
          return;
        }
        yield* Console.log(content);
        return;
      }

      const content = yield* pm.readLog(target);
      if (content === null) {
        yield* Console.error(`No log found for ${target} (has it been run detached?)`);
        yield* Effect.sync(() => {
          process.exitCode = 1;
        });
        return;
      }
      yield* Console.log(content);
    })
).pipe(Command.withDescription("Print or follow the log of a detached run (by class name or PID)"));
