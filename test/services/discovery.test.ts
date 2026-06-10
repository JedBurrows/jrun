import { describe, expect, test } from "vitest";
import type { ProcessSnapshot } from "../../src/services/ProcessProbe.js";
import {
  extractDebugPort,
  extractMainClass,
  extractProgramArgs,
  matchProcess,
  ownsProcess,
  projectMarker,
} from "../../src/services/discovery.js";

const HASH = "deadbeefcafe";
const MARKER = projectMarker(HASH); // "-Djrun.project=deadbeefcafe"

describe("projectMarker", () => {
  test("builds the -D system-property token", () => {
    expect(projectMarker("abc")).toBe("-Djrun.project=abc");
  });
});

describe("ownsProcess", () => {
  test("true when argv carries the exact marker", () => {
    expect(ownsProcess(["java", MARKER, "-cp", "x", "p.Main"], MARKER)).toBe(true);
  });
  test("false when the marker is absent (foreign JVM)", () => {
    expect(ownsProcess(["java", "-cp", "x", "com.example.ApiServer"], MARKER)).toBe(false);
  });
  test("false on a different project's marker", () => {
    expect(ownsProcess(["java", projectMarker("other"), "-cp", "x", "p.Main"], MARKER)).toBe(false);
  });
});

describe("extractMainClass (positional)", () => {
  test("returns the token after -cp", () => {
    expect(
      extractMainClass([
        "java",
        MARKER,
        "-cp",
        "target/classes",
        "com.example.ApiServer",
        "--port",
        "8099",
      ])
    ).toBe("com.example.ApiServer");
  });
  test("survives a garbage classpath that is a single token with spaces", () => {
    expect(
      extractMainClass([
        "java",
        MARKER,
        "-cp",
        "target/classes:[ERROR] Failed ... No such device",
        "com.example.ApiServer",
      ])
    ).toBe("com.example.ApiServer");
  });
  test("honors -classpath and --class-path", () => {
    expect(extractMainClass(["java", "-classpath", "x", "p.A"])).toBe("p.A");
    expect(extractMainClass(["java", "--class-path", "x", "p.B"])).toBe("p.B");
  });
  test("returns null when no classpath flag is present", () => {
    expect(extractMainClass(["java", MARKER, "-c", "while :; do sleep 1; done"])).toBeNull();
  });
});

describe("extractDebugPort", () => {
  test("parses address=*:PORT", () => {
    expect(
      extractDebugPort([
        "java",
        "-agentlib:jdwp=transport=dt_socket,server=y,suspend=n,address=*:5005",
      ])
    ).toBe(5005);
  });
  test("parses address=PORT (no host)", () => {
    expect(extractDebugPort(["java", "-agentlib:jdwp=...,address=6000"])).toBe(6000);
  });
  test("null without a jdwp arg", () => {
    expect(extractDebugPort(["java", "-cp", "x", "Main"])).toBeNull();
  });
});

describe("extractProgramArgs", () => {
  test("returns tokens after the main class", () => {
    expect(
      extractProgramArgs(
        ["java", "-cp", "x", "com.example.ApiServer", "--port", "8099"],
        "com.example.ApiServer"
      )
    ).toEqual(["--port", "8099"]);
  });
  test("slices at the FIRST occurrence when a program arg equals the class name", () => {
    // The real main class always precedes program args; indexOf finds it first.
    expect(extractProgramArgs(["java", "-cp", "x", "p.Main", "p.Main"], "p.Main")).toEqual([
      "p.Main",
    ]);
  });
});

describe("matchProcess", () => {
  const base: ProcessSnapshot = {
    pid: 100,
    pgid: 100,
    cwd: "/anywhere",
    argv: ["java", MARKER, "-cp", "target/classes", "com.example.ApiServer", "--port", "8099"],
    startedAt: "2026-06-10T00:00:00.000Z",
  };

  test("owns a marked process and reconstructs its record (cwd irrelevant)", () => {
    expect(matchProcess(base, { marker: MARKER })).toEqual({
      pid: 100,
      pgid: 100,
      mainClass: "com.example.ApiServer",
      startedAt: "2026-06-10T00:00:00.000Z",
      args: ["--port", "8099"],
      debugPort: null,
    });
  });

  // THE critical regression: a foreign JVM (IntelliJ/Gradle/mvn) at the same cwd
  // with a -cp and a real-looking class but NO marker must be EXCLUDED.
  test("excludes an unmarked java process even with cwd=root and a -cp class", () => {
    const foreign: ProcessSnapshot = {
      ...base,
      cwd: "/project/root",
      argv: ["java", "-cp", "x", "com.example.ApiServer"],
    };
    expect(matchProcess(foreign, { marker: MARKER })).toBeNull();
  });

  test("a marked process whose class can't be extracted is still owned, mainClass '(unknown)'", () => {
    const odd: ProcessSnapshot = { ...base, argv: ["java", MARKER, "-c", "loop"] };
    expect(matchProcess(odd, { marker: MARKER })?.mainClass).toBe("(unknown)");
  });

  test("parses the debug port from a marked process", () => {
    const dbg: ProcessSnapshot = {
      ...base,
      argv: [
        "java",
        MARKER,
        "-agentlib:jdwp=transport=dt_socket,server=y,suspend=n,address=*:5005",
        "-cp",
        "x",
        "p.Main",
      ],
    };
    expect(matchProcess(dbg, { marker: MARKER })?.debugPort).toBe(5005);
  });
});
