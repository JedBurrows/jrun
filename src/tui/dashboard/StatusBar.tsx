import { Box, Text } from "ink";
import React from "react";
import { type Hint, hintsFor } from "./hints.js";
import type { Panel } from "./types.js";

interface Props {
  panel: Panel;
  message: string | null;
  isError?: boolean;
}

const format = (hints: readonly Hint[]): string =>
  hints.map((h) => `${h.keys}:${h.label}`).join("  ");

export function StatusBar({ panel, message, isError = false }: Props) {
  return (
    <Box paddingX={1}>
      {message !== null ? (
        <Text color={isError ? "red" : "green"} wrap="truncate">
          {message}
        </Text>
      ) : (
        <Text dimColor wrap="truncate">
          {format(hintsFor(panel))}
        </Text>
      )}
    </Box>
  );
}
