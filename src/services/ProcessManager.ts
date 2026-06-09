import * as childProcess from "node:child_process";
import * as crypto from "node:crypto";
import * as nodeFs from "node:fs";
import { Command, CommandExecutor, FileSystem, Path } from "@effect/platform";
import type { PlatformError } from "@effect/platform/Error";
import { Context, Data, Effect, Layer, Option } from "effect";
import type { RunConfig } from "./ConfigStore.js";
import { JavaProjectService, ProjectRoot } from "./JavaProject.js";

export class JavaProcessError extends Data.TaggedError("JavaProcessError")<{
  readonly message: string;
}> {}

export class ProcessNotFound extends Data.TaggedError("ProcessNotFound")<{
  readonly className: string;
}> {}

export interface ProcessRecord {
  readonly pid: number;
  readonly mainClass: string;
  readonly startedAt: string | null;
  readonly logFile: string | null;
  readonly args: readonly string[];
  readonly debugPort: number | null;
  /**
   * Whether the process was spawned detached (its own process group). When
   * true, {@link ProcessManager.kill} signals the whole group (`-pid`) so child
   * processes holding ports are also terminated.
   */
  readonly detached: boolean;
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
  readonly kill: (className: string) => Effect.Effect<void, ProcessNotFound | PlatformError>;
  readonly killByPid: (pid: number, group?: boolean) => Effect.Effect<void, PlatformError>;
  /**
   * Returns the contents of the most-recent log file for `mainClass`, whether
   * the process is still running or has already exited. Returns `null` when no
   * log file can be found or read (e.g. a foreground run, or the class has
   * never been started detached).
   */
  readonly readLog: (mainClass: string) => Effect.Effect<string | null, PlatformError>;
}

export class ProcessManagerService extends Context.Tag("ProcessManager")<
  ProcessManagerService,
  ProcessManager
>() {}

export class PidDir extends Context.Tag("PidDir")<PidDir, string>() {}

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

/**
 * Parse a PID file's contents into a {@link ProcessRecord}.
 *
 * `pid` is the only required field. All other fields fall back to defaults
 * derived from the file name (`mainClass`) or its mtime (`startedAt`), or to
 * `null`/`[]` when absent. Each JSON field is type-checked so a corrupt or
 * hand-edited file cannot inject wrong types.
 *
 * Returns `undefined` for empty content, invalid JSON, or a record without a
 * numeric `pid`. Callers MUST NOT reap files that yield `undefined`: it may be a
 * mid-flight partial write from a live, starting process.
 */
const parseRecord = (
  content: string,
  mainClassFromName: string,
  mtimeIso: string | null
): ProcessRecord | undefined => {
  const trimmed = content.trim();
  if (trimmed.length === 0) return undefined;
  // Legacy format: a bare integer PID
  if (/^\d+$/.test(trimmed)) {
    return {
      pid: Number.parseInt(trimmed, 10),
      mainClass: mainClassFromName,
      startedAt: mtimeIso,
      logFile: null,
      args: [],
      debugPort: null,
      detached: false,
    };
  }
  try {
    const obj = JSON.parse(trimmed) as Partial<ProcessRecord>;
    if (typeof obj.pid !== "number") return undefined;
    return {
      pid: obj.pid,
      mainClass: typeof obj.mainClass === "string" ? obj.mainClass : mainClassFromName,
      startedAt: typeof obj.startedAt === "string" ? obj.startedAt : mtimeIso,
      logFile: typeof obj.logFile === "string" ? obj.logFile : null,
      args: Array.isArray(obj.args) ? obj.args : [],
      debugPort: typeof obj.debugPort === "number" ? obj.debugPort : null,
      detached: typeof obj.detached === "boolean" ? obj.detached : false,
    };
  } catch {
    return undefined;
  }
};

