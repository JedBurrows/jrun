/** The last `n` lines of `content`, dropping one trailing-newline empty line.
 *  Used to fit a growing log into a fixed-height pane (newest at the bottom). */
export const tailLines = (content: string | null, n: number): string[] => {
  if (!content) return [];
  const lines = content.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return n <= 0 ? [] : lines.slice(-n);
};
