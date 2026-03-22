import { Command, Args } from "@effect/cli"
import { Effect, Console } from "effect"
import { FileSystem } from "@effect/platform"
import { render } from "ink"
import React from "react"
import * as cp from "node:child_process"
import * as nodefs from "node:fs/promises"
import * as path from "node:path"
import * as os from "node:os"
import { ConfigStoreService } from "../services/ConfigStore.js"
import { TerminalService } from "../services/Terminal.js"
import { ConfigsTui } from "../tui/ConfigsTui.js"

const nameArg = Args.text({ name: "name" })

// jrun configs list
const configsList = Command.make("list", {}, () =>
  Effect.gen(function* () {
    const store = yield* ConfigStoreService
    const names = yield* store.list
    if (names.length === 0) {
      yield* Console.log("No saved configurations.")
    } else {
      for (const name of names) {
        yield* Console.log(name)
      }
    }
  })
).pipe(Command.withDescription("List all saved configurations"))

// jrun configs show <name>
const configsShow = Command.make("show", { name: nameArg }, ({ name }) =>
  Effect.gen(function* () {
    const store = yield* ConfigStoreService
    const config = yield* store.load(name).pipe(
      Effect.catchTag("ConfigNotFound", () =>
        Console.error(`No config found: ${name}`).pipe(Effect.andThen(Effect.void))
      )
    )
    if (config) {
      yield* Console.log(JSON.stringify(config, null, 2))
    }
  })
).pipe(Command.withDescription("Show a saved configuration"))

// jrun configs edit <name>
const configsEdit = Command.make("edit", { name: nameArg }, ({ name }) =>
  Effect.gen(function* () {
    const store = yield* ConfigStoreService
    const exists = yield* store.load(name).pipe(
      Effect.option
    )
    if (exists._tag === "None") {
      yield* Console.error(`No config found: ${name}`)
      return
    }

    const configPath = path.join(os.homedir(), ".jrun", "configs", `${name}.json`)
    const editor = process.env["EDITOR"] ?? "vi"

    const result = cp.spawnSync(editor, [configPath], { stdio: "inherit" })
    if (result.error) {
      yield* Console.error(`Failed to open editor: ${result.error.message}`)
      return
    }

    // Validate the edited file
    const updated = yield* store.load(name).pipe(
      Effect.catchTag("ConfigNotFound", () =>
        Effect.fail(new Error("Config file was deleted during edit"))
      ),
      Effect.catchAll((e) =>
        Effect.fail(new Error(`Invalid config after edit: ${String(e)}`))
      )
    )

    if (!updated.mainClass) {
      yield* Console.error("Invalid config: mainClass is required")
      return
    }
    yield* Console.log(`Saved ${name}`)
  })
).pipe(Command.withDescription("Edit a configuration in $EDITOR"))

// jrun configs delete <name>
const configsDelete = Command.make("delete", { name: nameArg }, ({ name }) =>
  Effect.gen(function* () {
    const store = yield* ConfigStoreService
    const terminal = yield* TerminalService

    const exists = yield* store.load(name).pipe(Effect.option)
    if (exists._tag === "None") {
      yield* Console.error(`No config found: ${name}`)
      return
    }

    const confirmed = yield* terminal.confirm({
      message: `Delete config "${name}"?`,
      initialValue: false,
    }).pipe(Effect.catchTag("UserCancelled", () => Effect.succeed(false)))

    if (!confirmed) return

    const configPath = path.join(os.homedir(), ".jrun", "configs", `${name}.json`)
    const fs = yield* FileSystem.FileSystem
    yield* fs.remove(configPath)
    yield* Console.log(`Deleted ${name}`)
  })
).pipe(Command.withDescription("Delete a saved configuration"))

// jrun configs (no subcommand) — launches the ink TUI
const configsTui = Effect.gen(function* () {
  const store = yield* ConfigStoreService
  const names = yield* store.list

  if (names.length === 0) {
    yield* Console.log("No saved configurations. Use `jrun save <name> <class>` to create one.")
    return
  }

  const configMap: Record<string, import("../services/ConfigStore.js").RunConfig> = {}
  for (const name of names) {
    const config = yield* store.load(name)
    configMap[name] = config
  }

  yield* Effect.promise(() => {
    const { waitUntilExit } = render(
      React.createElement(ConfigsTui, {
        configs: configMap,
        onEdit: (name: string) => {
          const configPath = path.join(os.homedir(), ".jrun", "configs", `${name}.json`)
          const editor = process.env["EDITOR"] ?? "vi"
          cp.spawnSync(editor, [configPath], { stdio: "inherit" })
        },
        onDelete: async (name: string) => {
          const configPath = path.join(os.homedir(), ".jrun", "configs", `${name}.json`)
          await nodefs.unlink(configPath)
        },
      })
    )
    return waitUntilExit()
  })
})

export const configs = Command.make("configs", {}, () => configsTui).pipe(
  Command.withSubcommands([configsList, configsShow, configsEdit, configsDelete]),
  Command.withDescription("Manage saved run configurations")
)
