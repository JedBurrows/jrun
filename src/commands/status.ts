import { Command } from "@effect/cli"
import { Effect, Console } from "effect"
import { ProcessManagerService } from "../services/ProcessManager.js"

export const status = Command.make("status", {}, () =>
  Effect.gen(function* () {
    const pm = yield* ProcessManagerService
    const running = yield* pm.listRunning

    if (running.length === 0) {
      yield* Console.log("No tracked processes running")
    } else {
      yield* Console.log("Running processes:")
      for (const proc of running) {
        yield* Console.log(`  ${proc.mainClass} (PID ${proc.pid})`)
      }
    }
  })
).pipe(Command.withDescription("Show tracked running processes"))
