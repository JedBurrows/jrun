import { useStdout } from "ink";
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

/** Terminal size, updating on SIGWINCH ("resize"). Reads Ink's stdout so tests
 *  see the renderer's deterministic dimensions instead of the real process. */
export const useTerminalSize = (): TerminalSize => {
  const { stdout } = useStdout();
  const [size, setSize] = useState<TerminalSize>(() => readSize(stdout));
  useEffect(() => {
    if (!stdout) return;
    const onResize = () => setSize(readSize(stdout));
    stdout.on("resize", onResize);
    return () => {
      stdout.off("resize", onResize);
    };
  }, [stdout]);
  return size;
};
