/**
 * The acceptance checks' folder is the system's (GDD-drift plan W00/W07).
 *
 * A worker's lease must never write or delete a check the campaign judges it
 * by. The question "is this path inside that folder" has to be answered the
 * same way however the path is spelled: leases live under macOS /var/folders,
 * which is /private/var by its real name, and a comparison that mixed the two
 * forms judged lease paths "outside the project" three times before.
 */

import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ACCEPTANCE_DIR, isSystemOwnedCheckPath } from "./system-owned-path.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function project(): string {
  const root = mkdtempSync(join(tmpdir(), "strada-acceptance-path-"));
  dirs.push(root);
  mkdirSync(join(root, "Assets", "StradaAcceptance", "M1"), { recursive: true });
  mkdirSync(join(root, "Assets", "Scripts"), { recursive: true });
  writeFileSync(join(root, "Assets", "StradaAcceptance", "M1", "Acceptance_M1.cs"), "// check\n");
  return root;
}

describe("isSystemOwnedCheckPath", () => {
  it("names the folder the plan reserves", () => {
    expect(ACCEPTANCE_DIR).toBe("Assets/StradaAcceptance");
  });

  it("a project-relative path inside the folder, the folder itself and its .meta are the system's", () => {
    expect(isSystemOwnedCheckPath("Assets/StradaAcceptance/M1/Acceptance_M1.cs")).toBe(true);
    expect(isSystemOwnedCheckPath("Assets/StradaAcceptance/M1/Acceptance_M1.cs.meta")).toBe(true);
    expect(isSystemOwnedCheckPath("Assets/StradaAcceptance")).toBe(true);
    expect(isSystemOwnedCheckPath("Assets/StradaAcceptance/")).toBe(true);
    expect(isSystemOwnedCheckPath("Assets/StradaAcceptance.meta")).toBe(true);
    expect(isSystemOwnedCheckPath("./Assets/StradaAcceptance/Strada.Acceptance.asmdef")).toBe(true);
  });

  it("however the separators, the case or a detour through .. spell it", () => {
    expect(isSystemOwnedCheckPath("Assets\\StradaAcceptance\\M1\\Acceptance_M1.cs")).toBe(true);
    // APFS and NTFS are case-insensitive by default: this is the same folder.
    expect(isSystemOwnedCheckPath("assets/stradaacceptance/M1/x.cs")).toBe(true);
    expect(isSystemOwnedCheckPath("Assets/Scripts/../StradaAcceptance/M1/x.cs")).toBe(true);
  });

  it("anything else is not, including a lookalike name and a path outside the project", () => {
    expect(isSystemOwnedCheckPath("Assets/Scripts/Player.cs")).toBe(false);
    expect(isSystemOwnedCheckPath("Assets/StradaAcceptanceExtra/x.cs")).toBe(false);
    expect(isSystemOwnedCheckPath("Assets/Scripts/StradaAcceptance/x.cs")).toBe(false);
    expect(isSystemOwnedCheckPath("Packages/StradaAcceptance/x.cs")).toBe(false);
    expect(isSystemOwnedCheckPath("StradaAcceptance/x.cs")).toBe(false);
    expect(isSystemOwnedCheckPath("../Assets/StradaAcceptance/x.cs")).toBe(false);
    expect(isSystemOwnedCheckPath("Assets/StradaAcceptance/../Scripts/x.cs")).toBe(false);
    expect(isSystemOwnedCheckPath("")).toBe(false);
  });

  it("an absolute path is judged against the root by both its names (symlinked root)", () => {
    const real = project();
    const link = `${real}-link`;
    symlinkSync(real, link, "dir");
    dirs.push(link);
    const check = join("Assets", "StradaAcceptance", "M1", "Acceptance_M1.cs");
    // Root by its link name, path by its real name — and the other way round.
    expect(isSystemOwnedCheckPath(join(real, check), link)).toBe(true);
    expect(isSystemOwnedCheckPath(join(link, check), real)).toBe(true);
    // A file that does not exist yet: its nearest existing ancestor decides.
    expect(isSystemOwnedCheckPath(join(link, "Assets", "StradaAcceptance", "M9", "New.cs"), real)).toBe(true);
    // A relative path with the link as its root.
    expect(isSystemOwnedCheckPath(check, link)).toBe(true);
    // The rest of the project stays the worker's.
    expect(isSystemOwnedCheckPath(join(link, "Assets", "Scripts", "Player.cs"), real)).toBe(false);
    expect(isSystemOwnedCheckPath(join(real, "Assets", "Scripts", "Player.cs"), link)).toBe(false);
  });

  it("/var and /private/var are one directory (macOS leases)", () => {
    const lexical = project();
    const real = realpathSync.native(lexical);
    if (process.platform === "darwin") {
      // The fixture only means something where the temp dir has two names.
      expect(real).not.toBe(lexical);
    }
    const check = join("Assets", "StradaAcceptance", "M1", "Acceptance_M1.cs");
    expect(isSystemOwnedCheckPath(join(real, check), lexical)).toBe(true);
    expect(isSystemOwnedCheckPath(join(lexical, check), real)).toBe(true);
    expect(isSystemOwnedCheckPath(join(real, "Assets", "Scripts", "x.cs"), lexical)).toBe(false);
  });

  it("a link inside the project that leads into the folder is the folder", () => {
    const root = project();
    symlinkSync(join(root, "Assets", "StradaAcceptance"), join(root, "Assets", "Scripts", "Shortcut"), "dir");
    // Only a root lets the link be followed; the spelling alone looks innocent.
    expect(isSystemOwnedCheckPath("Assets/Scripts/Shortcut/M1/Acceptance_M1.cs", root)).toBe(true);
    expect(isSystemOwnedCheckPath("Assets/Scripts/Shortcut/M1/Acceptance_M1.cs")).toBe(false);
  });

  it("without a root, an absolute path is the system's when it runs through the folder", () => {
    expect(isSystemOwnedCheckPath("/proj/Assets/StradaAcceptance/M1/x.cs")).toBe(true);
    expect(isSystemOwnedCheckPath("/proj/Assets/StradaAcceptance.meta")).toBe(true);
    expect(isSystemOwnedCheckPath("/proj/Assets/Scripts/x.cs")).toBe(false);
    expect(isSystemOwnedCheckPath("/proj/Assets/StradaAcceptanceExtra/x.cs")).toBe(false);
  });
});
