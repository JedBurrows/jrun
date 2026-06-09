import { Box, Text } from "ink";
import React from "react";

/**
 * Presentational y/N confirmation line. Input is handled by Dashboard's
 * useInput while in "confirm" mode.
 */
export function ConfirmPrompt({ label }: { label: string }) {
  return (
    <Box paddingX={1}>
      <Text color="yellow">{label}</Text>
    </Box>
  );
}

/**
 * Presentational text field. The `value` is the live buffer owned by Dashboard;
 * input is handled by Dashboard's useInput while in "prompt" mode.
 */
export function TextPrompt({ label, value }: { label: string; value: string }) {
  return (
    <Box paddingX={1}>
      <Text color="cyan">{label} </Text>
      <Text>{value}</Text>
      <Text>▌</Text>
    </Box>
  );
}
