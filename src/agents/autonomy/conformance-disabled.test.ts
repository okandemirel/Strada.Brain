/**
 * AUT-3 (audited 2026-09-24): `enabled: false` was honoured by four of the
 * guard's rules. A real-tree repair is built with the guard switched off
 * (conformanceAppliesTo), and a one-line compile fix still got [STRADA MODULE
 * INCOMPLETE] and [STRADA FILE TOO LONG] over files it never touched.
 */
import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import os from "node:os";
import { StradaConformanceGuard } from "./strada-conformance.js";

const deps = {
  coreInstalled: true, corePath: "/core", modulesInstalled: false,
  mcpInstalled: true, mcpPath: "/mcp", mcpVersion: "1.0.0", warnings: [],
} as const;

/** A module with no ModuleConfig or .asmdef, an overlong untouched file and no scene. */
function brokenProject(): { root: string; edited: string } {
  const root = mkdtempSync(join(os.tmpdir(), "conformance-off-"));
  const scripts = join(root, "Assets", "Modules", "Combat", "Scripts");
  mkdirSync(scripts, { recursive: true });
  const edited = join(scripts, "CombatService.cs");
  writeFileSync(edited, "public class CombatService { }\n");
  writeFileSync(join(scripts, "Legacy.cs"), "// legacy\n".repeat(261));
  return { root, edited };
}

function guardAfterEdit(enabled: boolean): StradaConformanceGuard {
  const { root, edited } = brokenProject();
  const guard = new StradaConformanceGuard(deps, { projectPath: root, enabled });
  guard.trackToolCall("file_edit", { path: edited }, false);
  // A play-mode run with no captured frame opens NOTHING DRAWN as well.
  guard.trackToolCall("unity_playmode_verify", { projectPath: root }, false);
  return guard;
}

describe("a disabled conformance guard (AUT-3)", () => {
  it("guard: the same edit with the guard on does raise gates", () => {
    const guard = guardAfterEdit(true);
    expect(guard.getPrompt()).toContain("[STRADA MODULE INCOMPLETE]");
    expect(guard.unmetDeliveryConditions().length).toBeGreaterThan(0);
  });

  it("raises no gate, on any call", () => {
    const guard = guardAfterEdit(false);
    for (let call = 0; call < 5; call++) {
      expect(guard.getPrompt()).toBeNull();
    }
  });

  it("claims no unmet delivery condition", () => {
    expect(guardAfterEdit(false).unmetDeliveryConditions()).toEqual([]);
  });
});
