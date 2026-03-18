import { Context, Data, Effect, Layer } from "effect"
import { FileSystem, Path, Command } from "@effect/platform"
import type { PlatformError } from "@effect/platform/Error"
import { type RunConfig } from "./ConfigStore.js"
import { ProjectRoot, JavaProjectService } from "./JavaProject.js"
import * as crypto from "node:crypto"

export class JavaProcessError extends Data.TaggedError("JavaProcessError")<{
  readonly message: string
}> {}

export class ProcessNotFound extends Data.TaggedError("ProcessNotFound")<{
  readonly className: string
}> {}

export interface RunningProcess {
  readonly mainClass: string
  readonly pid: number
}

export interface ProcessManager {
  readonly run: (config: RunConfig) => Effect.Effect<void, JavaProcessError | PlatformError>
  readonly listRunning: Effect.Effect<RunningProcess[], PlatformError>
  readonly kill: (
    className: string
  ) => Effect.Effect<void, ProcessNotFound | PlatformError>
  readonly killByPid: (pid: number) => Effect.Effect<void, PlatformError>
}

export class ProcessManagerService extends Context.Tag("ProcessManager")<
  ProcessManagerService,
  ProcessManager
>() {}

export class PidDir extends Context.Tag("PidDir")<PidDir, string>() {}

const projectHash = (root: string) =>
  crypto.createHash("md5").update(root).digest("hex")

const isProcessRunning = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

export const ProcessManagerLive = Layer.effect(
  ProcessManagerService,
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const pathSvc = yield* Path.Path
    const pidDir = yield* PidDir
    const root = yield* ProjectRoot
    const project = yield* JavaProjectService

    yield* fs.makeDirectory(pidDir, { recursive: true })

    const hash = projectHash(root)

    const pidFile = (mainClass: string) =>
      pathSvc.join(pidDir, `${hash}-${mainClass}.pid`)

    const run = (config: RunConfig) =>
      Effect.gen(function* () {
        const classpath = yield* project.resolveClasspath

        const args = [
          ...config.jvmOpts,
          "-cp",
          classpath,
          config.mainClass,
          ...config.programArgs,
        ]

        const proc = yield* Command.make("java", ...args).pipe(
          Command.start
        )

        const pid = proc.pid
        yield* fs.writeFileString(pidFile(config.mainClass), String(pid))

        yield* proc.exitCode.pipe(
          Effect.ensuring(
            fs.remove(pidFile(config.mainClass)).pipe(Effect.ignore)
          ),
          Effect.flatMap((code) =>
            code === 0
              ? Effect.void
              : Effect.fail(
                  new JavaProcessError({
                    message: `Java process exited with code ${code}`,
                  })
                )
          )
        )
      }).pipe(Effect.scoped)

    const listRunning = Effect.gen(function* () {
      const exists = yield* fs.exists(pidDir)
      if (!exists) return []

      const entries = yield* fs.readDirectory(pidDir)
      const running: RunningProcess[] = []

      for (const entry of entries) {
        if (!entry.startsWith(hash) || !entry.endsWith(".pid")) continue
        const filePath = pathSvc.join(pidDir, entry)
        const content = yield* fs.readFileString(filePath)
        const pid = parseInt(content.trim(), 10)

        if (isProcessRunning(pid)) {
          const mainClass = entry.slice(hash.length + 1, -4) // remove hash- prefix and .pid suffix
          running.push({ mainClass, pid })
        } else {
          yield* fs.remove(filePath).pipe(Effect.ignore)
        }
      }

      return running
    })

    const killByPid = (pid: number) =>
      Effect.sync(() => {
        try {
          process.kill(pid, "SIGTERM")
        } catch {
          // already dead
        }
      }).pipe(
        Effect.andThen(Effect.sleep("2 seconds")),
        Effect.andThen(
          Effect.sync(() => {
            if (isProcessRunning(pid)) {
              try {
                process.kill(pid, "SIGKILL")
              } catch {
                // already dead
              }
            }
          })
        )
      )

    const kill = (className: string) =>
      Effect.gen(function* () {
        const pf = pidFile(className)
        const exists = yield* fs.exists(pf)
        if (!exists) return yield* new ProcessNotFound({ className })

        const content = yield* fs.readFileString(pf)
        const pid = parseInt(content.trim(), 10)
        yield* killByPid(pid)
        yield* fs.remove(pf).pipe(Effect.ignore)
      })

    return { run, listRunning, kill, killByPid } as const
  })
)
