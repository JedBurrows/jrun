import { describe, expect, test } from "vitest";
import { unsupportedPlatformMessage } from "../src/platform.js";

describe("unsupportedPlatformMessage", () => {
  test("returns null on linux", () => {
    expect(unsupportedPlatformMessage("linux")).toBeNull();
  });
  test("returns a message naming the platform on darwin", () => {
    const msg = unsupportedPlatformMessage("darwin");
    expect(msg).toContain("darwin");
    expect(msg).toContain("/proc");
  });
  test("returns a message on win32", () => {
    expect(unsupportedPlatformMessage("win32")).toContain("win32");
  });
});
