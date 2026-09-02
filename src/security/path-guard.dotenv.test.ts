import { describe, expect, it } from "vitest";
import { isSensitivePath } from "./path-guard.js";

/**
 * The blocklist must cover BOTH dotenv families without swallowing project
 * files. A rejected round-2 attempt anchored on the basename start, which
 * unblocked prod.env / secrets.env / config/local.env (audited 2026-09-02).
 */
describe("dotenv blocklist", () => {
  const blocked = [".env", ".env.local", ".env.production.local", ".env.bak.191546", "config/.env", "prod.env", "secrets.env", "staging.env", "config/local.env"];
  const allowed = ["Game.Env.Settings.cs", "Forest.Env.prefab.meta", "Assets/Modules/Env/EnvController.cs", ".envrc", "skybox.environment"];

  it("blocks every real dotenv name", () => {
    for (const p of blocked) expect(isSensitivePath(p), p).toBe(true);
  });

  it("allows project files that merely contain env", () => {
    for (const p of allowed) expect(isSensitivePath(p), p).toBe(false);
  });
});
