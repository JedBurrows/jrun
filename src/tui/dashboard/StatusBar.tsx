import { Box, Text } from "ink";
import React from "react";
import type { Panel } from "./types.js";

interface Props {
  panel: Panel;
  message: string | null;
}

const HINTS: Record<Panel, string> = {
  configs: "↑↓/jk nav  s start  S debug  e edit  d delete  ?:help  q:quit",
  running: "↑↓/jk nav  x kill  ⏎ logs  ?:help  q:quit",
  mainClasses: "↑↓/jk nav  s start  S debug  w save  ?:help  q:quit",
};

export function StatusBar({ panel, message }: Props) {
  return (
    <Box paddingX={1}>
      {message !== null ? (
        <Text color="green">{message}</Text>
      ) : (
        <Text dimColor>{HINTS[panel]}</Text>
      )}
    </Box>
  );
}
