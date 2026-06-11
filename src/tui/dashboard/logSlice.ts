/** The [start, end) slice of `count` log lines to show in a `view`-tall pane,
 *  anchored to the bottom (newest), scrolled up by `offsetFromBottom` lines. */
export const logSlice = (
  count: number,
  view: number,
  offsetFromBottom: number
): { start: number; end: number } => {
  const v = Math.max(1, view);
  const off = Math.max(0, offsetFromBottom);
  // Floor `end` at a full view (or `count`) so over-scrolling up lands on the
  // oldest `view` lines instead of collapsing to an empty window.
  const end = Math.max(count - off, Math.min(v, count));
  const start = Math.max(0, end - v);
  return { start, end };
};
