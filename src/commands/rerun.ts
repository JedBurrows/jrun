import { Command } from "@effect/cli";
import { Console, Effect, Option } from "effect";
import { ConfigStoreService } from "../services/ConfigStore.js";
import { ProcessManagerService } from "../services/ProcessManager.js";

export const rerun = Command.make("rerun", {}, () =>
  Effect.gen(function* () {
    const store = yield* ConfigStoreService;
    const pm = yield* ProcessManagerService;

    const config = yield* store.loadLastRun.pipe(
      Effect.map(Option.some),
      Effect.catchTag("NoLastRun", () => Effect.succeed(Option.none()))
    );

    if (Option.isNone(config)) {
      yield* Console.error("No previous run found");
      process.exitCode = 1;
      return;
    }

    yield* Console.log(`Re-running ${config.value.mainClass}...`);
    yield* pm.run(config.value).pipe(
      Effect.catchAll((e) =>
        Effect.gen(function* () {
          yield* Console.error((e as { message?: string }).message ?? String(e));
          process.exitCode = 1;
        })
      )
    );
  })
).pipe(Command.withDescription("Re-run the last command"));
