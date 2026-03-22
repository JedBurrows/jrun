import { describe, expect } from "vitest"
import { it } from "@effect/vitest"
import { Effect, Layer } from "effect"
import { FileSystem } from "@effect/platform"
import { NodeContext } from "@effect/platform-node"
import {
  JavaProjectService,
  JavaProjectLive,
  ProjectRoot,
} from "../../src/services/JavaProject.js"

const writeJavaFile = (
  fs: FileSystem.FileSystem,
  root: string,
  relativePath: string,
  content: string
) =>
  Effect.gen(function* () {
    const parts = relativePath.split("/")
    const dir = parts.slice(0, -1).join("/")
    yield* fs.makeDirectory(`${root}/${dir}`, { recursive: true })
    yield* fs.writeFileString(`${root}/${relativePath}`, content)
  })

const testWithFiles = (
  files: Record<string, string>,
  assertion: (classes: string[]) => void
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const tmpDir = yield* fs.makeTempDirectory()

    for (const [path, content] of Object.entries(files)) {
      yield* writeJavaFile(fs, tmpDir, path, content)
    }

    const layer = JavaProjectLive.pipe(
      Layer.provide(Layer.succeed(ProjectRoot, tmpDir)),
      Layer.provide(NodeContext.layer)
    )
    const classes = yield* JavaProjectService.pipe(
      Effect.flatMap((p) => p.findMainClasses),
      Effect.provide(layer)
    )
    assertion(classes)
  }).pipe(Effect.provide(NodeContext.layer))

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
  )

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
  )

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
  )

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
  )

  it.effect("finds multiple main classes across packages", () =>
    testWithFiles(
      {
        "src/main/java/com/a/One.java": `public class One { public static void main(String[] args) {} }`,
        "src/main/java/com/b/Two.java": `public class Two { public static void main(String[] args) {} }`,
      },
      (classes) => expect(classes).toEqual(["com.a.One", "com.b.Two"])
    )
  )

  it.effect("finds main classes across modules in a multi-module project", () =>
    testWithFiles(
      {
        "module-a/src/main/java/com/example/ServiceA.java": `public class ServiceA { public static void main(String[] args) {} }`,
        "module-b/src/main/java/com/example/ServiceB.java": `public class ServiceB { public static void main(String[] args) {} }`,
      },
      (classes) => expect(classes).toEqual(["com.example.ServiceA", "com.example.ServiceB"])
    )
  )

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
  )

  it.effect("returns empty when src/main/java doesn't exist", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const tmpDir = yield* fs.makeTempDirectory()

      const layer = JavaProjectLive.pipe(
        Layer.provide(Layer.succeed(ProjectRoot, tmpDir)),
        Layer.provide(NodeContext.layer)
      )
      const classes = yield* JavaProjectService.pipe(
        Effect.flatMap((p) => p.findMainClasses),
        Effect.provide(layer)
      )
      expect(classes).toEqual([])
    }).pipe(Effect.provide(NodeContext.layer))
  )

  it.effect("ignores files without main method", () =>
    testWithFiles(
      {
        "src/main/java/com/example/HasMain.java": `public class HasMain { public static void main(String[] args) {} }`,
        "src/main/java/com/example/NoMain.java": `public class NoMain { public void run() {} }`,
      },
      (classes) => expect(classes).toEqual(["com.example.HasMain"])
    )
  )
})
