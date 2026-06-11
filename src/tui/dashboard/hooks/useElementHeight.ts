import { type DOMElement, measureElement } from "ink";
import { type RefObject, useEffect, useState } from "react";

/** Measured inner height (rows) of a ref'd Ink <Box>. Re-measures after every
 *  render (cheap) so it tracks terminal resizes; React bails when the number is
 *  unchanged. Returns 0 on the first frame, then settles. */
export const useElementHeight = (ref: RefObject<DOMElement | null>): number => {
  const [height, setHeight] = useState(0);
  useEffect(() => {
    if (ref.current) setHeight(measureElement(ref.current).height);
  });
  return height;
};
