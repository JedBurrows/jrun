import { Args, Command, Options } from "@effect/cli";
import { Console, Effect, Option } from "effect";
import { ProcessManagerService } from "../services/ProcessManager.js";
import { TerminalService } from "../services/Terminal.js";
import { resolveKillTarget } from "./killResolve.js";

const targetArg = Args.text({ name: "class-or-pid" }).pipe(Args.optional);
const jsonOption = Options.boolean("json").pipe(
  Options.withDescription("Emit machine-readable JSON output")
);
const forceOption = Options.boolean("force").pipe(
  Options.withDescription("Kill a PID even if it is not a jrun-managed process")
);

export const kill = Command.make(
  "kill",
  { target: targetArg, json: jsonOption, force: forceOption },
  ({ target, json, force }) =>
    Effect.gen(function* () {
      const pm = yield* ProcessManagerService;
      const terminal = yield* TerminalService;
      const running = yield* pm.listRunning;

      if (Option.isSome(target)) {
        const resolved = resolveKillTarget(target.value, running);
        if (resolved.kind === "notfound") {
          if (json) {
            yield* Console.log(
              JSON.stringify({ ok: false, error: `No tracked process for ${target.value}` })
            );
          } else {
            yield* Console.error(`No tracked process for ${target.value}`);
          }
          yield* Effect.sync(() => {
            process.exitCode = 1;
          });
          return;
        }
        if (resolved.kind === "ambiguous") {
          if (json) {
            yield* Console.log(
              JSON.stringify({
                ok: false,
                error: "ambiguous",
                instances: resolved.instances.map((r) => ({ pid: r.pid, startedAt: r.startedAt })),
              })
            );
            yield* Effect.sync(() => {
              process.exitCode = 1;
            });
            return;
          }
          const chosen = yield* terminal
            .select({
              message: `Multiple ${target.value} running — which PID?`,
              choices: resolved.instances.map((r) => ({
                value: String(r.pid),
                label: `PID ${r.pid} (started ${r.startedAt ?? "?"})`,
              })),
            })
            .pipe(Effect.catchTag("UserCancelled", () => Effect.succeed(null)));
          if (chosen === null) return;
          yield* pm.killByPid(Number(chosen));
          yield* Console.log(`Stopped PID ${chosen}.`);
          return;
        }
        // resolved.kind === "pid"
        if (!resolved.owned && !force) {
          if (json) {
            yield* Console.log(
              JSON.stringify({ ok: false, error: "unmanaged pid", pid: resolved.pid })
            );
          } else {
            yield* Console.error(
              `PID ${resolved.pid} is not a jrun-managed process. Use --force to kill it anyway.`
            );
          }
          yield* Effect.sync(() => {
            process.exitCode = 1;
          });
          return;
        }
        yield* pm.killByPid(resolved.pid);
        if (json) {
          yield* Console.log(JSON.stringify({ ok: true, pid: resolved.pid }));
        } else {
          yield* Console.log(`Stopped PID ${resolved.pid}.`);
        }
        return;
      }

      // No argument: 0 / 1 / many.
      if (running.length === 0) {
        if (json) {
          yield* Console.log(JSON.stringify({ ok: false, error: "no tracked processes running" }));
          yield* Effect.sync(() => {
            process.exitCode = 1;
          });
        } else {
          yield* Console.log("No tracked processes running");
        }
        return;
      }
      if (running.length === 1) {
        const proc = running[0]!;
        yield* pm.killByPid(proc.pid);
        if (json) {
          yield* Console.log(JSON.stringify({ ok: true, pid: proc.pid }));
        } else {
          yield* Console.log(`Stopped ${proc.mainClass} (PID ${proc.pid}).`);
        }
        return;
      }
      if (json) {
        yield* Console.log(
          JSON.stringify({ ok: false, error: "ambiguous: specify a class or pid" })
        );
        yield* Effect.sync(() => {
          process.exitCode = 1;
        });
        return;
      }
      const selected = yield* terminal
        .select({
          message: "Which process to kill?",
          choices: running.map((p) => ({
            value: String(p.pid),
            label: `${p.mainClass} (PID ${p.pid})`,
          })),
        })
        .pipe(Effect.catchTag("UserCancelled", () => Effect.succeed(null)));
      if (selected === null) return;
      yield* pm.killByPid(Number(selected));
      yield* Console.log(`Stopped PID ${selected}.`);
    })
).pipe(
  Command.withDescription(
    "Stop a running process (by class name or PID; --force for an unmanaged PID)"
  )
);
