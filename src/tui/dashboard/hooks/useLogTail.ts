import { useEffect, useState } from "react";
import type { JrunApi } from "../../../api/JrunApi.js";
import { tailLines } from "../tailLines.js";

export interface TailTarget {
  readonly mainClass: string;
  readonly pid: number;
}

/** Live-tail a running process's log: polls `readLogByPid` every `tickMs` and
 *  returns the last `lines` lines. No-op (empty) when `target` is null. */
export const useLogTail = (
  api: JrunApi,
  target: TailTarget | null,
  lines: number,
  tickMs: number
): { lines: string[]; empty: boolean } => {
  const [content, setContent] = useState<string | null>(null);

  // Keyed on the mainClass/pid primitives on purpose: depending on the `target`
  // object would restart the poll every render (callers pass a fresh object).
  // biome-ignore lint/correctness/useExhaustiveDependencies: intentional primitive deps
  useEffect(() => {
    if (!target) {
      setContent(null);
      return;
    }
    setContent(null); // RF3: drop the previous target's log immediately on switch
    let cancelled = false;
    const poll = async () => {
      try {
        const text = await api.readLogByPid(target.mainClass, target.pid);
        if (!cancelled) setContent(text);
      } catch {
        /* keep last content on a transient error */
      }
    };
    void poll();
    const id = setInterval(poll, tickMs);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [api, target?.mainClass, target?.pid, tickMs]);

  const out = tailLines(content, lines);
  return { lines: out, empty: content === null || out.length === 0 };
};
