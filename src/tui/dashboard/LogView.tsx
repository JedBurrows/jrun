import { Box, type DOMElement, Text } from "ink";
import React, { useRef } from "react";
import { useElementHeight } from "./hooks/useElementHeight.js";
import { logSlice } from "./logSlice.js";

interface Props {
  mainClass: string;
  pid: number;
  lines: string[];
  offsetFromBottom: number;
}

/** Fullscreen log zoom: title + measured scrollable body + footer. Title/footer
 *  sit OUTSIDE the measured body so they're never clipped (RF10). */
export function LogView({ mainClass, pid, lines, offsetFromBottom }: Props) {
  const bodyRef = useRef<DOMElement | null>(null);
  const view = useElementHeight(bodyRef);
  const { start, end } = logSlice(lines.length, view, offsetFromBottom);
  const shown = lines.slice(start, end);
  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor="cyan"
      paddingX={1}
      flexGrow={1}
      overflow="hidden"
    >
      <Text bold color="cyan" wrap="truncate">
        Logs: {mainClass} (PID {pid})
      </Text>
      <Box ref={bodyRef} flexDirection="column" flexGrow={1} overflow="hidden">
        {shown.length === 0 ? (
          <Text dimColor>(no log available)</Text>
        ) : (
          shown.map((l, i) => (
            <Text key={start + i} wrap="truncate">
              {l}
            </Text>
          ))
        )}
      </Box>
      <Text dimColor wrap="truncate">
        q/Esc close · j/k scroll · g/G top/bottom
        {offsetFromBottom > 0 ? "  [scrolled]" : "  [live]"}
      </Text>
    </Box>
  );
}
