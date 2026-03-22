import { Context, Data, Effect, Layer } from "effect"
import { FileSystem, Path } from "@effect/platform"
import type { PlatformError } from "@effect/platform/Error"

export interface RunConfig {
  readonly mainClass: string
  readonly programArgs: readonly string[]
  readonly jvmOpts: readonly string[]
}

export class ConfigNotFound extends Data.TaggedError("ConfigNotFound")<{
  readonly name: string
}> {}

export class NoLastRun extends Data.TaggedError("NoLastRun")<{}> {}

export interface ConfigStore {
  readonly save: (
    name: string,
    config: RunConfig
  ) => Effect.Effect<void, PlatformError>
  readonly load: (
    name: string
  ) => Effect.Effect<RunConfig, ConfigNotFound | PlatformError>
  readonly list: Effect.Effect<string[], PlatformError>
  readonly saveLastRun: (config: RunConfig) => Effect.Effect<void, PlatformError>
  readonly loadLastRun: Effect.Effect<RunConfig, NoLastRun | PlatformError>
}

export class ConfigStoreService extends Context.Tag("ConfigStore")<
  ConfigStoreService,
  ConfigStore
>() {}

export class ConfigDir extends Context.Tag("ConfigDir")<ConfigDir, string>() {}

export const ConfigStoreLive = Layer.effect(
  ConfigStoreService,
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const pathSvc = yield* Path.Path
    const configDir = yield* ConfigDir

    const configsDir = pathSvc.join(configDir, "configs")
    yield* fs.makeDirectory(configsDir, { recursive: true })

    const configPath = (name: string) =>
      pathSvc.join(configsDir, `${name}.json`)
    const lastRunPath = pathSvc.join(configDir, "last-run.json")

    const save = (name: string, config: RunConfig) =>
      fs.writeFileString(configPath(name), JSON.stringify(config, null, 2))

    const load = (name: string) =>
      Effect.gen(function* () {
        const filePath = configPath(name)
        const exists = yield* fs.exists(filePath)
        if (!exists) return yield* new ConfigNotFound({ name })
        const content = yield* fs.readFileString(filePath)
        return JSON.parse(content) as RunConfig
      })

    const list = Effect.gen(function* () {
      const exists = yield* fs.exists(configsDir)
      if (!exists) return []
      const entries = yield* fs.readDirectory(configsDir)
      return entries
        .filter((e) => e.endsWith(".json"))
        .map((e) => e.slice(0, -5))
        .sort()
    })

    const saveLastRun = (config: RunConfig) =>
      fs.writeFileString(lastRunPath, JSON.stringify(config, null, 2))

    const loadLastRun = Effect.gen(function* () {
      const exists = yield* fs.exists(lastRunPath)
      if (!exists) return yield* new NoLastRun()
      const content = yield* fs.readFileString(lastRunPath)
      return JSON.parse(content) as RunConfig
    })

    return { save, load, list, saveLastRun, loadLastRun } as const
  })
)
