import { Command } from "@effect/cli";
import { NodeContext, NodeRuntime } from "@effect/platform-node";
import { Console, Effect, Layer } from "effect";

import { build } from "./commands/build.js";
import { configs } from "./commands/configs.js";
import { kill } from "./commands/kill.js";
import { list } from "./commands/list.js";
import { logs } from "./commands/logs.js";
import { rerun } from "./commands/rerun.js";
import { save } from "./commands/save.js";
import { start } from "./commands/start.js";
import { status } from "./commands/status.js";
import { ui, uiEffect } from "./commands/ui.js";

import { createRequire } from "node:module";
import * as os from "node:os";
import * as path from "node:path";
import { unsupportedPlatformMessage } from "./platform.js";
import { ConfigDir, ConfigStoreLive } from "./services/ConfigStore.js";
import { JavaProjectLive, ProjectRoot } from "./services/JavaProject.js";
import { LogDir, ProcessManagerLive } from "./services/ProcessManager.js";
import { ProcessProbeLive } from "./services/ProcessProbe.js";
import { TerminalLive } from "./services/Terminal.js";

// Bare `jrun`: launch the dashboard on an interactive terminal; otherwise print
// a usage pointer and exit 0 so pipes/agents don't get a stuck TUI.
const rootHandler = Effect.gen(function* () {
  if (process.stdout.isTTY && process.stdin.isTTY) {
    yield* uiEffect;
  } else {
    yield* Console.log("jrun — run `jrun --help` for available commands.");
  }
});

const jrun = Command.make("jrun", {}, () => rootHandler).pipe(
  Command.withSubcommands([build, list, start, save, rerun, status, kill, configs, logs, ui])
);

const platformError = unsupportedPlatformMessage(process.platform);
if (platformError !== null) {
  console.error(platformError);
  process.exit(1);
}

const cwd = process.cwd();
const jrunHome = path.join(os.homedir(), ".jrun");

const ProjectRootLayer = Layer.succeed(ProjectRoot, cwd);
const ConfigDirLayer = Layer.succeed(ConfigDir, jrunHome);
const LogDirLayer = Layer.succeed(LogDir, path.join(jrunHome, "logs"));

const JavaProjectLayer = JavaProjectLive.pipe(
  Layer.provide(ProjectRootLayer),
  Layer.provide(NodeContext.layer)
);

const ConfigStoreLayer = ConfigStoreLive.pipe(
  Layer.provide(ConfigDirLayer),
  Layer.provide(NodeContext.layer)
);

const ProcessManagerLayer = ProcessManagerLive.pipe(
  Layer.provide(JavaProjectLayer),
  Layer.provide(ProjectRootLayer),
  Layer.provide(LogDirLayer),
  Layer.provide(ProcessProbeLive),
  Layer.provide(NodeContext.layer)
);

const AppLayer = Layer.mergeAll(
  JavaProjectLayer,
  ConfigStoreLayer,
  ProcessManagerLayer,
  TerminalLive
);

// Read the version from package.json so it never drifts from the published
// release. Resolves to the project-root package.json both when linked locally
// (../package.json from dist/main.js) and when published (package.json ships
// alongside dist/).
const pkg = createRequire(import.meta.url)("../package.json") as { version: string };
const cli = Command.run(jrun, { name: "jrun", version: pkg.version });

cli(process.argv).pipe(
  Effect.provide(AppLayer),
  Effect.provide(NodeContext.layer),
  NodeRuntime.runMain
);
