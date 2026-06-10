/**
 * jrun's process discovery reads `/proc`, which only exists on Linux (and WSL,
 * which reports `process.platform === "linux"`). Returns an error message to
 * print, or `null` when the platform is supported.
 */
export const unsupportedPlatformMessage = (platform: string): string | null => {
  if (platform === "linux") return null;
  return `jrun requires Linux or WSL (detected ${platform}). Process discovery relies on /proc, which is unavailable on this platform.`;
};
