import { Command } from "@effect/cli";
import { Console, Effect } from "effect";
import { JavaProjectService } from "../services/JavaProject.js";

export const list = Command.make("list", {}, () =>
  Effect.gen(function* () {
    const project = yield* JavaProjectService;
    const classes = yield* project.findMainClasses;

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
