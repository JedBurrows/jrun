import { useEffect, useState } from "react";

export interface TerminalSize {
  readonly columns: number;
  readonly rows: number;
}

/** Read terminal dimensions with sane fallbacks (e.g. a non-TTY). */
export const readSize = (stdout: NodeJS.WriteStream | undefined): TerminalSize => ({
  columns: stdout?.columns ?? 80,
  rows: stdout?.rows ?? 24,
});

/** Terminal size, updating on SIGWINCH ("resize"). */
export const useTerminalSize = (): TerminalSize => {
  const [size, setSize] = useState<TerminalSize>(() => readSize(process.stdout));
  useEffect(() => {
    const onResize = () => setSize(readSize(process.stdout));
    process.stdout.on("resize", onResize);
    return () => {
      process.stdout.off("resize", onResize);
    };
  }, []);
  return size;
};
