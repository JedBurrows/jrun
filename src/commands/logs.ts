import * as childProcess from "node:child_process";
import { Args, Command, Options } from "@effect/cli";
import { FileSystem } from "@effect/platform";
import { Console, Effect } from "effect";
import { ProcessManagerService } from "../services/ProcessManager.js";

const classArg = Args.text({ name: "class" });
const followOption = Options.boolean("follow").pipe(
  Options.withAlias("f"),
  Options.withDescription("Stream new log output as it is written")
);

export const logs = Command.make(
  "logs",
  { class_: classArg, follow: followOption },
  ({ class_: cls, follow }) =>
    Effect.gen(function* () {
      const pm = yield* ProcessManagerService;

      if (follow) {
        const fs = yield* FileSystem.FileSystem;
        const running = yield* pm.listRunning;
        const record = running.find((r) => r.mainClass === cls);

        if (!record || !record.logFile) {
          yield* Console.error(`No live log to follow for ${cls} (is it running detached?)`);
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
          const child = childProcess.spawn("tail", ["-f", logFile], {
            stdio: "inherit",
          });
          child.on("exit", () => resume(Effect.void));
          return Effect.sync(() => {
            child.kill();
          });
        });
        return;
      }

      const content = yield* pm.readLog(cls);
      if (content === null) {
        yield* Console.error(`No log found for ${cls} (has it been run detached?)`);
        yield* Effect.sync(() => {
          process.exitCode = 1;
        });
        return;
      }
      yield* Console.log(content);
    })
).pipe(Command.withDescription("Print or follow the log of a detached run"));
