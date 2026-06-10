import * as nodeFs from "node:fs";
import { Context, Effect, Layer } from "effect";

/** A point-in-time view of one process, sourced from `/proc/<pid>`. */
export interface ProcessSnapshot {
  readonly pid: number;
  readonly pgid: number;
  /** `readlink /proc/<pid>/cwd`, or null when unreadable (not ours / gone). */
  readonly cwd: string | null;
  /** True argv from `/proc/<pid>/cmdline` (NUL-split). */
  readonly argv: readonly string[];
  /** ISO start time, or null when it can't be computed. */
  readonly startedAt: string | null;
}

export interface ProcessProbe {
  /** Snapshot every `java` process the current user can inspect. */
  readonly listJava: Effect.Effect<ProcessSnapshot[]>;
  /** Snapshot a single PID, or null if it's gone/unreadable. */
  readonly inspect: (pid: number) => Effect.Effect<ProcessSnapshot | null>;
}

export class ProcessProbeService extends Context.Tag("ProcessProbe")<
  ProcessProbeService,
  ProcessProbe
>() {}

const USER_HZ = 100; // CLK_TCK; 100 on all mainstream Linux/x86 — see proc(5).

/** Parse `/proc/<pid>/stat`. `comm` (field 2) is wrapped in parens and may
 *  itself contain spaces and parens, so we split on the LAST ')'. */
export const parseProcStat = (line: string): { pgid: number; starttimeTicks: number } | null => {
  const close = line.lastIndexOf(")");
  if (close < 0) return null;
  const rest = line
    .slice(close + 1)
    .trim()
    .split(/\s+/);
  // rest[0]=state(f3) rest[1]=ppid(f4) rest[2]=pgrp(f5) ... rest[19]=starttime(f22)
  const pgid = Number(rest[2]);
  const starttimeTicks = Number(rest[19]);
  if (!Number.isFinite(pgid) || !Number.isFinite(starttimeTicks)) return null;
  return { pgid, starttimeTicks };
};

/** Convert a process start time (ticks since boot) to an ISO timestamp. */
export const startedAtFromStat = (
  starttimeTicks: number,
  btimeSec: number,
  userHz = USER_HZ
): string => new Date((btimeSec + starttimeTicks / userHz) * 1000).toISOString();

/** Split `/proc/<pid>/cmdline` (NUL-separated, NUL-terminated) into argv. */
export const parseCmdline = (raw: string): string[] => raw.split("\0").filter((s) => s.length > 0);

const readBtime = (): number | null => {
  try {
    const stat = nodeFs.readFileSync("/proc/stat", "utf8");
    const m = stat.match(/^btime\s+(\d+)/m);
    return m ? Number(m[1]) : null;
  } catch {
    return null;
  }
};

const snapshot = (pid: number, btime: number | null): ProcessSnapshot | null => {
  let argv: string[];
  try {
    argv = parseCmdline(nodeFs.readFileSync(`/proc/${pid}/cmdline`, "utf8"));
  } catch {
    return null; // process vanished between readdir and read
  }
  if (argv.length === 0) return null; // kernel thread
  let pgid = pid;
  let startedAt: string | null = null;
  try {
    const stat = parseProcStat(nodeFs.readFileSync(`/proc/${pid}/stat`, "utf8"));
    if (stat) {
      pgid = stat.pgid;
      if (btime !== null) startedAt = startedAtFromStat(stat.starttimeTicks, btime);
    }
  } catch {
    /* keep defaults */
  }
  let cwd: string | null = null;
  try {
    cwd = nodeFs.readlinkSync(`/proc/${pid}/cwd`);
  } catch {
    cwd = null; // EACCES for processes we don't own, or already exited
  }
  return { pid, pgid, cwd, argv, startedAt };
};

const isJava = (argv: readonly string[]): boolean => {
  const exe = argv[0] ?? "";
  const base = exe.slice(exe.lastIndexOf("/") + 1);
  return base === "java";
};

export const ProcessProbeLive = Layer.succeed(ProcessProbeService, {
  listJava: Effect.sync(() => {
    const btime = readBtime();
    let pids: string[];
    try {
      pids = nodeFs.readdirSync("/proc");
    } catch {
      return [];
    }
    const out: ProcessSnapshot[] = [];
    for (const entry of pids) {
      if (!/^\d+$/.test(entry)) continue;
      const snap = snapshot(Number(entry), btime);
      if (snap && isJava(snap.argv)) out.push(snap);
    }
    return out;
  }),
  inspect: (pid: number) => Effect.sync(() => snapshot(pid, readBtime())),
});
