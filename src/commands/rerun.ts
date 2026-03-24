import { Command } from "@effect/cli";
import { Console, Effect } from "effect";
import { ConfigStoreService, NoLastRun } from "../services/ConfigStore.js";
import { ProcessManagerService } from "../services/ProcessManager.js";

export const rerun = Command.make("rerun", {}, () =>
  Effect.gen(function* () {
    const store = yield* ConfigStoreService;
    const pm = yield* ProcessManagerService;

    const config = yield* store.loadLastRun.pipe(
      Effect.catchTag("NoLastRun", () =>
        Effect.gen(function* () {
          yield* Console.error("No previous run found");
          return yield* Effect.fail(new NoLastRun());
        })
      )
    );

    yield* Console.log(`Re-running ${config.mainClass}...`);
    yield* pm.run(config);
  })
).pipe(Command.withDescription("Re-run the last command"));
