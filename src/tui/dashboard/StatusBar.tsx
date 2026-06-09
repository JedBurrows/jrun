import { Box, Text } from "ink";
import React from "react";
import { type Hint, hintsFor } from "./hints.js";
import type { Panel } from "./types.js";

interface Props {
  panel: Panel;
  message: string | null;
}

const format = (hints: readonly Hint[]): string =>
  hints.map((h) => `${h.keys}:${h.label}`).join("  ");

export function StatusBar({ panel, message }: Props) {
  return (
    <Box paddingX={1}>
      {message !== null ? (
        <Text color="green">{message}</Text>
      ) : (
        <Text dimColor>{format(hintsFor(panel))}</Text>
      )}
    </Box>
  );
}
