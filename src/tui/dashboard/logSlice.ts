/** The [start, end) slice of `count` log lines to show in a `view`-tall pane,
 *  anchored to the bottom (newest), scrolled up by `offsetFromBottom` lines. */
export const logSlice = (
  count: number,
  view: number,
  offsetFromBottom: number
): { start: number; end: number } => {
  const v = Math.max(1, view);
  const end = Math.max(0, count - Math.max(0, offsetFromBottom));
  const start = Math.max(0, end - v);
  return { start, end };
};
