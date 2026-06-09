# Fast Main Class Discovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the slow per-file-read main class scanner with a single `rg` invocation that covers all Maven modules and all source roots.

**Architecture:** Run `rg --files-with-matches` once from the project root to find every `.java` file containing a main method signature, then extract FQCNs from the returned paths using a regex that strips the `src/<scope>/java/` prefix. Replaces the recursive directory walk and per-file `readFileString` approach entirely.

**Tech Stack:** TypeScript, Effect (`@effect/platform` `Command` / `CommandExecutor`), ripgrep (`rg`), Vitest with `@effect/vitest`

---

## File Map

| File | Change |
|---|---|
| `src/services/JavaProject.ts` | Rewrite `findMainClasses`; delete `walkJavaFiles`, `findSrcMainJavaDirs`, `MAIN_METHOD_RE`, `fileToFqcn`; add `RG_MAIN_PATTERN`, `SOURCE_ROOT_RE`, `extractFqcn` |
| `test/services/JavaProject.test.ts` | Add two new tests: `src/test/java` discovery and non-standard path exclusion |

---

### Task 1: Add failing tests for new capabilities

**Files:**
- Modify: `test/services/JavaProject.test.ts`

- [ ] **Step 1: Add two tests inside the `describe` block after the last existing test**

Open `test/services/JavaProject.test.ts`. Inside the `describe("JavaProject.findMainClasses", ...)` block, append after `"ignores files without main method"`:

```typescript
  it.effect("finds main classes in src/test/java", () =>
    testWithFiles(
      {
        "src/test/java/com/example/TestRunner.java": `public class TestRunner { public static void main(String[] args) {} }`,
      },
      (classes) => expect(classes).toContain("com.example.TestRunner")
    )
  );

  it.effect("skips java files outside standard src/scope/java layout", () =>
    testWithFiles(
      {
        "scripts/DoSomething.java": `public class DoSomething { public static void main(String[] args) {} }`,
        "src/main/java/com/example/App.java": `public class App { public static void main(String[] args) {} }`,
      },
      (classes) => expect(classes).toEqual(["com.example.App"])
    )
  );
```

- [ ] **Step 2: Run the tests to confirm the first new test fails**

```bash
pnpm test -- --run test/services/JavaProject.test.ts
```

Expected: `finds main classes in src/test/java` **FAILS** (current impl only scans `src/main/java`). `skips java files outside standard src/scope/java layout` **PASSES** (current impl never reaches `scripts/`).

---

### Task 2: Rewrite `JavaProject.ts` to use rg

**Files:**
- Modify: `src/services/JavaProject.ts`

- [ ] **Step 3: Replace the entire contents of `src/services/JavaProject.ts`**

```typescript
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

const RG_MAIN_PATTERN = "public\\s+static\\s+void\\s+main\\s*\\(\\s*String";
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
          if (e._tag === "SystemError" && e.reason === "NotFound") {
            return Effect.die(
              new Error("ripgrep (rg) is required but not found in PATH")
            );
          }
          // rg exits 1 when no files match — not an error
          return Effect.succeed("");
        })
      );

      const paths = stdout.trim().split("\n").filter(Boolean);
      const classes = paths
        .map(extractFqcn)
        .filter((c): c is string => c !== undefined);

      return [...new Set(classes)].sort();
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
```

- [ ] **Step 4: Run the full test suite**

```bash
pnpm test -- --run test/services/JavaProject.test.ts
```

Expected: all tests pass, including the two new ones from Task 1.

- [ ] **Step 5: Run typecheck**

```bash
pnpm typecheck
```

Expected: no type errors.

- [ ] **Step 6: Commit**

```bash
git add src/services/JavaProject.ts test/services/JavaProject.test.ts
git commit -m "feat: replace per-file grep with rg for fast main class discovery across all source roots"
```

---

## Spec coverage

| Spec requirement | Where implemented |
|---|---|
| Single `rg` invocation | `Command.make("rg", ...)` in `findMainClasses` |
| All source roots (not just `src/main/java`) | `SOURCE_ROOT_RE` matches any `src/<scope>/java/` |
| All Maven modules | rg scans recursively from `root` |
| Exclude `target/` build output | `--glob !**/target/**` |
| rg exit 1 (no matches) → return `[]` | `Effect.catchAll` → `Effect.succeed("")` → empty paths list |
| rg not found → clear error | `reason === "NotFound"` → `Effect.die` with message |
| Paths outside `src/*/java/` → skipped | `extractFqcn` returns `undefined` when no regex match |
| Results sorted + deduplicated | `[...new Set(classes)].sort()` |
