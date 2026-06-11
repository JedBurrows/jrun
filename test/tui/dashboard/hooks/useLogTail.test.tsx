import { render } from "ink-testing-library";
import { Text } from "ink";
import React from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { useLogTail } from "../../../../src/tui/dashboard/hooks/useLogTail.js";
import type { JrunApi } from "../../../../src/api/JrunApi.js";

const makeApi = (text: string | null): JrunApi =>
  ({ readLogByPid: async () => text }) as unknown as JrunApi;

function Probe({ api, target }: { api: JrunApi; target: { mainClass: string; pid: number } | null }) {
  const { lines } = useLogTail(api, target, 2, 1000);
  return <Text>{lines.join("|")}</Text>;
}

describe("useLogTail", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  test("returns the last n lines from the initial poll", async () => {
    const api = makeApi("a\nb\nc");
    const { lastFrame, unmount } = render(<Probe api={api} target={{ mainClass: "C", pid: 1 }} />);
    await vi.advanceTimersByTimeAsync(0); // let the initial poll's promise resolve
    expect(lastFrame()).toBe("b|c");
    unmount();
  });

  test("no target → empty", async () => {
    const api = makeApi("x\ny");
    const { lastFrame, unmount } = render(<Probe api={api} target={null} />);
    await vi.advanceTimersByTimeAsync(0);
    expect(lastFrame()).toBe("");
    unmount();
  });
});
