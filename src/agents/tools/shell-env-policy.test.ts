import { describe, it, expect } from "vitest";
import {
  buildShellEnv,
  parsePassthroughNames,
  SHELL_ENV_ALLOWLIST,
  SHELL_ENV_ALLOWED_PREFIXES,
  PASSTHROUGH_VAR,
} from "./shell-env-policy.js";

/** A realistic parent environment: build vars mixed with every secret the
 *  agent process actually holds. */
const PARENT: NodeJS.ProcessEnv = {
  PATH: "/usr/bin:/bin",
  HOME: "/home/agent",
  LANG: "en_US.UTF-8",
  LC_TIME: "en_GB.UTF-8",
  DOTNET_ROOT: "/usr/share/dotnet",
  HTTPS_PROXY: "http://proxy.internal:8080",

  // Secrets — none of these may reach a model-authored command.
  ANTHROPIC_API_KEY: "sk-ant-secret",
  ANTHROPIC_AUTH_TOKEN: "oat-secret",
  OPENAI_API_KEY: "sk-openai-secret",
  GEMINI_API_KEY: "gem-secret",
  DEEPSEEK_API_KEY: "ds-secret",
  DISCORD_BOT_TOKEN: "discord-secret",
  TELEGRAM_BOT_TOKEN: "tg-secret",
  SLACK_BOT_TOKEN: "xoxb-secret",
  WHATSAPP_SESSION: "wa-secret",
  AWS_SECRET_ACCESS_KEY: "aws-secret",
  DATABASE_URL: "postgres://user:pw@host/db",

  // Code-injection vectors that must stay out even though they look benign.
  NODE_OPTIONS: "--require /tmp/evil.js",
  GIT_ASKPASS: "/tmp/evil.sh",
  GIT_SSH_COMMAND: "ssh -o ProxyCommand=/tmp/evil.sh",
  LD_PRELOAD: "/tmp/evil.so",
};

describe("buildShellEnv — secrets never cross", () => {
  const { env } = buildShellEnv(PARENT);

  it.each([
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "OPENAI_API_KEY",
    "GEMINI_API_KEY",
    "DEEPSEEK_API_KEY",
    "DISCORD_BOT_TOKEN",
    "TELEGRAM_BOT_TOKEN",
    "SLACK_BOT_TOKEN",
    "WHATSAPP_SESSION",
    "AWS_SECRET_ACCESS_KEY",
    "DATABASE_URL",
  ])("withholds %s", (name) => {
    expect(env).not.toHaveProperty(name);
  });

  it("leaks no secret VALUE under any key", () => {
    // Stronger than per-key checks: proves nothing was copied under a
    // different name.
    const serialized = JSON.stringify(env);
    for (const secret of [
      "sk-ant-secret", "oat-secret", "sk-openai-secret", "gem-secret",
      "ds-secret", "discord-secret", "tg-secret", "xoxb-secret",
      "wa-secret", "aws-secret", "pw@host",
    ]) {
      expect(serialized).not.toContain(secret);
    }
  });

  it("reports withheld names so the drop is auditable", () => {
    const { withheld } = buildShellEnv(PARENT);
    expect(withheld).toContain("ANTHROPIC_API_KEY");
    expect(withheld).toContain("DISCORD_BOT_TOKEN");
  });
});

describe("buildShellEnv — code-injection vectors stay out", () => {
  const { env } = buildShellEnv(PARENT);

  it.each(["NODE_OPTIONS", "GIT_ASKPASS", "GIT_SSH_COMMAND", "LD_PRELOAD"])(
    "withholds %s",
    (name) => {
      expect(env).not.toHaveProperty(name);
    },
  );
});

describe("buildShellEnv — builds still work", () => {
  const { env } = buildShellEnv(PARENT);

  it("forwards PATH, HOME and locale", () => {
    expect(env["PATH"]).toBe("/usr/bin:/bin");
    expect(env["HOME"]).toBe("/home/agent");
    expect(env["LANG"]).toBe("en_US.UTF-8");
  });

  it("forwards LC_* by prefix", () => {
    expect(env["LC_TIME"]).toBe("en_GB.UTF-8");
  });

  it("forwards toolchain and proxy vars", () => {
    expect(env["DOTNET_ROOT"]).toBe("/usr/share/dotnet");
    expect(env["HTTPS_PROXY"]).toBe("http://proxy.internal:8080");
  });

  it("always pins FORCE_COLOR=0 for deterministic output", () => {
    expect(env["FORCE_COLOR"]).toBe("0");
    // Even when the parent said otherwise.
    const { env: e2 } = buildShellEnv({ ...PARENT, FORCE_COLOR: "1" });
    expect(e2["FORCE_COLOR"]).toBe("0");
  });
});

describe("buildShellEnv — operator escape hatch", () => {
  it("forwards only the names the operator listed", () => {
    const { env, viaPassthrough } = buildShellEnv({
      ...PARENT,
      MY_REGISTRY_TOKEN: "needed-by-build",
      [PASSTHROUGH_VAR]: "MY_REGISTRY_TOKEN",
    });
    expect(env["MY_REGISTRY_TOKEN"]).toBe("needed-by-build");
    expect(viaPassthrough).toEqual(["MY_REGISTRY_TOKEN"]);
    // Opting one name in must not open the floodgates.
    expect(env).not.toHaveProperty("ANTHROPIC_API_KEY");
  });

  it("never forwards the passthrough variable itself", () => {
    const { env } = buildShellEnv({ ...PARENT, [PASSTHROUGH_VAR]: "FOO" });
    expect(env).not.toHaveProperty(PASSTHROUGH_VAR);
  });

  it("forwards nothing extra when unset", () => {
    const { viaPassthrough } = buildShellEnv(PARENT);
    expect(viaPassthrough).toEqual([]);
  });

  it.each([
    ["", []],
    ["  ", []],
    ["A,B", ["A", "B"]],
    [" A , B ,", ["A", "B"]],
  ])("parses %o", (raw, expected) => {
    expect(parsePassthroughNames(raw)).toEqual(expected);
  });

  it("treats an undefined list as empty", () => {
    expect(parsePassthroughNames(undefined)).toEqual([]);
  });
});

describe("buildShellEnv — policy shape", () => {
  it("is default-deny: an unknown name is dropped", () => {
    const { env } = buildShellEnv({ TOTALLY_NEW_VARIABLE: "x" });
    expect(env).not.toHaveProperty("TOTALLY_NEW_VARIABLE");
  });

  it("skips undefined values instead of forwarding them as 'undefined'", () => {
    const { env } = buildShellEnv({ PATH: undefined });
    expect(env).not.toHaveProperty("PATH");
  });

  it("keeps the allowed-prefix list minimal", () => {
    // A broad prefix silently readmits injection vectors (NODE_* → NODE_OPTIONS,
    // GIT_* → GIT_ASKPASS). If this fails, re-read shell-env-policy.ts before
    // changing the expectation.
    expect(SHELL_ENV_ALLOWED_PREFIXES).toEqual(["LC_"]);
  });

  it("does not allowlist any obviously secret-shaped name", () => {
    const suspicious = [...SHELL_ENV_ALLOWLIST].filter((n) =>
      /(_KEY|_TOKEN|_SECRET|_PASSWORD|PASSWD|CREDENTIAL)$/i.test(n),
    );
    expect(suspicious).toEqual([]);
  });
});
