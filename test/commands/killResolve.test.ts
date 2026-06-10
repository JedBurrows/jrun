import { describe, expect, test } from "vitest";
import { resolveKillTarget } from "../../src/commands/killResolve.js";
import type { ProcessRecord } from "../../src/services/ProcessManager.js";

const rec = (pid: number, mainClass: string): ProcessRecord => ({
  pid,
  mainClass,
  startedAt: null,
  logFile: null,
  args: [],
  debugPort: null,
});

describe("resolveKillTarget", () => {
  const running = [
    rec(101, "com.example.ApiServer"),
    rec(102, "com.example.ApiServer"),
    rec(200, "com.example.HelloWorld"),
  ];
  test("numeric arg for a tracked pid → owned:true", () => {
    expect(resolveKillTarget("101", running)).toEqual({ kind: "pid", pid: 101, owned: true });
  });
  test("numeric arg for an untracked pid → owned:false", () => {
    expect(resolveKillTarget("999", running)).toEqual({ kind: "pid", pid: 999, owned: false });
  });
  test("class with one instance → owned:true", () => {
    expect(resolveKillTarget("com.example.HelloWorld", running)).toEqual({
      kind: "pid",
      pid: 200,
      owned: true,
    });
  });
  test("class with multiple instances → ambiguous lists pids", () => {
    const r = resolveKillTarget("com.example.ApiServer", running);
    expect(r.kind).toBe("ambiguous");
    if (r.kind === "ambiguous") expect(r.instances.map((i) => i.pid)).toEqual([101, 102]);
  });
  test("unknown class → notfound", () => {
    expect(resolveKillTarget("com.example.Nope", running)).toEqual({ kind: "notfound" });
  });
});
