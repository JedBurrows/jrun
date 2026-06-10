import * as childProcess from "node:child_process";
import * as crypto from "node:crypto";
import * as nodeFs from "node:fs";
import { Command, CommandExecutor, FileSystem, Path } from "@effect/platform";
import type { PlatformError } from "@effect/platform/Error";
import { Context, Data, Effect, Layer, Option } from "effect";
import type { RunConfig } from "./ConfigStore.js";
import { JavaProjectService, ProjectRoot } from "./JavaProject.js";
import { ProcessProbeService } from "./ProcessProbe.js";
import { matchProcess, projectMarker } from "./discovery.js";
import {
  compactStamp,
  logFileName,
  pickLogByPid,
  pickNewestLog,
  pickRunningLog,
} from "./logNaming.js";

export class JavaProcessError extends Data.TaggedError("JavaProcessError")<{
  readonly message: string;
}> {}

export interface ProcessRecord {
  readonly pid: number;
  readonly mainClass: string;
  readonly startedAt: string | null;
  readonly logFile: string | null;
  readonly args: readonly string[];
  readonly debugPort: number | null;
}

export interface RunOptions {
  readonly detached?: boolean;
  readonly debug?: { readonly port: number; readonly suspend: boolean } | null;
}

export interface ProcessManager {
  readonly run: (
    config: RunConfig,
    options?: RunOptions
  ) => Effect.Effect<ProcessRecord, JavaProcessError | PlatformError>;
  readonly listRunning: Effect.Effect<ProcessRecord[], PlatformError>;
  readonly killByPid: (pid: number) => Effect.Effect<void, PlatformError>;
  readonly readLog: (mainClass: string) => Effect.Effect<string | null, PlatformError>;
  readonly readLogByPid: (
    mainClass: string,
    pid: number
  ) => Effect.Effect<string | null, PlatformError>;
  readonly readLogByPidAnyClass: (pid: number) => Effect.Effect<string | null, PlatformError>;
}

export class ProcessManagerService extends Context.Tag("ProcessManager")<
  ProcessManagerService,
  ProcessManager
>() {}

export class LogDir extends Context.Tag("LogDir")<LogDir, string>() {}
export class JavaBin extends Context.Tag("JavaBin")<JavaBin, string>() {}

export const buildJavaArgs = (
  config: RunConfig,
  classpath: string,
  debug: { port: number; suspend: boolean } | null
): string[] => {
  const debugArgs = debug ? [debugJvmArg(debug.port, debug.suspend)] : [];
  return [
    ...debugArgs,
    ...config.jvmOpts,
    "-cp",
    classpath,
    config.mainClass,
    ...config.programArgs,
  ];
};

const projectHash = (root: string) => crypto.createHash("md5").update(root).digest("hex");

const isProcessRunning = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

export const debugJvmArg = (port: number, suspend: boolean): string =>
  `-agentlib:jdwp=transport=dt_socket,server=y,suspend=${suspend ? "y" : "n"},address=*:${port}`;

