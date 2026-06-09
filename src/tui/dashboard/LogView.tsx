import { Box, Text } from "ink";
import React from "react";

interface Props {
  mainClass: string;
  text: string | null;
}

/**
 * Full-pane log viewer. Replaces the panels/detail while in "logs" mode. Key
 * handling (q/Esc close, r reload) lives in Dashboard's useInput.
 */
export function LogView({ mainClass, text }: Props) {
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1} flexGrow={1}>
      <Text bold color="cyan">
        Logs: {mainClass}
      </Text>
      <Box flexDirection="column" marginTop={1}>
        <Text>{text ?? "(no log available)"}</Text>
      </Box>
      <Box marginTop={1}>
        <Text dimColor>q/Esc close · r reload</Text>
      </Box>
    </Box>
  );
}
