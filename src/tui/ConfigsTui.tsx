import { Box, Text, useApp, useInput } from "ink";
import React, { useState } from "react";
import type { RunConfig } from "../services/ConfigStore.js";

interface Props {
  configs: Record<string, RunConfig>;
  onEdit: (name: string) => void;
  onDelete: (name: string) => Promise<void>;
}

export function ConfigsTui({ configs, onEdit, onDelete }: Props) {
  const names = Object.keys(configs).sort();
  const [selectedIdx, setSelectedIdx] = useState(0);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const { exit } = useApp();

  const selectedName = names[selectedIdx];
  const selectedConfig = selectedName ? configs[selectedName] : undefined;

  useInput((input, key) => {
    if (confirmDelete !== null) {
      if (input === "y" || input === "Y") {
        const name = confirmDelete;
        setConfirmDelete(null);
        onDelete(name).then(() => {
          setMessage(`Deleted ${name}`);
          // Adjust index if needed
          setSelectedIdx((i) => Math.min(i, names.length - 2));
        });
      } else {
        setConfirmDelete(null);
      }
      return;
    }

    if (key.upArrow) {
      setSelectedIdx((i) => Math.max(0, i - 1));
      setMessage(null);
    } else if (key.downArrow) {
      setSelectedIdx((i) => Math.min(names.length - 1, i + 1));
      setMessage(null);
    } else if (input === "e" || input === "E") {
      if (selectedName) {
        exit();
        onEdit(selectedName);
      }
    } else if (input === "d" || input === "D") {
      if (selectedName) {
        setConfirmDelete(selectedName);
      }
    } else if (input === "q" || input === "Q" || key.escape) {
      exit();
    }
  });

  if (names.length === 0) {
    return (
      <Box flexDirection="column" padding={1}>
        <Text color="yellow">No saved configurations.</Text>
        <Text dimColor>Use `jrun save &lt;name&gt; &lt;class&gt;` to create one.</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column">
      <Box flexDirection="row">
        {/* Left pane: config list */}
        <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1} width={30}>
          <Text bold color="cyan">
            {" "}
            Configs{" "}
          </Text>
          {names.map((name, i) => (
            <Text
              key={name}
              color={i === selectedIdx ? "green" : undefined}
              bold={i === selectedIdx}
            >
              {i === selectedIdx ? "▶ " : "  "}
              {name}
            </Text>
          ))}
        </Box>

        {/* Right pane: details */}
        <Box
          flexDirection="column"
          borderStyle="round"
          borderColor="cyan"
          paddingX={1}
          flexGrow={1}
        >
          <Text bold color="cyan">
            {" "}
            Details{" "}
          </Text>
          {selectedConfig ? (
            <Box flexDirection="column" gap={1}>
              <Box flexDirection="column">
                <Text bold>mainClass:</Text>
                <Text> {selectedConfig.mainClass}</Text>
              </Box>
              <Box flexDirection="column">
                <Text bold>programArgs:</Text>
                {selectedConfig.programArgs.length === 0 ? (
                  <Text dimColor> (none)</Text>
                ) : (
                  selectedConfig.programArgs.map((a, i) => <Text key={i}> {a}</Text>)
                )}
              </Box>
              <Box flexDirection="column">
                <Text bold>jvmOpts:</Text>
                {selectedConfig.jvmOpts.length === 0 ? (
                  <Text dimColor> (none)</Text>
                ) : (
                  selectedConfig.jvmOpts.map((o, i) => <Text key={i}> {o}</Text>)
                )}
              </Box>
            </Box>
          ) : null}
        </Box>
      </Box>

      {/* Status bar */}
      <Box paddingX={1} gap={2}>
        {confirmDelete !== null ? (
          <Text color="red">
            Delete <Text bold>{confirmDelete}</Text>? (y/N)
          </Text>
        ) : message !== null ? (
          <Text color="green">{message}</Text>
        ) : (
          <>
            <Text dimColor>↑↓ navigate</Text>
            <Text dimColor>e edit</Text>
            <Text dimColor>d delete</Text>
            <Text dimColor>q quit</Text>
          </>
        )}
      </Box>
    </Box>
  );
}
