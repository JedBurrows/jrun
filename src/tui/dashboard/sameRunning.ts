import type { ProcessRecord } from "../../services/ProcessManager.js";

/** True when two running lists are the same processes in the same order
 *  (compared by pid). Used to skip a no-op state update on each poll tick. */
export const sameRunning = (a: readonly ProcessRecord[], b: readonly ProcessRecord[]): boolean =>
  a.length === b.length && a.every((r, i) => r.pid === b[i]?.pid);
