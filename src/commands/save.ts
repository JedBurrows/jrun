import { Args, Command, Options } from "@effect/cli";
import { Console, Effect, Option } from "effect";
import { ConfigStoreService } from "../services/ConfigStore.js";

const nameArg = Args.text({ name: "name" });
const classArg = Args.text({ name: "class" });
const programArgs = Args.text({ name: "args" }).pipe(Args.repeated);
const jvmOption = Options.text("jvm").pipe(
  Options.optional,
  Options.withDescription("JVM options (space-separated)")
);
const jsonOption = Options.boolean("json").pipe(
  Options.withDescription("Emit machine-readable JSON output")
);

export const save = Command.make(
  "save",
  { name: nameArg, class_: classArg, args: programArgs, jvm: jvmOption, json: jsonOption },
  ({ name, class_: mainClass, args: pArgs, jvm, json }) =>
    Effect.gen(function* () {
      const store = yield* ConfigStoreService;
      const jvmOpts = Option.isSome(jvm) ? jvm.value.split(/\s+/).filter((s) => s.length > 0) : [];

      yield* store.save(name, {
        mainClass,
        programArgs: [...pArgs],
        jvmOpts,
      });
      if (json) {
        yield* Console.log(JSON.stringify({ ok: true, name }));
      } else {
        yield* Console.log(`Saved config: ${name}`);
      }
    })
).pipe(Command.withDescription("Save a run configuration"));
