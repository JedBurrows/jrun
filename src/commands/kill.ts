import { Command, Args } from "@effect/cli"
import { Effect, Console, Option } from "effect"
import { ProcessManagerService, ProcessNotFound } from "../services/ProcessManager.js"
import { TerminalService } from "../services/Terminal.js"

const classArg = Args.text({ name: "class" }).pipe(Args.optional)

export const kill = Command.make(
  "kill",
  { class_: classArg },
  ({ class_: classOpt }) =>
    Effect.gen(function* () {
      const pm = yield* ProcessManagerService
      const terminal = yield* TerminalService

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
          const selected = yield* terminal.select({
            message: "Which process to kill?",
            choices: running.map((p) => ({
              value: p.mainClass,
              label: `${p.mainClass} (PID ${p.pid})`,
            })),
          }).pipe(Effect.catchTag("UserCancelled", () => Effect.succeed(null)))
          if (selected === null) return
          yield* Console.log(`Stopping ${selected}...`)
          yield* pm.kill(selected)
          yield* Console.log("Stopped.")
        }
      }
    })
).pipe(Command.withDescription("Stop a running process"))
