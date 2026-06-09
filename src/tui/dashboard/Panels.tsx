import { Box, Text } from "ink";
import React from "react";
import type { ProcessRecord } from "../../services/ProcessManager.js";
import type { DashboardData, NavState, Panel } from "./types.js";

interface Props {
  data: DashboardData;
  nav: NavState;
}

const runningLabel = (r: ProcessRecord): string =>
  `${r.mainClass} (PID ${r.pid})${r.debugPort ? ` [debug:${r.debugPort}]` : ""}`;

const rowsFor = (panel: Panel, data: DashboardData): string[] => {
  if (panel === "configs") return [...data.configs];
  if (panel === "running") return data.running.map(runningLabel);
  return [...data.mainClasses];
};

interface PanelBoxProps {
  panel: Panel;
  title: string;
  rows: string[];
  focused: boolean;
  selected: number;
}

function PanelBox({ panel, title, rows, focused, selected }: PanelBoxProps) {
  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={focused ? "green" : "gray"}
      paddingX={1}
    >
      <Text bold={focused} color={focused ? "green" : "cyan"}>
        {title}
      </Text>
      {rows.length === 0 ? (
        <Text dimColor>(none)</Text>
      ) : (
        rows.map((row, i) => {
          const isSelected = focused && i === selected;
          return (
            <Text key={`${panel}-${i}`} color={isSelected ? "green" : undefined} bold={isSelected}>
              {isSelected ? "▶ " : "  "}
              {row}
            </Text>
          );
        })
      )}
    </Box>
  );
}

export function Panels({ data, nav }: Props) {
  return (
    <Box flexDirection="column" width={36}>
      <PanelBox
        panel="configs"
        title="Configs"
        rows={rowsFor("configs", data)}
        focused={nav.focused === "configs"}
        selected={nav.selected.configs}
      />
      <PanelBox
        panel="running"
        title="Running"
        rows={rowsFor("running", data)}
        focused={nav.focused === "running"}
        selected={nav.selected.running}
      />
      <PanelBox
        panel="mainClasses"
        title="Main classes"
        rows={rowsFor("mainClasses", data)}
        focused={nav.focused === "mainClasses"}
        selected={nav.selected.mainClasses}
      />
    </Box>
  );
}
