import { Box, type DOMElement, Text } from "ink";
import type React from "react";
import { type RefObject, useRef } from "react";
import type { JrunApi } from "../../api/JrunApi.js";
import { useElementHeight } from "./hooks/useElementHeight.js";
import { useLogTail } from "./hooks/useLogTail.js";
import type { DashboardData, NavState } from "./types.js";

interface Props {
  api: JrunApi;
  data: DashboardData;
  nav: NavState;
  tickMs: number;
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <Text wrap="truncate">
      <Text bold>{label}:</Text> {value}
    </Text>
  );
}

/** Bordered pane: title + an optional MEASURED body box + optional footer. The
 *  title/footer sit OUTSIDE the measured/clipped body so they're never clobbered. */
function Frame({
  title,
  footer,
  bodyRef,
  children,
}: {
  title: string;
  footer?: string;
  bodyRef?: RefObject<DOMElement | null>;
  children: React.ReactNode;
}) {
  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor="gray"
      paddingX={1}
      flexGrow={1}
      overflow="hidden"
    >
      <Text bold color="cyan" wrap="truncate">
        {title}
      </Text>
      <Box ref={bodyRef} flexDirection="column" flexGrow={1} overflow="hidden">
        {children}
      </Box>
      {footer ? (
        <Text dimColor wrap="truncate">
          {footer}
        </Text>
      ) : null}
    </Box>
  );
}

function LogTail({ api, data, nav, tickMs }: Props) {
  const rec = data.running[nav.selected.running];
  const bodyRef = useRef<DOMElement | null>(null);
  const h = useElementHeight(bodyRef);
  const target = rec ? { mainClass: rec.mainClass, pid: rec.pid } : null;
  const { lines, empty } = useLogTail(api, target, Math.max(1, h), tickMs);
  if (!rec) {
    return (
      <Frame title="Logs" bodyRef={bodyRef}>
        <Text dimColor>(no process selected)</Text>
      </Frame>
    );
  }
  return (
    <Frame
      title={`Logs: ${rec.mainClass} (PID ${rec.pid})`}
      footer="▏live · ↵ zoom"
      bodyRef={bodyRef}
    >
      {empty ? (
        <Text dimColor>(no log yet)</Text>
      ) : (
        lines.map((l, i) => (
          <Text key={i} wrap="truncate">
            {l}
          </Text>
        ))
      )}
    </Frame>
  );
}

function TargetDetail({ data, nav }: Props) {
  const fqcn = data.mainClasses[nav.selected.mainClasses];
  if (!fqcn)
    return (
      <Frame title="Target">
        <Text dimColor>(nothing selected)</Text>
      </Frame>
    );
  return (
    <Frame title={`Target: ${fqcn}`} footer="s run · S debug · w save">
      <Field label="mainClass" value={fqcn} />
    </Frame>
  );
}

function ConfigDetail({ data, nav }: Props) {
  const name = data.configs[nav.selected.configs];
  const cfg = name ? data.configDetails[name] : undefined;
  if (!cfg)
    return (
      <Frame title="Config">
        <Text dimColor>(nothing selected)</Text>
      </Frame>
    );
  return (
    <Frame title={`Config: ${name}`} footer="⏎/s run · S debug · e edit · d delete">
      <Field label="mainClass" value={cfg.mainClass} />
      <Field
        label="programArgs"
        value={cfg.programArgs.length ? cfg.programArgs.join(" ") : "(none)"}
      />
      <Field label="jvmOpts" value={cfg.jvmOpts.length ? cfg.jvmOpts.join(" ") : "(none)"} />
    </Frame>
  );
}

export function RightPane(props: Props) {
  if (props.nav.focused === "running") return <LogTail {...props} />;
  if (props.nav.focused === "mainClasses") return <TargetDetail {...props} />;
  return <ConfigDetail {...props} />;
}
