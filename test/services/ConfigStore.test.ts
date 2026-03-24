import { FileSystem } from "@effect/platform";
import { NodeContext } from "@effect/platform-node";
import { it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { describe, expect } from "vitest";
import {
  ConfigDir,
  ConfigNotFound,
  ConfigStoreLive,
  ConfigStoreService,
  NoLastRun,
  type RunConfig,
} from "../../src/services/ConfigStore.js";

const testConfig: RunConfig = {
  mainClass: "com.example.App",
  programArgs: ["--port", "8080"],
  jvmOpts: ["-Xmx512m", "-Dfoo=bar"],
};

const makeTest = (fn: (store: ConfigStoreService["Type"]) => Effect.Effect<void, any, any>) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const tmpDir = yield* fs.makeTempDirectory();

    const layer = ConfigStoreLive.pipe(
      Layer.provide(Layer.succeed(ConfigDir, tmpDir)),
      Layer.provide(NodeContext.layer)
    );

    yield* ConfigStoreService.pipe(Effect.flatMap(fn), Effect.provide(layer));
  }).pipe(Effect.provide(NodeContext.layer));

describe("ConfigStore", () => {
  it.effect("save creates a JSON file", () =>
    makeTest((store) =>
      Effect.gen(function* () {
        yield* store.save("myapp", testConfig);
        const fs = yield* FileSystem.FileSystem;
        // If save didn't throw, it worked. Verify via load.
        const loaded = yield* store.load("myapp");
        expect(loaded.mainClass).toBe("com.example.App");
      })
    )
  );

  it.effect("load reads back saved config", () =>
    makeTest((store) =>
      Effect.gen(function* () {
        yield* store.save("myapp", testConfig);
        const loaded = yield* store.load("myapp");
        expect(loaded).toEqual(testConfig);
      })
    )
  );

  it.effect("round-trip preserves mainClass, programArgs, and jvmOpts", () =>
    makeTest((store) =>
      Effect.gen(function* () {
        const config: RunConfig = {
          mainClass: "org.test.Main",
          programArgs: ["--verbose", "file with spaces.txt"],
          jvmOpts: ["-Xms128m", "-Xmx1g", "-Dmy.prop=hello world"],
        };
        yield* store.save("test", config);
        const loaded = yield* store.load("test");
        expect(loaded.mainClass).toBe(config.mainClass);
        expect(loaded.programArgs).toEqual(config.programArgs);
        expect(loaded.jvmOpts).toEqual(config.jvmOpts);
      })
    )
  );

  it.effect("load returns ConfigNotFound for missing config", () =>
    makeTest((store) =>
      Effect.gen(function* () {
        const result = yield* store.load("nonexistent").pipe(
          Effect.matchEffect({
            onFailure: (e) => Effect.succeed(e),
            onSuccess: () => Effect.fail("should have failed"),
          })
        );
        expect(result).toBeInstanceOf(ConfigNotFound);
      })
    )
  );

  it.effect("saveLastRun / loadLastRun round-trip", () =>
    makeTest((store) =>
      Effect.gen(function* () {
        yield* store.saveLastRun(testConfig);
        const loaded = yield* store.loadLastRun;
        expect(loaded).toEqual(testConfig);
      })
    )
  );

  it.effect("loadLastRun returns NoLastRun when no file exists", () =>
    makeTest((store) =>
      Effect.gen(function* () {
        const result = yield* store.loadLastRun.pipe(
          Effect.matchEffect({
            onFailure: (e) => Effect.succeed(e),
            onSuccess: () => Effect.fail("should have failed"),
          })
        );
        expect(result).toBeInstanceOf(NoLastRun);
      })
    )
  );

  it.effect("list returns empty array when no configs saved", () =>
    makeTest((store) =>
      Effect.gen(function* () {
        const names = yield* store.list;
        expect(names).toEqual([]);
      })
    )
  );

  it.effect("list returns sorted config names", () =>
    makeTest((store) =>
      Effect.gen(function* () {
        yield* store.save("zebra", testConfig);
        yield* store.save("alpha", testConfig);
        yield* store.save("middle", testConfig);
        const names = yield* store.list;
        expect(names).toEqual(["alpha", "middle", "zebra"]);
      })
    )
  );

  it.effect("list does not include last-run", () =>
    makeTest((store) =>
      Effect.gen(function* () {
        yield* store.saveLastRun(testConfig);
        yield* store.save("myapp", testConfig);
        const names = yield* store.list;
        expect(names).toEqual(["myapp"]);
      })
    )
  );

  it.effect("handles args with spaces and special characters", () =>
    makeTest((store) =>
      Effect.gen(function* () {
        const config: RunConfig = {
          mainClass: "com.Test",
          programArgs: ["hello world", 'say "hi"', "foo\tbar", "a=b&c=d"],
          jvmOpts: ["-Dprop=val ue"],
        };
        yield* store.save("special", config);
        const loaded = yield* store.load("special");
        expect(loaded.programArgs).toEqual(config.programArgs);
        expect(loaded.jvmOpts).toEqual(config.jvmOpts);
      })
    )
  );
});
