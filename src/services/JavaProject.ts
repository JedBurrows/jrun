import { CommandExecutor, FileSystem, Path } from "@effect/platform";
import { Command } from "@effect/platform";
import type { PlatformError } from "@effect/platform/Error";
import { Context, Effect, Layer, Option } from "effect";

export class ProjectRoot extends Context.Tag("ProjectRoot")<ProjectRoot, string>() {}

export interface JavaProject {
  readonly findMainClasses: Effect.Effect<string[], PlatformError>;
  readonly resolveClasspath: Effect.Effect<string, PlatformError>;
}

export class JavaProjectService extends Context.Tag("JavaProject")<
  JavaProjectService,
  JavaProject
>() {}

const RG_MAIN_PATTERN = "public\\s+static\\s+void\\s+main\\s*\\(\\s*String";
// Assumes POSIX (`/`) path separators. jrun is a Linux/WSL tool by design
// (consistent with the `:` classpath separator and `/dev/stdout` in
// resolveClasspath); native-Windows `\` paths are intentionally unsupported.
const SOURCE_ROOT_RE = /src\/[^/]+\/java\/(.*\.java)$/;

const extractFqcn = (filePath: string): string | undefined => {
  const match = filePath.match(SOURCE_ROOT_RE);
  if (!match?.[1]) return undefined;
  return match[1].replace(/\.java$/, "").replaceAll("/", ".");
};

export const JavaProjectLive = Layer.effect(
  JavaProjectService,
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* ProjectRoot;
    const executor = yield* CommandExecutor.CommandExecutor;

    const findMainClasses = Effect.gen(function* () {
      const stdout = yield* Command.make(
        "rg",
        "--files-with-matches",
        "--glob",
        "*.java",
        "--glob",
        "!**/target/**",
        RG_MAIN_PATTERN,
        root
      ).pipe(
        Command.string,
        Effect.catchAll((e: PlatformError) => {
          // A missing `rg` binary surfaces as SystemError/NotFound — fail loudly.
          if (e._tag === "SystemError" && e.reason === "NotFound") {
            return Effect.die(new Error("ripgrep (rg) is required but not found in PATH"));
          }
          // rg exiting 1 (no matches) does NOT fail Command.string — it returns
          // "" successfully — so this branch only sees real failures
          // (permissions, stream errors). Re-propagate them.
          return Effect.fail(e);
        })
      );

      const paths = stdout.trim().split("\n").filter(Boolean);
      const classes = paths.map(extractFqcn).filter((c): c is string => c !== undefined);

      // rg --files-with-matches emits each path once, so no dedup needed.
      return classes.sort();
    }).pipe(Effect.provideService(CommandExecutor.CommandExecutor, executor));

    const resolveClasspath = Effect.gen(function* () {
      const cacheFile = path.join(root, ".jrun-classpath-cache");
      const pomFile = path.join(root, "pom.xml");
      const pomExists = yield* fs.exists(pomFile);

      if (pomExists) {
        const cacheExists = yield* fs.exists(cacheFile);
        if (cacheExists) {
          const cacheStat = yield* fs.stat(cacheFile);
          const pomStat = yield* fs.stat(pomFile);
          const cacheMtime = Option.getOrNull(cacheStat.mtime);
          const pomMtime = Option.getOrNull(pomStat.mtime);
          if (
            cacheMtime !== null &&
            pomMtime !== null &&
            cacheMtime.getTime() > pomMtime.getTime()
          ) {
            const cached = yield* fs.readFileString(cacheFile);
            return `target/classes:${cached.trim()}`;
          }
        }
      }

      const output = yield* Command.make(
        "mvn",
        "dependency:build-classpath",
        "-q",
        "-DincludeScope=runtime",
        "-Dmdep.outputFile=/dev/stdout"
      ).pipe(Command.workingDirectory(root), Command.string);
      const trimmed = output.trim();

      if (trimmed.length > 0) {
        yield* fs.writeFileString(cacheFile, trimmed);
      }

      return trimmed.length > 0 ? `target/classes:${trimmed}` : "target/classes";
    });

    return {
      findMainClasses,
      resolveClasspath: resolveClasspath.pipe(
        Effect.provideService(CommandExecutor.CommandExecutor, executor)
      ),
    } as const;
  })
);
