/**
 * The tool name exposed by this extension. Kept in sync with the
 * `registerTool({ name })` call in `src/index.ts`.
 */
export const INSPECT_IMAGE_TOOL_NAME = "inspect_image";

/**
 * Resolve a free-form command argument into a desired enable state.
 *
 * Returns:
 * - `true`  when the argument asks to turn the tool on.
 * - `false` when the argument asks to turn the tool off.
 * - `undefined` when no clear direction is given, so callers should toggle.
 */
export function parseToggleArgument(arg: string): boolean | undefined {
  const normalized = arg.trim().toLowerCase();
  if (normalized === "") return undefined;
  if (["on", "enable", "enabled", "1", "true", "yes"].includes(normalized)) return true;
  if (["off", "disable", "disabled", "0", "false", "no"].includes(normalized)) return false;
  return undefined;
}

/**
 * Compute the next active-tools list for a named tool given a desired state.
 *
 * @param activeTools  The current active tool names (e.g. from `pi.getActiveTools()`).
 * @param toolName     The tool to turn on/off.
 * @param enable       `true` to enable, `false` to disable, `undefined` to toggle.
 * @returns            The new active tool names. Order is preserved; newly
 *                     enabled tools are appended at the end.
 */
export function applyToolState(
  activeTools: string[],
  toolName: string,
  enable: boolean | undefined,
): string[] {
  const present = activeTools.includes(toolName);
  const wantEnabled = enable === undefined ? !present : enable;

  if (wantEnabled) {
    return present ? [...activeTools] : [...activeTools, toolName];
  }
  return activeTools.filter((name) => name !== toolName);
}

/**
 * Whether the named tool is currently active.
 */
export function isToolActive(activeTools: string[], toolName: string): boolean {
  return activeTools.includes(toolName);
}
