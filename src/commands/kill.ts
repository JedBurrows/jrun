import { Command, Args } from "@effect/cli"
import { Effect, Console, Option } from "effect"
import { ProcessManagerService, ProcessNotFound } from "../services/ProcessManager.js"

const classArg = Args.text({ name: "class" }).pipe(Args.optional)

export const kill = Command.make(
  "kill",
  { class_: classArg },
  ({ class_: classOpt }) =>
    Effect.gen(function* () {
      const pm = yield* ProcessManagerService

      if (Option.isSome(classOpt)) {
        yield* Console.log(`Stopping ${classOpt.value}...`)
        yield* pm.kill(classOpt.value).pipe(
          Effect.catchTag("ProcessNotFound", () =>
            Console.error(`No tracked process for ${classOpt.value}`)
          )
        )
        yield* Console.log("Stopped.")
      } else {
        const running = yield* pm.listRunning
        if (running.length === 0) {
          yield* Console.log("No tracked processes running")
          return
        }

        if (running.length === 1) {
          const proc = running[0]!
          yield* Console.log(`Stopping ${proc.mainClass} (PID ${proc.pid})...`)
          yield* pm.kill(proc.mainClass)
          yield* Console.log("Stopped.")
        } else {
          yield* Console.log("Running processes:")
          for (let i = 0; i < running.length; i++) {
            yield* Console.log(
              `  ${i + 1}) ${running[i]!.mainClass} (PID ${running[i]!.pid})`
            )
          }
          yield* Console.log("Specify a class name to kill: jrun kill <class>")
        }
      }
    })
).pipe(Command.withDescription("Stop a running process"))
