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
}

export interface RunOptions {
  readonly detached?: boolean;
  readonly debug?: { readonly port: number; readonly suspend: boolean } | null;
}

/** @deprecated use ProcessRecord */
export type RunningProcess = ProcessRecord;

export interface ProcessManager {
  readonly run: (
    config: RunConfig,
    options?: RunOptions
  ) => Effect.Effect<ProcessRecord, JavaProcessError | PlatformError>;
  readonly listRunning: Effect.Effect<ProcessRecord[], PlatformError>;
  readonly kill: (className: string) => Effect.Effect<void, ProcessNotFound | PlatformError>;
  readonly killByPid: (pid: number) => Effect.Effect<void, PlatformError>;
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
      Effect.map((o) => (o._tag === "Some" ? o.value : "java"))
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
              const child = childProcess.spawn(javaBin, args, {
                detached: true,
                stdio: ["ignore", fd, fd],
                cwd: root,
              });
              nodeFs.closeSync(fd);
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

    const killByPid = (pid: number) =>
      Effect.sync(() => {
        try {
          process.kill(pid, "SIGTERM");
        } catch {
          // already dead
        }
      }).pipe(
        Effect.andThen(Effect.sleep("2 seconds")),
        Effect.andThen(
          Effect.sync(() => {
            if (isProcessRunning(pid)) {
              try {
                process.kill(pid, "SIGKILL");
              } catch {
                // already dead
              }
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
        const pid = Number.parseInt(content.trim(), 10);
        yield* killByPid(pid);
        yield* fs.remove(pf).pipe(Effect.ignore);
      });

    return { run, listRunning, kill, killByPid } as const;
  })
);
