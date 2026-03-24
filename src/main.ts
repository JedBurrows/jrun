import { Command } from "@effect/cli";
import { NodeContext, NodeRuntime } from "@effect/platform-node";
import { Effect, Layer } from "effect";

import { build } from "./commands/build.js";
import { configs } from "./commands/configs.js";
import { kill } from "./commands/kill.js";
import { list } from "./commands/list.js";
import { rerun } from "./commands/rerun.js";
import { save } from "./commands/save.js";
import { start } from "./commands/start.js";
import { status } from "./commands/status.js";

import * as os from "node:os";
import * as path from "node:path";
import { ConfigDir, ConfigStoreLive } from "./services/ConfigStore.js";
import { JavaProjectLive, ProjectRoot } from "./services/JavaProject.js";
import { PidDir, ProcessManagerLive } from "./services/ProcessManager.js";
import { TerminalLive } from "./services/Terminal.js";

const jrun = Command.make("jrun").pipe(
  Command.withSubcommands([build, list, start, save, rerun, status, kill, configs])
);

const cwd = process.cwd();
const jrunHome = path.join(os.homedir(), ".jrun");

const ProjectRootLayer = Layer.succeed(ProjectRoot, cwd);
const ConfigDirLayer = Layer.succeed(ConfigDir, jrunHome);
const PidDirLayer = Layer.succeed(PidDir, path.join(jrunHome, "pids"));

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
  Layer.provide(PidDirLayer),
  Layer.provide(NodeContext.layer)
);

const AppLayer = Layer.mergeAll(
  JavaProjectLayer,
  ConfigStoreLayer,
  ProcessManagerLayer,
  TerminalLive
);

const cli = Command.run(jrun, { name: "jrun", version: "0.1.0" });

cli(process.argv).pipe(
  Effect.provide(AppLayer),
  Effect.provide(NodeContext.layer),
  NodeRuntime.runMain
);
