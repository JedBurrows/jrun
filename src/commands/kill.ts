import { Args, Command, Options } from "@effect/cli";
import { Console, Effect, Option } from "effect";
import { ProcessManagerService } from "../services/ProcessManager.js";
import { TerminalService } from "../services/Terminal.js";

const classArg = Args.text({ name: "class" }).pipe(Args.optional);

const jsonOption = Options.boolean("json").pipe(
  Options.withDescription("Emit machine-readable JSON output")
);

export const kill = Command.make(
  "kill",
  { class_: classArg, json: jsonOption },
  ({ class_: classOpt, json }) =>
    Effect.gen(function* () {
      const pm = yield* ProcessManagerService;
      const terminal = yield* TerminalService;

      if (Option.isSome(classOpt)) {
        const target = classOpt.value;
        if (!json) {
          yield* Console.log(`Stopping ${target}...`);
        }
        const outcome = yield* pm.kill(target).pipe(
          Effect.as("ok" as const),
          Effect.catchTag("ProcessNotFound", () => Effect.succeed("notfound" as const))
        );
        if (outcome === "notfound") {
          if (json) {
            yield* Console.log(
              JSON.stringify({ ok: false, error: `No tracked process for ${target}` })
            );
            yield* Effect.sync(() => {
              process.exitCode = 1;
            });
            return;
          }
          yield* Console.error(`No tracked process for ${target}`);
          yield* Effect.sync(() => {
            process.exitCode = 1;
          });
          return;
        }
        if (json) {
          yield* Console.log(JSON.stringify({ ok: true, mainClass: target }));
        } else {
          yield* Console.log(`Stopped ${target}.`);
        }
        return;
      }

      const running = yield* pm.listRunning;

      if (json) {
        if (running.length === 0) {
          yield* Console.log(JSON.stringify({ ok: false, error: "no tracked processes running" }));
          yield* Effect.sync(() => {
            process.exitCode = 1;
          });
          return;
        }
        if (running.length === 1) {
          const proc = running[0]!;
          yield* pm.kill(proc.mainClass);
          yield* Console.log(JSON.stringify({ ok: true, mainClass: proc.mainClass }));
          return;
        }
        yield* Console.log(JSON.stringify({ ok: false, error: "ambiguous: specify a class" }));
        yield* Effect.sync(() => {
          process.exitCode = 1;
        });
        return;
      }

      if (running.length === 0) {
        yield* Console.log("No tracked processes running");
        return;
      }

      if (running.length === 1) {
        const proc = running[0]!;
        yield* Console.log(`Stopping ${proc.mainClass} (PID ${proc.pid})...`);
        yield* pm.kill(proc.mainClass);
        yield* Console.log("Stopped.");
      } else {
        const selected = yield* terminal
          .select({
            message: "Which process to kill?",
            choices: running.map((p) => ({
              value: p.mainClass,
              label: `${p.mainClass} (PID ${p.pid})`,
            })),
          })
          .pipe(Effect.catchTag("UserCancelled", () => Effect.succeed(null)));
        if (selected === null) return;
        yield* Console.log(`Stopping ${selected}...`);
        yield* pm.kill(selected);
        yield* Console.log("Stopped.");
      }
    })
).pipe(Command.withDescription("Stop a running process"));
