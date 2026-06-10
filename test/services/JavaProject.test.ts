import * as nodeFs from "node:fs";
import * as os from "node:os";
import { FileSystem } from "@effect/platform";
import { NodeContext } from "@effect/platform-node";
import { it } from "@effect/vitest";
import { Effect, Exit, Layer } from "effect";
import { describe, expect } from "vitest";
import {
  JavaProjectLive,
  JavaProjectService,
  ProjectRoot,
} from "../../src/services/JavaProject.js";

const writeJavaFile = (
  fs: FileSystem.FileSystem,
  root: string,
  relativePath: string,
  content: string
) =>
  Effect.gen(function* () {
    const parts = relativePath.split("/");
    const dir = parts.slice(0, -1).join("/");
    yield* fs.makeDirectory(`${root}/${dir}`, { recursive: true });
    yield* fs.writeFileString(`${root}/${relativePath}`, content);
  });

const testWithFiles = (files: Record<string, string>, assertion: (classes: string[]) => void) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const tmpDir = yield* fs.makeTempDirectory();

    for (const [path, content] of Object.entries(files)) {
      yield* writeJavaFile(fs, tmpDir, path, content);
    }

    const layer = JavaProjectLive.pipe(
      Layer.provide(Layer.succeed(ProjectRoot, tmpDir)),
      Layer.provide(NodeContext.layer)
    );
    const classes = yield* JavaProjectService.pipe(
      Effect.flatMap((p) => p.findMainClasses),
      Effect.provide(layer)
    );
    assertion(classes);
  }).pipe(Effect.provide(NodeContext.layer));

describe("JavaProject.findMainClasses", () => {
  it.effect("finds standard main method", () =>
    testWithFiles(
      {
        "src/main/java/com/example/App.java": `package com.example;
public class App {
    public static void main(String[] args) {
        System.out.println("Hello");
    }
}`,
      },
      (classes) => expect(classes).toContain("com.example.App")
    )
  );

  it.effect("finds varargs main method", () =>
    testWithFiles(
      {
        "src/main/java/com/example/VarApp.java": `package com.example;
public class VarApp {
    public static void main(String... args) {}
}`,
      },
      (classes) => expect(classes).toContain("com.example.VarApp")
    )
  );

  it.effect("finds main with extra whitespace", () =>
    testWithFiles(
      {
        "src/main/java/com/example/Spacey.java": `package com.example;
public class Spacey {
    public   static   void   main(  String  []   argv  ) {}
}`,
      },
      (classes) => expect(classes).toContain("com.example.Spacey")
    )
  );

  it.effect("converts file path to FQCN correctly", () =>
    testWithFiles(
      {
        "src/main/java/org/foo/bar/Main.java": `package org.foo.bar;
public class Main {
    public static void main(String[] args) {}
}`,
      },
      (classes) => expect(classes).toContain("org.foo.bar.Main")
    )
  );

  it.effect("finds multiple main classes across packages", () =>
    testWithFiles(
      {
        "src/main/java/com/a/One.java": `public class One { public static void main(String[] args) {} }`,
        "src/main/java/com/b/Two.java": `public class Two { public static void main(String[] args) {} }`,
      },
      (classes) => expect(classes).toEqual(["com.a.One", "com.b.Two"])
    )
  );

  it.effect("finds main classes across modules in a multi-module project", () =>
    testWithFiles(
      {
        "module-a/src/main/java/com/example/ServiceA.java": `public class ServiceA { public static void main(String[] args) {} }`,
        "module-b/src/main/java/com/example/ServiceB.java": `public class ServiceB { public static void main(String[] args) {} }`,
      },
      (classes) => expect(classes).toEqual(["com.example.ServiceA", "com.example.ServiceB"])
    )
  );

  it.effect("returns empty array when no main classes exist", () =>
    testWithFiles(
      {
        "src/main/java/com/example/Util.java": `package com.example;
public class Util {
    public static String help() { return "hi"; }
}`,
      },
      (classes) => expect(classes).toEqual([])
    )
  );

  it.effect("returns empty when src/main/java doesn't exist", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const tmpDir = yield* fs.makeTempDirectory();

      const layer = JavaProjectLive.pipe(
        Layer.provide(Layer.succeed(ProjectRoot, tmpDir)),
        Layer.provide(NodeContext.layer)
      );
      const classes = yield* JavaProjectService.pipe(
        Effect.flatMap((p) => p.findMainClasses),
        Effect.provide(layer)
      );
      expect(classes).toEqual([]);
    }).pipe(Effect.provide(NodeContext.layer))
  );

  it.effect("ignores files without main method", () =>
    testWithFiles(
      {
        "src/main/java/com/example/HasMain.java": `public class HasMain { public static void main(String[] args) {} }`,
        "src/main/java/com/example/NoMain.java": `public class NoMain { public void run() {} }`,
      },
      (classes) => expect(classes).toEqual(["com.example.HasMain"])
    )
  );

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
});

