import { Box, type DOMElement, Text } from "ink";
import React, { useRef } from "react";
import type { ProcessRecord } from "../../services/ProcessManager.js";
import { useElementHeight } from "./hooks/useElementHeight.js";
import type { DashboardData, NavState, Panel } from "./types.js";
import { windowRows } from "./windowRows.js";

interface Props {
  data: DashboardData;
  nav: NavState;
  width: number;
}

const runningLabel = (r: ProcessRecord): string =>
  `${r.mainClass}  ${r.pid}${r.debugPort ? "  ●dbg" : ""}`;

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
  grow: number;
}

function PanelBox({ panel, title, rows, focused, selected, grow }: PanelBoxProps) {
  const innerRef = useRef<DOMElement | null>(null);
  const innerHeight = useElementHeight(innerRef);
  const maxRows = Math.max(1, innerHeight); // measured box already excludes border+title
  const win = windowRows(rows.length, selected, maxRows);
  const shown = rows.slice(win.start, win.end);
  return (
    <Box
      flexDirection="column"
      flexGrow={grow}
      flexBasis={0}
      minHeight={3}
      borderStyle="round"
      borderColor={focused ? "green" : "gray"}
      paddingX={1}
      overflow="hidden"
    >
      <Text bold={focused} color={focused ? "green" : "cyan"} wrap="truncate">
        {title}
        {rows.length > shown.length ? `  (${rows.length})` : ""}
      </Text>
      <Box ref={innerRef} flexDirection="column" flexGrow={1} overflow="hidden">
        {rows.length === 0 ? (
          <Text dimColor>(none)</Text>
        ) : (
          shown.map((row, i) => {
            const idx = win.start + i;
            const isSelected = focused && idx === selected;
            return (
              <Text
                key={`${panel}-${idx}`}
                color={isSelected ? "green" : undefined}
                bold={isSelected}
                wrap="truncate"
              >
                {isSelected ? "▶ " : "  "}
                {row}
              </Text>
            );
          })
        )}
      </Box>
    </Box>
  );
}

export function LeftColumn({ data, nav, width }: Props) {
  return (
    <Box flexDirection="column" width={width} flexShrink={0}>
      <PanelBox
        panel="running"
        title="Running"
        rows={rowsFor("running", data)}
        focused={nav.focused === "running"}
        selected={nav.selected.running}
        grow={3}
      />
      <PanelBox
        panel="mainClasses"
        title="Targets"
        rows={rowsFor("mainClasses", data)}
        focused={nav.focused === "mainClasses"}
        selected={nav.selected.mainClasses}
        grow={2}
      />
      <PanelBox
        panel="configs"
        title="Configs"
        rows={rowsFor("configs", data)}
        focused={nav.focused === "configs"}
        selected={nav.selected.configs}
        grow={1}
      />
    </Box>
  );
}
