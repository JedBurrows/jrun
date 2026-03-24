import { CommandExecutor, FileSystem, Path } from "@effect/platform";
import { Command } from "@effect/platform";
import type { PlatformError } from "@effect/platform/Error";
import { Context, Effect, Layer } from "effect";

export class ProjectRoot extends Context.Tag("ProjectRoot")<ProjectRoot, string>() {}

export interface JavaProject {
  readonly findMainClasses: Effect.Effect<string[], PlatformError>;
  readonly resolveClasspath: Effect.Effect<string, PlatformError>;
}

export class JavaProjectService extends Context.Tag("JavaProject")<
  JavaProjectService,
  JavaProject
>() {}

const MAIN_METHOD_RE = /public\s+static\s+void\s+main\s*\(\s*String\s*(\[\s*]|\.\.\.)\s*\w+\s*\)/;

const fileToFqcn = (relativePath: string): string =>
  relativePath.replace(/\.java$/, "").replaceAll("/", ".");

export const JavaProjectLive = Layer.effect(
  JavaProjectService,
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* ProjectRoot;
    const executor = yield* CommandExecutor.CommandExecutor;

    const walkJavaFiles = (dir: string): Effect.Effect<string[], PlatformError> =>
      Effect.gen(function* () {
        const entries = yield* fs.readDirectory(dir);
        const results: string[] = [];
        for (const entry of entries) {
          const full = path.join(dir, entry);
          const stat = yield* fs.stat(full);
          if (stat.type === "Directory") {
            const nested = yield* walkJavaFiles(full);
            results.push(...nested);
          } else if (entry.endsWith(".java")) {
            results.push(full);
          }
        }
        return results;
      });

    const findSrcMainJavaDirs = (dir: string): Effect.Effect<string[], PlatformError> =>
      Effect.gen(function* () {
        const srcMainJava = path.join(dir, "src", "main", "java");
        const results: string[] = [];
        if (yield* fs.exists(srcMainJava)) {
          results.push(srcMainJava);
        }
        const entries = yield* fs.readDirectory(dir);
        for (const entry of entries) {
          if (entry === "src" || entry === "target" || entry.startsWith(".")) continue;
          const full = path.join(dir, entry);
          const stat = yield* fs.stat(full);
          if (stat.type === "Directory") {
            const nested = yield* findSrcMainJavaDirs(full);
            results.push(...nested);
          }
        }
        return results;
      });

    const findMainClasses = Effect.gen(function* () {
      const srcDirs = yield* findSrcMainJavaDirs(root);
      if (srcDirs.length === 0) return [];

      const mainClasses: string[] = [];
      for (const srcDir of srcDirs) {
        const javaFiles = yield* walkJavaFiles(srcDir);
        for (const file of javaFiles) {
          const content = yield* fs.readFileString(file);
          if (MAIN_METHOD_RE.test(content)) {
            const relative = path.relative(srcDir, file);
            mainClasses.push(fileToFqcn(relative));
          }
        }
      }

      return mainClasses.sort();
    });

    const resolveClasspath = Effect.gen(function* () {
      const cacheFile = path.join(root, ".jrun-classpath-cache");
      const pomFile = path.join(root, "pom.xml");
      const pomExists = yield* fs.exists(pomFile);

      if (pomExists) {
        const cacheExists = yield* fs.exists(cacheFile);
        if (cacheExists) {
          const cacheStat = yield* fs.stat(cacheFile);
          const pomStat = yield* fs.stat(pomFile);
          if (
            cacheStat.mtime !== undefined &&
            pomStat.mtime !== undefined &&
            cacheStat.mtime > pomStat.mtime
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
