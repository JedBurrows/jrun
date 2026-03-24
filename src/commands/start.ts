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

const classArg = Args.text({ name: "class" }).pipe(Args.optional);

const programArgs = Args.text({ name: "args" }).pipe(Args.repeated);

export const start = Command.make(
  "start",
  { jvm: jvmOption, class_: classArg, args: programArgs },
  ({ jvm, class_: classOpt, args: pArgs }) =>
    Effect.gen(function* () {
      const project = yield* JavaProjectService;
      const pm = yield* ProcessManagerService;
      const configStore = yield* ConfigStoreService;
      const terminal = yield* TerminalService;

      const jvmOpts = Option.isSome(jvm) ? jvm.value.split(/\s+/).filter((s) => s.length > 0) : [];

      let mainClass: string;

      if (Option.isSome(classOpt)) {
        // Try loading as saved config first
        const loaded = yield* configStore.load(classOpt.value).pipe(Effect.option);

        if (Option.isSome(loaded)) {
          const config = {
            mainClass: loaded.value.mainClass,
            programArgs: [...loaded.value.programArgs, ...pArgs],
            jvmOpts: [...loaded.value.jvmOpts, ...jvmOpts],
          };
          yield* configStore.saveLastRun(config);
          yield* Console.log(`Running ${config.mainClass}...`);
          yield* pm.run(config);
          return;
        }

        mainClass = classOpt.value;
      } else {
        // Interactive selection
        const classes = yield* project.findMainClasses;
        if (classes.length === 0) {
          yield* Console.error("No main classes found in src/main/java");
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

      const config = {
        mainClass,
        programArgs: [...pArgs],
        jvmOpts,
      };
      yield* configStore.saveLastRun(config);
      yield* Console.log(`Running ${mainClass}...`);
      yield* pm.run(config);
    })
).pipe(Command.withDescription("Run a Java main class"));
