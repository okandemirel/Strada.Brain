import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveStradaHomeEntry } from "./strada-home-entry.js";

describe("resolveStradaHomeEntry", () => {
  let root: string;
  let home: string;
  let appHome: string;
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "strada-home-entry-"));
    home = join(root, "home");
    appHome = join(root, "app-home");
    mkdirSync(home);
    // os.homedir() reads USERPROFILE on Windows, HOME elsewhere.
    vi.stubEnv("HOME", home);
    vi.stubEnv("USERPROFILE", home);
    vi.stubEnv("STRADA_HOME", appHome);
    // No logger is created here, so the notice goes to the console.
    warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    rmSync(root, { recursive: true, force: true });
  });

  it("puts an entry under the app home (STRADA_HOME), not homedir()/.strada", () => {
    expect(resolveStradaHomeEntry("skills")).toBe(join(appHome, "skills"));
    expect(resolveStradaHomeEntry("unity-asset-store.json")).toBe(join(appHome, "unity-asset-store.json"));
    expect(warn).not.toHaveBeenCalled();
  });

  it("keeps using an entry only ~/.strada holds, and names both paths once", () => {
    const legacy = join(home, ".strada", "skills");
    mkdirSync(legacy, { recursive: true });

    expect(resolveStradaHomeEntry("skills")).toBe(legacy);
    expect(resolveStradaHomeEntry("skills")).toBe(legacy);

    expect(warn).toHaveBeenCalledTimes(1);
    const message = String(warn.mock.calls[0]![0]);
    expect(message).toContain(legacy);
    expect(message).toContain(join(appHome, "skills"));
  });

  it("takes the app home's entry once there is one", () => {
    mkdirSync(join(home, ".strada", "skills"), { recursive: true });
    mkdirSync(join(appHome, "skills"), { recursive: true });
    expect(resolveStradaHomeEntry("skills")).toBe(join(appHome, "skills"));
    expect(warn).not.toHaveBeenCalled();
  });

  it("says nothing when the app home is ~/.strada itself", () => {
    vi.stubEnv("STRADA_HOME", join(home, ".strada"));
    mkdirSync(join(home, ".strada", "skills"), { recursive: true });
    expect(resolveStradaHomeEntry("skills")).toBe(join(home, ".strada", "skills"));
    expect(warn).not.toHaveBeenCalled();
  });

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "hands back a ~/.strada entry it cannot inspect, so the caller's own read fails closed",
    () => {
      // Taking the empty app home instead would read "no skills.json" and turn
      // every skill the user disabled back on (SEC-15).
      const legacyDir = join(home, ".strada");
      mkdirSync(legacyDir);
      writeFileSync(join(legacyDir, "skills.json"), "{}");
      chmodSync(legacyDir, 0o000);
      try {
        expect(resolveStradaHomeEntry("skills.json")).toBe(join(legacyDir, "skills.json"));
      } finally {
        chmodSync(legacyDir, 0o700);
      }
    },
  );
});
