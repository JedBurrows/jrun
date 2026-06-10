import { describe, expect, test } from "vitest";
import {
  compactStamp,
  logFileName,
  pickLogByPid,
  pickNewestLog,
  pickRunningLog,
} from "../../src/services/logNaming.js";

describe("compactStamp", () => {
  test("replaces colons and dots so the stamp is filename-safe", () => {
    expect(compactStamp("2026-06-10T12:30:45.123Z")).toBe("2026-06-10T12-30-45-123Z");
  });
});

describe("logFileName", () => {
  test("builds <hash>-<class>-<stamp>-<pid>.log", () => {
    expect(logFileName("abc", "com.example.App", "2026-06-10T12-30-45-123Z", 777)).toBe(
      "abc-com.example.App-2026-06-10T12-30-45-123Z-777.log"
    );
  });
});

describe("pickRunningLog (class + pid)", () => {
  const files = [
    "abc-com.example.App-2026-06-10T00-00-00-000Z-100.log",
    "abc-com.example.App-2026-06-10T00-00-01-000Z-200.log",
    "abc-com.example.Other-2026-06-10T00-00-00-000Z-200.log",
  ];
  test("selects the file for a specific class+pid", () => {
    expect(pickRunningLog(files, "abc", "com.example.App", 200)).toBe(
      "abc-com.example.App-2026-06-10T00-00-01-000Z-200.log"
    );
  });
  test("pid 3 does not match pid 300's file (leading-dash anchor)", () => {
    expect(pickRunningLog(["abc-c-2026-300.log"], "abc", "c", 3)).toBeNull();
  });
  test("returns null when no file matches the pid", () => {
    expect(pickRunningLog([], "abc", "com.example.App", 999)).toBeNull();
  });
});

describe("pickNewestLog (class, any pid)", () => {
  const files = [
    "abc-com.example.App-2026-06-08T00-00-00-000Z-100.log",
    "abc-com.example.App-2026-06-09T00-00-00-000Z-150.log",
    "abc-com.example.Other-2026-06-10T00-00-00-000Z-1.log",
  ];
  test("returns the newest (lexicographically last) log for a class", () => {
    expect(pickNewestLog(files, "abc", "com.example.App")).toBe(
      "abc-com.example.App-2026-06-09T00-00-00-000Z-150.log"
    );
  });
  test("returns null when nothing matches", () => {
    expect(pickNewestLog([], "abc", "com.example.App")).toBeNull();
  });
});

describe("pickLogByPid (class-agnostic, exited PID)", () => {
  const files = [
    "abc-com.example.App-2026-06-09T00-00-00-000Z-321.log",
    "abc-com.example.Other-2026-06-10T00-00-00-000Z-99.log",
  ];
  test("finds a log by pid regardless of class", () => {
    expect(pickLogByPid(files, "abc", 321)).toBe(
      "abc-com.example.App-2026-06-09T00-00-00-000Z-321.log"
    );
  });
  test("pid 9 does not match pid 99's file (leading-dash anchor)", () => {
    expect(pickLogByPid(files, "abc", 9)).toBeNull();
  });
  test("returns null when no file matches the pid", () => {
    expect(pickLogByPid(files, "abc", 12345)).toBeNull();
  });
  test("pickLogByPid picks the NEWEST by timestamp across classes (not by class name)", () => {
    const crossClass = [
      "abc-com.example.Zebra-2026-01-01T00-00-00-000Z-5.log", // OLD
      "abc-com.example.Apple-2026-06-10T00-00-00-000Z-5.log", // RECENT
    ];
    expect(pickLogByPid(crossClass, "abc", 5)).toBe(
      "abc-com.example.Apple-2026-06-10T00-00-00-000Z-5.log"
    );
  });
});
