/** Make an ISO timestamp filename-safe (`:`/`.` → `-`). */
export const compactStamp = (iso: string): string => iso.replace(/[:.]/g, "-");

/** `<hash>-<mainClass>-<stampCompact>-<pid>.log` */
export const logFileName = (
  hash: string,
  mainClass: string,
  stampCompact: string,
  pid: number
): string => `${hash}-${mainClass}-${stampCompact}-${pid}.log`;

const newest = (matches: string[]): string | null =>
  matches.length > 0 ? matches.sort()[matches.length - 1]! : null;

/** The log of a specific running instance: prefix `<hash>-<class>-` + suffix
 *  `-<pid>.log`. The leading `-` on the suffix prevents pid-substring matches
 *  (pid 3 must not match `…-300.log`). Newest by name wins on PID reuse. */
export const pickRunningLog = (
  files: readonly string[],
  hash: string,
  mainClass: string,
  pid: number
): string | null => {
  const prefix = `${hash}-${mainClass}-`;
  const suffix = `-${pid}.log`;
  return newest(files.filter((f) => f.startsWith(prefix) && f.endsWith(suffix)));
};

/** The newest log for a class regardless of pid (used for exited runs). */
export const pickNewestLog = (
  files: readonly string[],
  hash: string,
  mainClass: string
): string | null => {
  const prefix = `${hash}-${mainClass}-`;
  return newest(files.filter((f) => f.startsWith(prefix) && f.endsWith(".log")));
};

/** Class-agnostic lookup by pid: `<hash>-*-<pid>.log` — used when an exited
 *  PID's class is no longer known (the process isn't in the scan). */
export const pickLogByPid = (
  files: readonly string[],
  hash: string,
  pid: number
): string | null => {
  const prefix = `${hash}-`;
  const suffix = `-${pid}.log`;
  return newest(files.filter((f) => f.startsWith(prefix) && f.endsWith(suffix)));
};