export const ProcessManagerLive = Layer.effect(
  ProcessManagerService,
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const pathSvc = yield* Path.Path;
    const pidDir = yield* PidDir;
    const root = yield* ProjectRoot;
    const project = yield* JavaProjectService;
    const executor = yield* CommandExecutor.CommandExecutor;
    const logDir = yield* LogDir;

    yield* fs.makeDirectory(pidDir, { recursive: true });
    yield* fs.makeDirectory(logDir, { recursive: true });

    const javaBin = yield* Effect.serviceOption(JavaBin).pipe(
      Effect.map(Option.getOrElse(() => "java"))
    );

    const hash = projectHash(root);

    const pidFile = (mainClass: string) => pathSvc.join(pidDir, `${hash}-${mainClass}.pid`);

    const writeRecord = (record: ProcessRecord) =>
      Effect.gen(function* () {
        const target = pidFile(record.mainClass);
        const tmp = `${target}.${record.pid}.tmp`;
        yield* fs.writeFileString(tmp, JSON.stringify(record));
        yield* fs.rename(tmp, target);
      });

    /**
     * Run a Java main class.
     *
     * DETACHED (`options.detached`): spawns the JVM in its own process group with
     * output redirected to a log file, writes a {@link ProcessRecord}, and the
     * returned Effect resolves IMMEDIATELY with that record.
     *
     * FOREGROUND (default): inherits stdio and BLOCKS — the returned Effect only
     * resolves once the process exits, and fails with {@link JavaProcessError} on
     * a non-zero exit code. The record is still written (and reaped on exit).
     *
     * Machine/agent callers should use detached (`--detached`) to get a record
     * back promptly; `--json` output is intended for detached runs.
     */
    const run = (config: RunConfig, options: RunOptions = {}) =>
      Effect.gen(function* () {
        const classpath = yield* project.resolveClasspath;
        const debug = options.debug ?? null;
        const args = buildJavaArgs(config, classpath, debug);
        const startedAt = new Date().toISOString();

        if (options.detached) {
          const logFile = pathSvc.join(
            logDir,
            `${hash}-${config.mainClass}-${startedAt.replace(/[:.]/g, "-")}.log`
          );
          const record: ProcessRecord = yield* Effect.try({
            try: () => {
              const fd = nodeFs.openSync(logFile, "a");
              let child: childProcess.ChildProcess;
              try {
                child = childProcess.spawn(javaBin, args, {
                  detached: true,
                  stdio: ["ignore", fd, fd],
                  cwd: root,
                });
              } finally {
                // Close our copy of the fd regardless of spawn success: the
                // child has inherited its own duplicate. Avoids an fd leak when
                // spawn throws.
                nodeFs.closeSync(fd);
              }
              child.unref();
              if (child.pid === undefined) {
                throw new Error("failed to spawn detached process (no pid)");
              }
              return {
                pid: child.pid,
                mainClass: config.mainClass,
                startedAt,
                logFile,
                args: [...config.programArgs],
                debugPort: debug ? debug.port : null,
                detached: true,
              };
            },
            catch: (e) =>
              new JavaProcessError({ message: `Failed to start detached: ${String(e)}` }),
          });
          yield* writeRecord(record);
          return record;
        }

        // Foreground path
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
          detached: false,
        };
        yield* writeRecord(record);

        yield* proc.exitCode.pipe(
          Effect.ensuring(fs.remove(pidFile(config.mainClass)).pipe(Effect.ignore)),
          Effect.flatMap((code) =>
            code === 0
              ? Effect.void
              : Effect.fail(
                  new JavaProcessError({
                    message: `Java process exited with code ${code}`,
                  })
                )
          )
        );

        return record;
      }).pipe(Effect.scoped, Effect.provideService(CommandExecutor.CommandExecutor, executor));

    const listRunning = Effect.gen(function* () {
      const exists = yield* fs.exists(pidDir);
      if (!exists) return [];

      const entries = yield* fs.readDirectory(pidDir);
      const running: ProcessRecord[] = [];

      for (const entry of entries) {
        if (!entry.startsWith(hash) || !entry.endsWith(".pid")) continue;
        const filePath = pathSvc.join(pidDir, entry);
        const content = yield* fs.readFileString(filePath);
        const mainClassFromName = entry.slice(hash.length + 1, -4);
        const stat = yield* fs.stat(filePath);
        const mtimeIso = Option.match(stat.mtime, {
          onNone: () => null,
          onSome: (d) => d.toISOString(),
        });

        const record = parseRecord(content, mainClassFromName, mtimeIso);
        // Skip (do NOT reap) unparseable files: a truncated/partial write from a
        // live, starting process self-heals on the next read. Removing it would
        // orphan an untracked JVM. A genuinely corrupt file lingering is safer.
        if (!record) continue;

        if (isProcessRunning(record.pid)) {
          running.push(record);
        } else {
          yield* fs.remove(filePath).pipe(Effect.ignore);
        }
      }

      return running;
    });

    /**
     * Send `signal` to a process, optionally to its whole group.
     *
     * When `group` is true we target the process group (`-pid`) so detached
     * children holding ports die too. If the group call fails with ESRCH (the
     * leader already exited, e.g. the JVM forked nothing and is gone) we fall
     * back to signalling the single pid. Any other error is swallowed (the
     * process is presumed already dead).
     */
    const sendSignal = (pid: number, signal: NodeJS.Signals, group: boolean) => {
      try {
        process.kill(group ? -pid : pid, signal);
      } catch (e) {
        if (group && (e as NodeJS.ErrnoException).code === "ESRCH") {
          try {
            process.kill(pid, signal);
          } catch {
            // already dead
          }
        }
        // otherwise already dead
      }
    };

    const killByPid = (pid: number, group = false) =>
      Effect.sync(() => sendSignal(pid, "SIGTERM", group)).pipe(
        Effect.andThen(Effect.sleep("2 seconds")),
        Effect.andThen(
          Effect.sync(() => {
            if (isProcessRunning(pid)) {
              sendSignal(pid, "SIGKILL", group);
            }
          })
        )
      );

    const kill = (className: string) =>
      Effect.gen(function* () {
        const pf = pidFile(className);
        const exists = yield* fs.exists(pf);
        if (!exists) return yield* new ProcessNotFound({ className });

        const content = yield* fs.readFileString(pf);
        const stat = yield* fs.stat(pf);
        const mtimeIso = Option.match(stat.mtime, {
          onNone: () => null,
          onSome: (d) => d.toISOString(),
        });
        const record = parseRecord(content, className, mtimeIso);
        // Unparseable (e.g. a mid-flight partial write): treat as not-found and
        // do NOT remove the file — consistent with listRunning's skip rule.
        if (!record) return yield* new ProcessNotFound({ className });

        yield* killByPid(record.pid, record.detached);
        yield* fs.remove(pf).pipe(Effect.ignore);
      });

    const readLog = (mainClass: string) =>
      Effect.gen(function* () {
        // First check if the process is currently running and has a log file.
        const running = yield* listRunning;
        const record = running.find((r) => r.mainClass === mainClass);
        if (record?.logFile) {
          return yield* fs
            .readFileString(record.logFile)
            .pipe(Effect.catchAll(() => Effect.succeed<string | null>(null)));
        }
        // Process has exited (or was never started): scan the log dir for the
        // most-recent (by start timestamp in the filename) log file whose name
        // matches this project hash + class name.  This lets callers read the
        // log of a batch job that already finished by the time they poll.
        const prefix = `${hash}-${mainClass}-`;
        const exists = yield* fs.exists(logDir);
        if (!exists) return null;
        const entries = yield* fs.readDirectory(logDir);
        const matches = entries
          .filter((e) => e.startsWith(prefix) && e.endsWith(".log"))
          .sort()
          .reverse(); // ISO timestamps sort lexicographically; newest last → reverse
        const newest = matches[0];
        if (!newest) return null;
        const logFile = pathSvc.join(logDir, newest);
        return yield* fs
          .readFileString(logFile)
          .pipe(Effect.catchAll(() => Effect.succeed<string | null>(null)));
      });

    return { run, listRunning, kill, killByPid, readLog } as const;
  })
);
