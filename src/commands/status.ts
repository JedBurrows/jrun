import { Command, Options } from "@effect/cli";
import { Console, Effect } from "effect";
import { ProcessManagerService } from "../services/ProcessManager.js";

const jsonOption = Options.boolean("json").pipe(
  Options.withDescription("Emit machine-readable JSON output")
);

export const status = Command.make("status", { json: jsonOption }, ({ json }) =>
  Effect.gen(function* () {
    const pm = yield* ProcessManagerService;
    const running = yield* pm.listRunning;

    if (json) {
      yield* Console.log(JSON.stringify(running));
      return;
    }

    if (running.length === 0) {
      yield* Console.log("No tracked processes running");
    } else {
      yield* Console.log("Running processes:");
      for (const proc of running) {
        const dbg = proc.debugPort ? ` [debug:${proc.debugPort}]` : "";
        yield* Console.log(`  ${proc.mainClass} (PID ${proc.pid})${dbg}`);
      }
    }
  })
).pipe(Command.withDescription("Show tracked running processes"));
