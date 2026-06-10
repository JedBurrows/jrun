import * as cp from "node:child_process";
import * as os from "node:os";
import * as path from "node:path";
import { Command } from "@effect/cli";
import type { FileSystem } from "@effect/platform";
import { Console, Effect } from "effect";
import { render } from "ink";
import React from "react";
import { type JrunApi, makeJrunApi } from "../api/JrunApi.js";
import type { ConfigStoreService } from "../services/ConfigStore.js";
import type { JavaProjectService } from "../services/JavaProject.js";
import type { ProcessManagerService } from "../services/ProcessManager.js";
import { Dashboard, type DashboardIntent } from "../tui/dashboard/Dashboard.js";

type Services =
  | JavaProjectService
  | ProcessManagerService
  | ConfigStoreService
  | FileSystem.FileSystem;

const isInteractive = (): boolean => Boolean(process.stdout.isTTY && process.stdin.isTTY);

// Render the dashboard once; resolve with the exit intent only AFTER Ink has
// fully unmounted and restored the terminal (via waitUntilExit). This ordering
// matters for the edit flow: the loop's synchronous spawnSync($EDITOR) must not
// run while Ink still owns raw mode + the alt-screen.
const runDashboardOnce = (api: JrunApi): Promise<DashboardIntent> => {
  let intent: DashboardIntent = { type: "quit" };
  const instance = render(
    React.createElement(Dashboard, {
      api,
      onExit: (i: DashboardIntent) => {
        intent = i;
        instance.unmount();
      },
    })
  );
  return instance.waitUntilExit().then(() => intent);
};

const configFilePath = (name: string) =>
  path.join(os.homedir(), ".jrun", "configs", `${name}.json`);

// Alternate screen buffer (the trick lazygit/vim use): on enter the terminal
// swaps to a blank scratch screen; on leave it restores the prior contents and
// cursor. Without this, the last rendered frame is left behind in scrollback on
// quit. `1049` saves/restores the cursor as part of the switch.
const ALT_SCREEN_ENTER = "\x1b[?1049h";
const ALT_SCREEN_LEAVE = "\x1b[?1049l";

// Loop: run dashboard; on {edit} spawn $EDITOR then re-render; on {quit} stop.
const runDashboardLoop = async (api: JrunApi): Promise<void> => {
  process.stdout.write(ALT_SCREEN_ENTER);
  try {
    for (;;) {
      const intent = await runDashboardOnce(api);
      if (intent.type === "quit") return;
      if (intent.type === "edit") {
        const editor = process.env["EDITOR"] ?? "vi";
        // Drop back to the normal screen so the editor owns a clean terminal,
        // then return to the alt screen to re-render the dashboard.
        process.stdout.write(ALT_SCREEN_LEAVE);
        cp.spawnSync(editor, [configFilePath(intent.name)], { stdio: "inherit" });
        process.stdout.write(ALT_SCREEN_ENTER);
      }
    }
  } finally {
    // Always restore the original screen, even if the dashboard throws.
    process.stdout.write(ALT_SCREEN_LEAVE);
  }
};

/**
 * Launches the interactive dashboard. Guards on an interactive terminal:
 * Ink throws "Raw mode is not supported" when stdin is not a TTY, so on a
 * non-TTY we print an error and set exit code 1 rather than calling `render`.
 */
export const uiEffect = Effect.gen(function* () {
  if (!isInteractive()) {
    yield* Console.error("jrun ui requires an interactive terminal.");
    yield* Effect.sync(() => {
      process.exitCode = 1;
    });
    return;
  }
  const runtime = yield* Effect.runtime<Services>();
  const api = makeJrunApi(runtime);
  yield* Effect.promise(() => runDashboardLoop(api));
});

export const ui = Command.make("ui", {}, () => uiEffect).pipe(
  Command.withDescription("Launch the interactive dashboard")
);