// Installs a fake `mvn` on PATH whose body is `script`. Returns a restore fn
// that must be called to undo the PATH mutation. Consistent with these tests
// relying on a real `rg` from PATH.
const installFakeMvn = (script: string): (() => void) => {
  const binDir = nodeFs.mkdtempSync(`${os.tmpdir()}/jrun-fakebin-`);
  nodeFs.writeFileSync(`${binDir}/mvn`, script, { mode: 0o755 });
  const prevPath = process.env.PATH;
  process.env.PATH = `${binDir}:${prevPath ?? ""}`;
  return () => {
    process.env.PATH = prevPath;
  };
};

// A fake mvn that writes `cp` to the -Dmdep.outputFile target and exits 0.
const fakeMvnWriting = (cp: string) => `#!/bin/sh
out=""
for a in "$@"; do
  case "$a" in -Dmdep.outputFile=*) out="\${a#-Dmdep.outputFile=}";; esac
done
printf '%s' "${cp}" > "$out"
`;

const resolveWith = (root: string, mainClass: string) =>
  JavaProjectService.pipe(
    Effect.flatMap((p) => p.resolveClasspath(mainClass)),
    Effect.provide(
      JavaProjectLive.pipe(
        Layer.provide(Layer.succeed(ProjectRoot, root)),
        Layer.provide(NodeContext.layer)
      )
    )
  );

describe("JavaProject.resolveClasspath", () => {
  it.effect("uses the classpath cache when it is newer than pom.xml", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectory();
      yield* fs.writeFileString(`${root}/pom.xml`, "<project/>");
      yield* fs.writeFileString(`${root}/.jrun-classpath-cache`, "dep1.jar:dep2.jar");
      const future = new Date(Date.now() + 60_000);
      yield* Effect.sync(() => nodeFs.utimesSync(`${root}/.jrun-classpath-cache`, future, future));

      const cp = yield* resolveWith(root, "com.example.App");
      expect(cp).toBe("target/classes:dep1.jar:dep2.jar");
    }).pipe(Effect.provide(NodeContext.layer))
  );

  it.effect("reads the classpath from the build-classpath output file", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectory();
      yield* fs.writeFileString(`${root}/pom.xml`, "<project/>");
      const restore = yield* Effect.sync(() => installFakeMvn(fakeMvnWriting("a.jar:b.jar")));

      const cp = yield* resolveWith(root, "com.example.App").pipe(
        Effect.ensuring(Effect.sync(restore))
      );

      expect(cp).toBe("target/classes:a.jar:b.jar");
      const cached = yield* fs.readFileString(`${root}/.jrun-classpath-cache`);
      expect(cached.trim()).toBe("a.jar:b.jar");
    }).pipe(Effect.provide(NodeContext.layer))
  );

  it.effect("fails and does not cache when build-classpath exits non-zero", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectory();
      yield* fs.writeFileString(`${root}/pom.xml`, "<project/>");
      const restore = yield* Effect.sync(() =>
        installFakeMvn(`#!/bin/sh
echo "[ERROR] Failed to execute goal org.apache.maven.plugins:maven-dependency-plugin"
exit 1
`)
      );

      const exit = yield* resolveWith(root, "com.example.App").pipe(
        Effect.ensuring(Effect.sync(restore)),
        Effect.exit
      );

      expect(Exit.isFailure(exit)).toBe(true);
      const cacheExists = yield* fs.exists(`${root}/.jrun-classpath-cache`);
      expect(cacheExists).toBe(false);
    }).pipe(Effect.provide(NodeContext.layer))
  );

  it.effect("resolves the owning submodule's target/classes in a multi-module project", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectory();
      yield* fs.writeFileString(`${root}/pom.xml`, "<project/>");
      yield* fs.makeDirectory(`${root}/module-a/src/main/java/com/example`, {
        recursive: true,
      });
      yield* fs.writeFileString(`${root}/module-a/pom.xml`, "<project/>");
      yield* fs.writeFileString(
        `${root}/module-a/src/main/java/com/example/ServiceA.java`,
        `public class ServiceA { public static void main(String[] args) {} }`
      );
      // The fake mvn echoes its own working directory as the dependency, so the
      // assertion proves build-classpath ran in the submodule, not the root.
      const restore = yield* Effect.sync(() =>
        installFakeMvn(`#!/bin/sh
out=""
for a in "$@"; do
  case "$a" in -Dmdep.outputFile=*) out="\${a#-Dmdep.outputFile=}";; esac
done
printf '%s' "$PWD" > "$out"
`)
      );

      const cp = yield* resolveWith(root, "com.example.ServiceA").pipe(
        Effect.ensuring(Effect.sync(restore))
      );

      expect(cp).toBe(`module-a/target/classes:${root}/module-a`);
    }).pipe(Effect.provide(NodeContext.layer))
  );
});
