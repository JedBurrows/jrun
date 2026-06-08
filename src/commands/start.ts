import { Args, Command, Options } from "@effect/cli";
import { Console, Effect, Option } from "effect";
import { ConfigStoreService } from "../services/ConfigStore.js";
import { JavaProjectService } from "../services/JavaProject.js";
import { ProcessManagerService } from "../services/ProcessManager.js";
import { TerminalService } from "../services/Terminal.js";

const jvmOption = Options.text("jvm").pipe(
  Options.optional,
  Options.withDescription("JVM options (space-separated)")
);

const detachedOption = Options.boolean("detached").pipe(
  Options.withAlias("d"),
  Options.withDescription("Run in the background, redirecting output to a log file")
);

const debugOption = Options.integer("debug").pipe(
  Options.optional,
  Options.withDescription("Enable JDWP debugging on the given port (e.g. --debug 5005)")
);

const debugSuspendOption = Options.boolean("debug-suspend").pipe(
  Options.withDescription("With --debug, suspend the JVM until a debugger attaches")
);

const jsonOption = Options.boolean("json").pipe(
  Options.withDescription("Emit machine-readable JSON output")
);

const classArg = Args.text({ name: "class" }).pipe(Args.optional);

const programArgs = Args.text({ name: "args" }).pipe(Args.repeated);

export const start = Command.make(
  "start",
  {
    jvm: jvmOption,
    class_: classArg,
    args: programArgs,
    detached: detachedOption,
    debug: debugOption,
    debugSuspend: debugSuspendOption,
    json: jsonOption,
  },
  ({ jvm, class_: classOpt, args: pArgs, detached, debug: debugVal, debugSuspend, json }) =>
    Effect.gen(function* () {
      const project = yield* JavaProjectService;
      const pm = yield* ProcessManagerService;
      const configStore = yield* ConfigStoreService;
      const terminal = yield* TerminalService;

      const jvmOpts = Option.isSome(jvm) ? jvm.value.split(/\s+/).filter((s) => s.length > 0) : [];

      const debug = Option.isSome(debugVal)
        ? { port: debugVal.value, suspend: debugSuspend }
        : null;
      const runOptions = { detached, debug };

      // Shared tail: persist last-run, launch, then emit output.
      const runConfig = (config: {
        mainClass: string;
        programArgs: string[];
        jvmOpts: string[];
      }) =>
        Effect.gen(function* () {
          yield* configStore.saveLastRun(config);
          const record = yield* pm.run(config, runOptions);
          if (json) {
            yield* Console.log(
              JSON.stringify({
                ok: true,
                pid: record.pid,
                logFile: record.logFile,
                debugPort: record.debugPort,
              })
            );
          } else if (detached) {
            yield* Console.log(
              `Started ${record.mainClass} (PID ${record.pid})${
                record.debugPort ? ` [debug:${record.debugPort}]` : ""
              }${record.logFile ? `\nLogs: ${record.logFile}` : ""}`
            );
          } else {
            yield* Console.log(`Running ${record.mainClass}...`);
          }
        }).pipe(
          Effect.catchAll((e) =>
            Effect.gen(function* () {
              const msg = (e as { message?: string }).message ?? String(e);
              if (json) {
                yield* Console.log(JSON.stringify({ ok: false, error: msg }));
              } else {
                yield* Console.error(msg);
              }
              process.exitCode = 1;
            })
          )
        );

      let mainClass: string;

      if (Option.isSome(classOpt)) {
        // Try loading as saved config first
        const loaded = yield* configStore.load(classOpt.value).pipe(Effect.option);

        if (Option.isSome(loaded)) {
          yield* runConfig({
            mainClass: loaded.value.mainClass,
            programArgs: [...loaded.value.programArgs, ...pArgs],
            jvmOpts: [...loaded.value.jvmOpts, ...jvmOpts],
          });
          return;
        }

        mainClass = classOpt.value;
      } else {
        // Interactive selection
        const classes = yield* project.findMainClasses;
        if (classes.length === 0) {
          yield* Console.error("No main classes found");
          return;
        }
        if (classes.length === 1) {
          mainClass = classes[0]!;
        } else {
          const selected = yield* terminal
            .select({
              message: "Select a main class",
              choices: classes.map((c) => ({ value: c, label: c })),
            })
            .pipe(Effect.catchTag("UserCancelled", () => Effect.succeed(null)));
          if (selected === null) return;
          mainClass = selected;
        }
      }

      yield* runConfig({
        mainClass,
        programArgs: [...pArgs],
        jvmOpts,
      });
    })
).pipe(Command.withDescription("Run a Java main class"));
