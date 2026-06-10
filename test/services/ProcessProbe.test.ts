import { Effect } from "effect";
import { describe, expect, test } from "vitest";
import {
  ProcessProbeLive,
  ProcessProbeService,
  parseCmdline,
  parseProcStat,
  startedAtFromStat,
} from "../../src/services/ProcessProbe.js";

describe("parseProcStat", () => {
  test("extracts pgid and starttime, tolerating spaces/parens in comm", () => {
    // Fields: pid (comm) state ppid pgrp session ... starttime(22) ...
    const line =
      "169627 (java (worker)) S 1695 169627 169627 0 -1 0 0 0 0 0 12 3 0 0 20 0 1 0 4242 0 0";
    const parsed = parseProcStat(line);
    expect(parsed?.pgid).toBe(169627);
    expect(parsed?.starttimeTicks).toBe(4242);
  });
  test("returns null on garbage", () => {
    expect(parseProcStat("not a stat line")).toBeNull();
  });
});

describe("startedAtFromStat", () => {
  test("computes ISO start time from btime + starttime/USER_HZ", () => {
    // btime = 1_000_000s, starttime = 500 ticks @ 100Hz => +5s => 1_000_005s.
    const iso = startedAtFromStat(500, 1_000_000, 100);
    expect(iso).toBe(new Date(1_000_005_000).toISOString());
  });
});

describe("parseCmdline", () => {
  test("splits NUL-separated argv and drops the trailing empty token", () => {
    // NUL separators written as \x00 (not \0) so "\x008080" isn't parsed as a
    // legacy octal escape, which is a SyntaxError in an ECMAScript module.
    const buf = "java\x00-cp\x00a:b c\x00com.example.App\x00--port\x008080\x00";
    expect(parseCmdline(buf)).toEqual([
      "java",
      "-cp",
      "a:b c",
      "com.example.App",
      "--port",
      "8080",
    ]);
  });
  test("returns [] for empty cmdline (kernel threads)", () => {
    expect(parseCmdline("")).toEqual([]);
  });
});

test("live probe inspect() returns a correct snapshot for the current process", async () => {
  const snap = await Effect.runPromise(
    ProcessProbeService.pipe(
      Effect.flatMap((p) => p.inspect(process.pid)),
      Effect.provide(ProcessProbeLive)
    )
  );
  expect(snap?.pid).toBe(process.pid);
  expect(snap?.cwd).not.toBeNull();
  expect(snap?.pgid).toBeGreaterThan(0);
  expect(snap?.argv.length ?? 0).toBeGreaterThan(0);
});
