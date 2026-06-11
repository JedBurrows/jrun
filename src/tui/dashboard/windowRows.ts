export interface RowWindow {
  readonly start: number;
  readonly end: number;
}

/** A `[start, end)` slice of `count` rows, at most `max` tall, always containing
 *  `selected`. Centers the selection when scrolled into the middle of a long
 *  list so it never overflows a fixed-height panel. */
export const windowRows = (count: number, selected: number, max: number): RowWindow => {
  if (max <= 0) return { start: 0, end: 0 };
  if (max >= count) return { start: 0, end: count };
  let start = selected - Math.floor(max / 2);
  if (start < 0) start = 0;
  if (start + max > count) start = count - max;
  return { start, end: start + max };
};
