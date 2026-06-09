import { Command, Options } from "@effect/cli";
import { Console, Effect } from "effect";
import { JavaProjectService } from "../services/JavaProject.js";

const jsonOption = Options.boolean("json").pipe(
  Options.withDescription("Emit machine-readable JSON output")
);

export const list = Command.make("list", { json: jsonOption }, ({ json }) =>
  Effect.gen(function* () {
    const project = yield* JavaProjectService;
    const classes = yield* project.findMainClasses;

    if (json) {
      yield* Console.log(JSON.stringify(classes));
      return;
    }

    if (classes.length === 0) {
      yield* Console.log("No main classes found");
    } else {
      yield* Console.log("Available main classes:");
      for (const cls of classes) {
        yield* Console.log(`  ${cls}`);
      }
    }
  })
).pipe(Command.withDescription("List all main classes in the project"));
