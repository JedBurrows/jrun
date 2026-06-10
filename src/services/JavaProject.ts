import { randomUUID } from "node:crypto";
import * as os from "node:os";
import { CommandExecutor, FileSystem, Path } from "@effect/platform";
import { Command } from "@effect/platform";
import { BadArgument, type PlatformError } from "@effect/platform/Error";
import { Context, Effect, Layer, Option } from "effect";

export class ProjectRoot extends Context.Tag("ProjectRoot")<ProjectRoot, string>() {}

export interface JavaProject {
  readonly findMainClasses: Effect.Effect<string[], PlatformError>;
  readonly resolveClasspath: (mainClass: string) => Effect.Effect<string, PlatformError>;
}

export class JavaProjectService extends Context.Tag("JavaProject")<
  JavaProjectService,
  JavaProject
>() {}

const RG_MAIN_PATTERN = "public\\s+static\\s+void\\s+main\\s*\\(\\s*String";
// Assumes POSIX (`/`) path separators. jrun is a Linux/WSL tool by design
// (consistent with the `:` classpath separator used in resolveClasspath);
// native-Windows `\` paths are intentionally unsupported.
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

    // Locate the directory of the Maven module that declares `mainClass`. In a
    // single-module project (or when the source can't be found) this is the
    // project root; in a reactor build it's the submodule that owns the class,
    // so build-classpath runs there and its `target/classes` is on the
    // classpath (issue #10). Module classes aren't a dependency of themselves,
    // so build-classpath never includes them — we must add them explicitly.
    const resolveModuleRoot = (mainClass: string) =>
      Effect.gen(function* () {
        const relPath = `${mainClass.replaceAll(".", "/")}.java`;
        const stdout = yield* Command.make(
          "rg",
          "--files",
          "--glob",
          `**/${relPath}`,
          "--glob",
          "!**/target/**",
          root
        ).pipe(
          Command.string,
          // No match / rg errors fall back to the project root.
          Effect.catchAll(() => Effect.succeed(""))
        );
        const files = stdout.trim().split("\n").filter(Boolean);
        // Prefer the file whose FQCN actually equals mainClass; fall back to the
        // first hit. If two modules declare the same FQCN the choice is
        // arbitrary — an unusual reactor layout we don't try to disambiguate.
        const match = files.find((f) => extractFqcn(f) === mainClass) ?? files[0];
        if (!match) return root;
        const idx = match.indexOf("/src/");
        return idx < 0 ? root : match.slice(0, idx);
      });

    const resolveClasspath = (mainClass: string) =>
      Effect.gen(function* () {
        const moduleRoot = yield* resolveModuleRoot(mainClass);
        const classesDir =
          moduleRoot === root
            ? "target/classes"
            : `${path.relative(root, moduleRoot)}/target/classes`;
        const cacheFile = path.join(moduleRoot, ".jrun-classpath-cache");
        const pomFile = path.join(moduleRoot, "pom.xml");
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
              return `${classesDir}:${cached.trim()}`;
            }
          }
        }

        // Write to a real temp file rather than /dev/stdout: a child spawned by
        // Node has its stdout wired as a socketpair, and the dependency plugin
        // open()s the outputFile, which fails on a socket fd (issue #8).
        const outputFile = path.join(os.tmpdir(), `jrun-cp-${randomUUID()}.txt`);
        const trimmed = yield* Effect.gen(function* () {
          const exitCode = yield* Command.make(
            "mvn",
            "dependency:build-classpath",
            "-q",
            "-DincludeScope=runtime",
            `-Dmdep.outputFile=${outputFile}`
          ).pipe(Command.workingDirectory(moduleRoot), Command.exitCode);

          // Fail loudly on a non-zero exit instead of caching Maven's error text
          // as the classpath and poisoning every later run (issue #9).
          if (exitCode !== 0) {
            return yield* Effect.fail(
              new BadArgument({
                module: "Command",
                method: "resolveClasspath",
                description: `mvn dependency:build-classpath exited ${exitCode} in ${moduleRoot}`,
              })
            );
          }

          const written = yield* fs.exists(outputFile);
          return written ? (yield* fs.readFileString(outputFile)).trim() : "";
          // Cleanup runs on success, failure, and interruption alike.
        }).pipe(Effect.ensuring(fs.remove(outputFile).pipe(Effect.ignore)));

        if (pomExists && trimmed.length > 0) {
          yield* fs.writeFileString(cacheFile, trimmed);
        }

        return trimmed.length > 0 ? `${classesDir}:${trimmed}` : classesDir;
      });

    return {
      findMainClasses,
      resolveClasspath: (mainClass: string) =>
        resolveClasspath(mainClass).pipe(
          Effect.provideService(CommandExecutor.CommandExecutor, executor)
        ),
    } as const;
  })
);
