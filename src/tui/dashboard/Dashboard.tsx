import { Box, Text, useInput } from "ink";
import React, { useCallback, useEffect, useState } from "react";
import type { JrunApi } from "../../api/JrunApi.js";
import type { RunConfig } from "../../services/ConfigStore.js";
import { DetailPane } from "./DetailPane.js";
import { Panels } from "./Panels.js";
import { StatusBar } from "./StatusBar.js";
import { type KeyFlags, resolveKey } from "./keymap.js";
import { initialNav, reduceNav } from "./navigation.js";
import type { DashboardData, NavState } from "./types.js";

export type DashboardIntent = { type: "quit" };

interface Props {
  api: JrunApi;
  onExit: (intent: DashboardIntent) => void;
}

const EMPTY: DashboardData = {
  configs: [],
  running: [],
  mainClasses: [],
  configDetails: {},
};

const NAV_ACTIONS = new Set([
  "moveUp",
  "moveDown",
  "nextPanel",
  "prevPanel",
  "focusPanel",
  "top",
  "bottom",
]);

export function Dashboard({ api, onExit }: Props) {
  const [data, setData] = useState<DashboardData | null>(null);
  const [nav, setNav] = useState<NavState>(initialNav);
  const [message] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const [configs, running, mainClasses] = await Promise.all([
      api.listConfigs(),
      api.listRunning(),
      api.listMainClasses(),
    ]);
    const configDetails: Record<string, RunConfig> = {};
    await Promise.all(
      configs.map(async (name) => {
        const cfg = await api.loadConfig(name);
        if (cfg) configDetails[name] = cfg;
      })
    );
    setData({ configs, running, mainClasses, configDetails });
  }, [api]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useInput((input, key) => {
    const flags: KeyFlags = {
      upArrow: key.upArrow,
      downArrow: key.downArrow,
      leftArrow: key.leftArrow,
      rightArrow: key.rightArrow,
      tab: key.tab,
      shift: key.shift,
      return: key.return,
      escape: key.escape,
    };
    const action = resolveKey(input, flags, nav.focused);
    if (!action) return;
    if (NAV_ACTIONS.has(action.type)) {
      setNav((n) => reduceNav(n, action, data ?? EMPTY));
      return;
    }
    if (action.type === "quit") {
      onExit({ type: "quit" });
      return;
    }
    if (action.type === "refresh") {
      void refresh();
      return;
    }
    // Other actions (start/kill/edit/delete/help/...) are wired in a later task.
  });

  if (data === null) {
    return (
      <Box padding={1}>
        <Text>Loading…</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column">
      <Box flexDirection="row">
        <Panels data={data} nav={nav} />
        <DetailPane data={data} nav={nav} />
      </Box>
      <StatusBar panel={nav.focused} message={message} />
    </Box>
  );
}
