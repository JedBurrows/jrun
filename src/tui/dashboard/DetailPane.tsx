import { Box, Text } from "ink";
import type React from "react";
import type { DashboardData, NavState } from "./types.js";

interface Props {
  data: DashboardData;
  nav: NavState;
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <Text>
      <Text bold>{label}:</Text> {value}
    </Text>
  );
}

function Placeholder() {
  return <Text dimColor>(nothing selected)</Text>;
}

export function DetailPane({ data, nav }: Props) {
  const { focused } = nav;
  let body: React.ReactNode;

  if (focused === "configs") {
    const name = data.configs[nav.selected.configs];
    const cfg = name ? data.configDetails[name] : undefined;
    body = cfg ? (
      <Box flexDirection="column">
        <Field label="mainClass" value={cfg.mainClass} />
        <Field
          label="programArgs"
          value={cfg.programArgs.length > 0 ? cfg.programArgs.join(" ") : "(none)"}
        />
        <Field label="jvmOpts" value={cfg.jvmOpts.length > 0 ? cfg.jvmOpts.join(" ") : "(none)"} />
      </Box>
    ) : (
      <Placeholder />
    );
  } else if (focused === "running") {
    const rec = data.running[nav.selected.running];
    body = rec ? (
      <Box flexDirection="column">
        <Field label="mainClass" value={rec.mainClass} />
        <Field label="PID" value={String(rec.pid)} />
        <Field label="startedAt" value={rec.startedAt ?? "(unknown)"} />
        <Field label="args" value={rec.args.length > 0 ? rec.args.join(" ") : "(none)"} />
        <Field label="logFile" value={rec.logFile ?? "(none)"} />
        <Field
          label="debugPort"
          value={rec.debugPort !== null ? String(rec.debugPort) : "(none)"}
        />
      </Box>
    ) : (
      <Placeholder />
    );
  } else {
    const fqcn = data.mainClasses[nav.selected.mainClasses];
    body = fqcn ? (
      <Box flexDirection="column">
        <Field label="mainClass" value={fqcn} />
        <Text dimColor>Press s to run</Text>
      </Box>
    ) : (
      <Placeholder />
    );
  }

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="gray" paddingX={1} flexGrow={1}>
      <Text bold color="cyan">
        Details
      </Text>
      {body}
    </Box>
  );
}