export const ProcessManagerLive = Layer.effect(
  ProcessManagerService,
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const pathSvc = yield* Path.Path;
    const root = yield* ProjectRoot;
    const project = yield* JavaProjectService;
    const executor = yield* CommandExecutor.CommandExecutor;
    const logDir = yield* LogDir;
    const probe = yield* ProcessProbeService;

    yield* fs.makeDirectory(logDir, { recursive: true });

    const javaBin = yield* Effect.serviceOption(JavaBin).pipe(
      Effect.map(Option.getOrElse(() => "java"))
    );

    const hash = projectHash(root);
    // The marker jrun injects into every JVM it launches, and the token
    // listRunning matches on. Same helper on both sides → can't drift.
    const marker = projectMarker(hash);

    const listLogNames = Effect.gen(function* () {
      const exists = yield* fs.exists(logDir);
      return exists ? yield* fs.readDirectory(logDir) : [];
    });

    const deriveLogFile = (mainClass: string, pid: number) =>
      Effect.gen(function* () {
        const entries = yield* listLogNames;
        const name = pickRunningLog(entries, hash, mainClass, pid);
        return name ? pathSvc.join(logDir, name) : null;
      });

    const run = (config: RunConfig, options: RunOptions = {}) =>
      Effect.gen(function* () {
        const classpath = yield* project.resolveClasspath(config.mainClass);
        const debug = options.debug ?? null;
        // Marker first, single chokepoint feeding BOTH the detached and the
        // foreground paths, so every jrun-launched JVM is discoverable.
        const args = [marker, ...buildJavaArgs(config, classpath, debug)];
        const startedAt = new Date().toISOString();

        if (options.detached) {
          const stampCompact = compactStamp(startedAt);
          const tmpLog = pathSvc.join(logDir, `${hash}-${config.mainClass}-${stampCompact}.tmp`);
          const record: ProcessRecord = yield* Effect.try({
            try: () => {
              const fd = nodeFs.openSync(tmpLog, "a");
              let child: childProcess.ChildProcess;
              try {
                child = childProcess.spawn(javaBin, args, {
                  detached: true,
                  stdio: ["ignore", fd, fd],
                  cwd: root,
                });
              } finally {
                nodeFs.closeSync(fd);
              }
              child.unref();
              if (child.pid === undefined) {
                throw new Error("failed to spawn detached process (no pid)");
              }
              // Best-effort rename — NEVER fail run after the JVM is live (a
              // rename failure must not report a phantom failure + orphan).
              const finalLog = pathSvc.join(
                logDir,
                logFileName(hash, config.mainClass, stampCompact, child.pid)
              );
              let logFile = finalLog;
              try {
                nodeFs.renameSync(tmpLog, finalLog);
              } catch {
                logFile = tmpLog;
              }
              return {
                pid: child.pid,
                mainClass: config.mainClass,
                startedAt,
                logFile,
                args: [...config.programArgs],
                debugPort: debug ? debug.port : null,
              };
            },
            catch: (e) =>
              new JavaProcessError({ message: `Failed to start detached: ${String(e)}` }),
          });
          return record;
        }

        // Foreground: inherit stdio, block until exit.
        const proc = yield* Command.make(javaBin, ...args).pipe(
          Command.workingDirectory(root),
          Command.stdout("inherit"),
          Command.stderr("inherit"),
          Command.stdin("inherit"),
          Command.start
        );
        const record: ProcessRecord = {
          pid: proc.pid,
          mainClass: config.mainClass,
          startedAt,
          logFile: null,
          args: [...config.programArgs],
          debugPort: debug ? debug.port : null,
        };
        yield* proc.exitCode.pipe(
          Effect.flatMap((code) =>
            code === 0
              ? Effect.void
              : Effect.fail(
                  new JavaProcessError({ message: `Java process exited with code ${code}` })
                )
          )
        );
        return record;
      }).pipe(Effect.scoped, Effect.provideService(CommandExecutor.CommandExecutor, executor));

    const listRunning = Effect.gen(function* () {
      const snaps = yield* probe.listJava;
      const records: ProcessRecord[] = [];
      for (const snap of snaps) {
        const d = matchProcess(snap, { marker });
        if (!d) continue;
        const logFile = yield* deriveLogFile(d.mainClass, d.pid);
        records.push({
          pid: d.pid,
          mainClass: d.mainClass,
          startedAt: d.startedAt,
          logFile,
          args: d.args,
          debugPort: d.debugPort,
        });
      }
      return records;
    });

    /** Signal a pid, optionally its whole group; ESRCH on the group call
     *  falls back to the single pid (leader already gone). */
    const sendSignal = (pid: number, signal: NodeJS.Signals, group: boolean) => {
      try {
        process.kill(group ? -pid : pid, signal);
      } catch (e) {
        if (group && (e as NodeJS.ErrnoException).code === "ESRCH") {
          try {
            process.kill(pid, signal);
          } catch {
            /* already dead */
          }
        }
        /* otherwise already dead */
      }
    };

    const killByPid = (pid: number) =>
      Effect.gen(function* () {
        const snap = yield* probe.inspect(pid);
        // Group-signal when the pid is its own group leader (everything jrun
        // spawns detached) AND when /proc can't be read (default true) — never
        // downgrade to single-pid on a read race and strand detached children.
        const group = snap === null ? true : snap.pgid === pid;
        yield* Effect.sync(() => sendSignal(pid, "SIGTERM", group));
        yield* Effect.sleep("2 seconds");
        yield* Effect.sync(() => {
          if (isProcessRunning(pid)) sendSignal(pid, "SIGKILL", group);
        });
      });

    const readFileOrNull = (file: string): Effect.Effect<string | null, PlatformError> =>
      fs.readFileString(file).pipe(Effect.catchAll(() => Effect.succeed<string | null>(null)));

    const readLog = (mainClass: string) =>
      Effect.gen(function* () {
        const entries = yield* listLogNames;
        const name = pickNewestLog(entries, hash, mainClass);
        return name ? yield* readFileOrNull(pathSvc.join(logDir, name)) : null;
      });

    const readLogByPid = (mainClass: string, pid: number) =>
      Effect.gen(function* () {
        const entries = yield* listLogNames;
        const name = pickRunningLog(entries, hash, mainClass, pid);
        return name ? yield* readFileOrNull(pathSvc.join(logDir, name)) : null;
      });

    const readLogByPidAnyClass = (pid: number) =>
      Effect.gen(function* () {
        const entries = yield* listLogNames;
        const name = pickLogByPid(entries, hash, pid);
        return name ? yield* readFileOrNull(pathSvc.join(logDir, name)) : null;
      });

    return { run, listRunning, killByPid, readLog, readLogByPid, readLogByPidAnyClass } as const;
  })
);
