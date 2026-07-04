import { describe, expect, it } from "vitest";
import {
  applyToolState,
  INSPECT_IMAGE_TOOL_NAME,
  isToolActive,
  parseToggleArgument,
} from "../src/tool-toggle.ts";

const TOOL = INSPECT_IMAGE_TOOL_NAME;

describe("parseToggleArgument", () => {
  it("treats empty/whitespace input as a toggle", () => {
    expect(parseToggleArgument("")).toBeUndefined();
    expect(parseToggleArgument("   ")).toBeUndefined();
  });

  it("recognises enable synonyms", () => {
    for (const value of ["on", "enable", "enabled", "1", "true", "yes", "ON", "Enable"]) {
      expect(parseToggleArgument(value)).toBe(true);
    }
  });

  it("recognises disable synonyms", () => {
    for (const value of ["off", "disable", "disabled", "0", "false", "no", "OFF"]) {
      expect(parseToggleArgument(value)).toBe(false);
    }
  });

  it("falls back to toggle for unknown words", () => {
    expect(parseToggleArgument("banana")).toBeUndefined();
  });
});

describe("applyToolState", () => {
  it("appends the tool when toggled on from an empty list", () => {
    expect(applyToolState([], TOOL, undefined)).toEqual([TOOL]);
  });

  it("removes the tool when toggled off from an active list", () => {
    expect(applyToolState([TOOL], TOOL, undefined)).toEqual([]);
  });

  it("does not duplicate the tool when explicitly enabled while already active", () => {
    expect(applyToolState(["read", TOOL], TOOL, true)).toEqual(["read", TOOL]);
  });

  it("appends when explicitly enabled and not yet present", () => {
    expect(applyToolState(["read", "bash"], TOOL, true)).toEqual(["read", "bash", TOOL]);
  });

  it("removes when explicitly disabled", () => {
    expect(applyToolState(["read", TOOL, "bash"], TOOL, false)).toEqual(["read", "bash"]);
  });

  it("is a no-op when disabling a tool that was not active", () => {
    expect(applyToolState(["read", "bash"], TOOL, false)).toEqual(["read", "bash"]);
  });

  it("preserves order of unrelated tools", () => {
    expect(applyToolState(["bash", TOOL, "read", "write"], TOOL, undefined)).toEqual([
      "bash",
      "read",
      "write",
    ]);
  });
});

describe("isToolActive", () => {
  it("reports presence", () => {
    expect(isToolActive([TOOL], TOOL)).toBe(true);
  });

  it("reports absence", () => {
    expect(isToolActive(["read", "bash"], TOOL)).toBe(false);
  });
});
