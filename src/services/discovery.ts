import type { ProcessSnapshot } from "./ProcessProbe.js";

/** A discovered process — a ProcessRecord minus the (derived) log path. */
export interface DiscoveredProcess {
  readonly pid: number;
  readonly pgid: number;
  readonly mainClass: string;
  readonly startedAt: string | null;
  readonly args: readonly string[];
  readonly debugPort: number | null;
}

/**
 * The launch marker jrun injects so it can recognize its own processes.
 * SINGLE SOURCE OF TRUTH — `buildJavaArgs` (the spawn side, a later task) imports
 * this same helper, so the token can never drift between spawn and discovery.
 */
export const projectMarker = (hash: string): string => `-Djrun.project=${hash}`;

const CP_FLAGS = new Set(["-cp", "-classpath", "--class-path"]);

/** A process is jrun's iff its argv carries the exact marker token. */
export const ownsProcess = (argv: readonly string[], marker: string): boolean =>
  argv.includes(marker);

/**
 * Main class read positionally — ownership is already established by the marker,
 * so we just take the token after `-cp`/`-classpath`/`--class-path`. jrun always
 * emits `… -cp <classpath> <mainClass> <args…>`, and `/proc/cmdline` keeps the
 * classpath as ONE argv element even with spaces, so this is exact for jrun
 * launches. Returns null if no classpath flag is present.
 */
export const extractMainClass = (argv: readonly string[]): string | null => {
  for (let i = 0; i < argv.length; i++) {
    if (CP_FLAGS.has(argv[i]!) && i + 2 < argv.length) return argv[i + 2]!;
  }
  return null;
};

/** Parse a JDWP debug port from `-agentlib:jdwp=…address=[host:]PORT`. */
export const extractDebugPort = (argv: readonly string[]): number | null => {
  for (const tok of argv) {
    if (!tok.includes("jdwp")) continue;
    const m = tok.match(/address=(?:[^:,]*:)?(\d+)/);
    if (m) return Number(m[1]);
  }
  return null;
};

/** Program args are everything after the main-class token (first occurrence). */
export const extractProgramArgs = (argv: readonly string[], mainClass: string): string[] => {
  const idx = argv.indexOf(mainClass);
  return idx < 0 ? [] : argv.slice(idx + 1);
};

export interface MatchContext {
  readonly marker: string;
}

/**
 * Own a snapshot by marker, then reconstruct its record. Returns null for any
 * process jrun did not launch (no marker). A marked process is ALWAYS returned
 * (never orphaned); if its class can't be read it gets mainClass "(unknown)".
 */
export const matchProcess = (
  snap: ProcessSnapshot,
  ctx: MatchContext
): DiscoveredProcess | null => {
  if (!ownsProcess(snap.argv, ctx.marker)) return null;
  const mainClass = extractMainClass(snap.argv) ?? "(unknown)";
  return {
    pid: snap.pid,
    pgid: snap.pgid,
    mainClass,
    startedAt: snap.startedAt,
    args: extractProgramArgs(snap.argv, mainClass),
    debugPort: extractDebugPort(snap.argv),
  };
};
