import { describe, expect, it, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { reloadEnvAfterSetup } from "./setup-env-reload.js";
import { shouldEnableDaemonMode } from "./daemon-mode.js";

// Audit 10.1 / 10.6 / D25: the setup handoff reloads .env with dotenv
// override, which overwrites keys the new file names but never deletes a key
// it omits. A stale STRADA_DAEMON_ENABLED=false from the pre-setup process
// therefore survived a reconfiguration back to the default and the daemon
// stayed off. The reload must drop the setup-owned keys first.
describe("reloadEnvAfterSetup (setup handoff)", () => {
  const dirs: string[] = [];
  afterEach(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
  const envFile = (content: string) => {
    const dir = mkdtempSync(join(tmpdir(), "strada-env-reload-"));
    dirs.push(dir);
    const path = join(dir, ".env");
    writeFileSync(path, content);
    return path;
  };

  it("flips shouldEnableDaemonMode back on when the new .env omits the key (default-on)", () => {
    const env: NodeJS.ProcessEnv = { STRADA_DAEMON_ENABLED: "false", UNRELATED: "keep" };
    const path = envFile("UNITY_PROJECT_PATH=/tmp/x\n");
    expect(shouldEnableDaemonMode("web", false, env)).toBe(false);
    reloadEnvAfterSetup({ path, env });
    expect(shouldEnableDaemonMode("web", false, env)).toBe(true);
    expect(env.UNRELATED).toBe("keep");
    expect(env.UNITY_PROJECT_PATH).toBe("/tmp/x");
  });

  it("drops the keys the save removed from the file (COR-14)", () => {
    const env: NodeJS.ProcessEnv = { OPENAI_API_KEY: "sk-removed", KEEP: "yes" };
    reloadEnvAfterSetup({ path: envFile("KIMI_API_KEY=sk-kimi\n"), env, removedKeys: ["OPENAI_API_KEY"] });
    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(env.KIMI_API_KEY).toBe("sk-kimi");
    expect(env.KEEP).toBe("yes");
  });

  it("applies an explicit true written by the wizard over a stale false", () => {
    const env: NodeJS.ProcessEnv = { STRADA_DAEMON_ENABLED: "false" };
    reloadEnvAfterSetup({ path: envFile("STRADA_DAEMON_ENABLED=true\n"), env });
    expect(shouldEnableDaemonMode("web", false, env)).toBe(true);
  });

  it("keeps an explicit opt-out written by the wizard (guard)", () => {
    const env: NodeJS.ProcessEnv = { STRADA_DAEMON_ENABLED: "true" };
    reloadEnvAfterSetup({ path: envFile("STRADA_DAEMON_ENABLED=false\n"), env });
    expect(shouldEnableDaemonMode("web", false, env)).toBe(false);
    // --daemon still forces it on regardless of the file.
    expect(shouldEnableDaemonMode("cli", true, env)).toBe(true);
  });
});
