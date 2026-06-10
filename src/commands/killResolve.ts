import type { ProcessRecord } from "../services/ProcessManager.js";

export type KillTarget =
  | { kind: "pid"; pid: number; owned: boolean }
  | { kind: "ambiguous"; instances: ProcessRecord[] }
  | { kind: "notfound" };

/** Resolve a `kill` argument (a PID string or a class name) against the
 *  currently-running set. A numeric arg is always a PID; `owned` says whether
 *  it is one jrun currently manages (used to gate an unmanaged-PID kill). */
export const resolveKillTarget = (arg: string, running: readonly ProcessRecord[]): KillTarget => {
  if (/^\d+$/.test(arg)) {
    const pid = Number(arg);
    return { kind: "pid", pid, owned: running.some((r) => r.pid === pid) };
  }
  const matches = running.filter((r) => r.mainClass === arg);
  if (matches.length === 0) return { kind: "notfound" };
  if (matches.length === 1) return { kind: "pid", pid: matches[0]!.pid, owned: true };
  return { kind: "ambiguous", instances: [...matches] };
};
