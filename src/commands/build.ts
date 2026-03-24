import { Command as Cmd } from "@effect/cli";
import { Command } from "@effect/platform";
import { Console, Effect } from "effect";

export const build = Cmd.make("build", {}, () =>
  Effect.gen(function* () {
    yield* Console.log("Compiling...");
    const exitCode = yield* Command.make("mvn", "compile", "-q").pipe(Command.exitCode);
    if (exitCode !== 0) {
      yield* Console.error("Build failed");
    } else {
      yield* Console.log("Build successful");
    }
  })
).pipe(Cmd.withDescription("Compile the project (mvn compile)"));
