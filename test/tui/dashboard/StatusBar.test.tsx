import { Box } from "ink";
import { render } from "ink-testing-library";
import React from "react";
import { describe, expect, test } from "vitest";
import { StatusBar } from "../../../src/tui/dashboard/StatusBar.js";

describe("StatusBar", () => {
  test("hints truncate to a single line in a narrow (60-col) terminal", () => {
    const { lastFrame, unmount } = render(
      <Box width={60}>
        <StatusBar panel="running" message={null} />
      </Box>
    );
    const lines = (lastFrame() ?? "").split("\n").filter((l) => l.trim().length > 0);
    expect(lines.length).toBe(1); // truncated, NOT wrapped to 2 lines
    unmount();
  });
});
