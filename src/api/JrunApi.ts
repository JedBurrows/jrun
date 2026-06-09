import { Effect, Runtime } from "effect";
import { ConfigStoreService, type RunConfig } from "../services/ConfigStore.js";
import { JavaProjectService } from "../services/JavaProject.js";
import { ProcessManagerService, type ProcessRecord } from "../services/ProcessManager.js";

export interface StartSpec {
  readonly mainClass?: string;
  readonly configName?: string;
  readonly args?: readonly string[];
  readonly jvmOpts?: readonly string[];
  readonly detached?: boolean;
  readonly debug?: { readonly port: number; readonly suspend: boolean } | null;
}

/**
 * Promise-returning adapter over the Effect services. Both the CLI (which stays
 * Effect-native) and the future Ink/React TUI go through this seam; this is the
 * bridge for non-Effect consumers. Build it with {@link makeJrunApi} over a
 * runtime that already has the services in context.
 *
 * Contract:
 * - Methods reject with a `FiberFailure` wrapping the underlying failure. The
 *   original `Error.message` is preserved (`error.message` / `String(error)`),
 *   so a consumer can always surface a readable message. The underlying service
 *   failures are `Data.TaggedError` instances (e.g. `JavaProcessError`), but they
 *   arrive cause-wrapped — to branch on `_tag` a consumer must unwrap the cause,
 *   not read `_tag` off the caught value directly. (If Phase 4 needs ergonomic
 *   tagged-error handling, map known failures to plain shapes at this seam.)
 * - `loadConfig` returns `null` rather than rejecting on a missing config;
 *   `loadLastRun` returns `null` when there is no previous run; `kill` resolves
 *   even if the process is already gone.
 * - `makeJrunApi` does not own the runtime's lifecycle; the caller is
 *   responsible for creating and disposing it.
 */
export interface JrunApi {
  listConfigs(): Promise<string[]>;
  loadConfig(name: string): Promise<RunConfig | null>;
  loadLastRun(): Promise<RunConfig | null>;
  saveConfig(name: string, cfg: RunConfig): Promise<void>;
  deleteConfig(name: string): Promise<void>;
  listMainClasses(): Promise<string[]>;
  listRunning(): Promise<ProcessRecord[]>;
  /**
   * Defaults to a detached run. Passing `detached: false` runs in the
   * foreground, which blocks until the process exits — only do that for a caller
   * that wants to await the whole run.
   */
  start(spec: StartSpec): Promise<ProcessRecord>;
  kill(mainClass: string): Promise<void>;
}

type Services = JavaProjectService | ProcessManagerService | ConfigStoreService;

export const makeJrunApi = (runtime: Runtime.Runtime<Services>): JrunApi => {
  const run = Runtime.runPromise(runtime);
  return {
    listConfigs: () =>
      run(
        Effect.gen(function* () {
          const s = yield* ConfigStoreService;
          return yield* s.list;
        })
      ),
    loadConfig: (name) =>
      run(
        Effect.gen(function* () {
          const s = yield* ConfigStoreService;
          return yield* s
            .load(name)
            .pipe(Effect.catchTag("ConfigNotFound", () => Effect.succeed<RunConfig | null>(null)));
        })
      ),
    loadLastRun: () =>
      run(
        Effect.gen(function* () {
          const s = yield* ConfigStoreService;
          return yield* s.loadLastRun.pipe(
            Effect.catchTag("NoLastRun", () => Effect.succeed<RunConfig | null>(null))
          );
        })
      ),
    saveConfig: (name, cfg) =>
      run(
        Effect.gen(function* () {
          const s = yield* ConfigStoreService;
          yield* s.save(name, cfg);
        })
      ),
    deleteConfig: (name) =>
      run(
        Effect.gen(function* () {
          const s = yield* ConfigStoreService;
          yield* s.delete(name);
        })
      ),
    listMainClasses: () =>
      run(
        Effect.gen(function* () {
          const s = yield* JavaProjectService;
          return yield* s.findMainClasses;
        })
      ),
    listRunning: () =>
      run(
        Effect.gen(function* () {
          const s = yield* ProcessManagerService;
          return yield* s.listRunning;
        })
      ),
    start: (spec) =>
      run(
        Effect.gen(function* () {
          const configStore = yield* ConfigStoreService;
          const pm = yield* ProcessManagerService;
          let config: RunConfig;
          if (spec.configName) {
            const loaded = yield* configStore.load(spec.configName);
            config = {
              mainClass: loaded.mainClass,
              programArgs: [...loaded.programArgs, ...(spec.args ?? [])],
              jvmOpts: [...loaded.jvmOpts, ...(spec.jvmOpts ?? [])],
            };
          } else {
            if (!spec.mainClass) {
              return yield* Effect.fail(new Error("start requires mainClass or configName"));
            }
            config = {
              mainClass: spec.mainClass,
              programArgs: [...(spec.args ?? [])],
              jvmOpts: [...(spec.jvmOpts ?? [])],
            };
          }
          yield* configStore.saveLastRun(config);
          return yield* pm.run(config, {
            detached: spec.detached ?? true,
            debug: spec.debug ?? null,
          });
        })
      ),
    // kill swallows ProcessNotFound: the dashboard kills a row it believes is
    // running; a race where it already exited should not reject.
    kill: (mainClass) =>
      run(
        Effect.gen(function* () {
          const s = yield* ProcessManagerService;
          yield* s.kill(mainClass).pipe(Effect.catchTag("ProcessNotFound", () => Effect.void));
        })
      ),
  };
};
