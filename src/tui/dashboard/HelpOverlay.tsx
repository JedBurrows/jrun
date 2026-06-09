import { Box, Text } from "ink";
import React from "react";
import { type Hint, PANEL_HINTS } from "./hints.js";

const NAVIGATION: readonly Hint[] = [
  { keys: "↑↓/jk", label: "navigate up/down" },
  { keys: "h/l", label: "previous/next panel" },
  { keys: "1/2/3", label: "focus panel" },
  { keys: "g/G", label: "top/bottom" },
  { keys: "r", label: "refresh" },
  { keys: "?", label: "toggle help" },
  { keys: "q", label: "quit" },
];

const Group = ({ title, hints }: { title: string; hints: readonly Hint[] }) => (
  <Box flexDirection="column" marginBottom={1}>
    <Text bold color="cyan">
      {title}
    </Text>
    {hints.map((h) => (
      <Text key={`${h.keys}-${h.label}`}>
        <Text color="yellow">{h.keys.padEnd(8)}</Text>
        {h.label}
      </Text>
    ))}
  </Box>
);

export function HelpOverlay() {
  return (
    <Box flexDirection="column" borderStyle="round" paddingX={1}>
      <Text bold>Keybindings</Text>
      <Box marginTop={1} flexDirection="column">
        <Group title="Navigation" hints={NAVIGATION} />
        <Group title="Configs" hints={PANEL_HINTS.configs} />
        <Group title="Running" hints={PANEL_HINTS.running} />
        <Group title="Main classes" hints={PANEL_HINTS.mainClasses} />
      </Box>
    </Box>
  );
}
