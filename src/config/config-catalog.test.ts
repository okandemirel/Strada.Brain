import { describe, it, expect } from "vitest";
import {
  describeConfigEntry,
  buildConfigCatalogEntries,
  summarizeConfigCatalog,
} from "./config-catalog.js";

// ---------------------------------------------------------------------------
// describeConfigEntry
// ---------------------------------------------------------------------------

describe("describeConfigEntry", () => {
  it("returns category Core and tier core for exact key unityProjectPath", () => {
    const result = describeConfigEntry("unityProjectPath");
    expect(result.category).toBe("Core");
    expect(result.tier).toBe("core");
  });

  it("returns category Security and tier core for exact key security.readOnlyMode", () => {
    const result = describeConfigEntry("security.readOnlyMode");
    expect(result.category).toBe("Security");
    expect(result.tier).toBe("core");
  });

  it("returns category Security and tier core for exact key security.requireEditConfirmation", () => {
    const result = describeConfigEntry("security.requireEditConfirmation");
    expect(result.category).toBe("Security");
    expect(result.tier).toBe("core");
  });

  it("returns category Operations and tier advanced for exact key logLevel", () => {
    const result = describeConfigEntry("logLevel");
    expect(result.category).toBe("Operations");
    expect(result.tier).toBe("advanced");
  });

  it("returns category Operations and tier advanced for exact key logFile", () => {
    const result = describeConfigEntry("logFile");
    expect(result.category).toBe("Operations");
    expect(result.tier).toBe("advanced");
  });

  it("returns category Channels and tier experimental for prefix key telegram.botToken", () => {
    const result = describeConfigEntry("telegram.botToken");
    expect(result.category).toBe("Channels");
    expect(result.tier).toBe("experimental");
  });

  it("returns category Knowledge and tier advanced for prefix key memory.dbPath", () => {
    const result = describeConfigEntry("memory.dbPath");
    expect(result.category).toBe("Knowledge");
    expect(result.tier).toBe("advanced");
  });

  it("returns category Multi-Agent and tier experimental for prefix key agent.maxConcurrent", () => {
    const result = describeConfigEntry("agent.maxConcurrent");
    expect(result.category).toBe("Multi-Agent");
    expect(result.tier).toBe("experimental");
  });

  it("returns category Multi-Agent and tier experimental for prefix key delegation.maxDepth", () => {
    const result = describeConfigEntry("delegation.maxDepth");
    expect(result.category).toBe("Multi-Agent");
    expect(result.tier).toBe("experimental");
  });

  it("returns category System and tier advanced for unknown key someUnknownKey", () => {
    const result = describeConfigEntry("someUnknownKey");
    expect(result.category).toBe("System");
    expect(result.tier).toBe("advanced");
  });

  it("returns category System and tier advanced for unknown key xyz.randomField", () => {
    const result = describeConfigEntry("xyz.randomField");
    expect(result.category).toBe("System");
    expect(result.tier).toBe("advanced");
  });

  // Exact rule takes priority over prefix rule —
  // dashboard.enabled is EXACT (core) even though dashboard. prefix maps to advanced.
  it("dashboard.enabled exact rule wins over dashboard. prefix rule — tier is core not advanced", () => {
    const result = describeConfigEntry("dashboard.enabled");
    expect(result.tier).toBe("core");
    expect(result.category).toBe("Core");
  });

  // dashboard.port has no exact rule, so it falls through to the prefix rule.
  it("dashboard.port falls through to prefix rule — tier is advanced and category Operations", () => {
    const result = describeConfigEntry("dashboard.port");
    expect(result.tier).toBe("advanced");
    expect(result.category).toBe("Operations");
  });

  // Other exact core keys
  it("returns tier core for exact key providerChain", () => {
    expect(describeConfigEntry("providerChain").tier).toBe("core");
  });

  it("returns tier core for exact key language", () => {
    expect(describeConfigEntry("language").tier).toBe("core");
  });

  it("returns tier core for exact key streamingEnabled", () => {
    expect(describeConfigEntry("streamingEnabled").tier).toBe("core");
  });

  it("returns tier core for exact key shellEnabled", () => {
    expect(describeConfigEntry("shellEnabled").tier).toBe("core");
  });

  it("returns category Core and tier core for exact key web.port", () => {
    const result = describeConfigEntry("web.port");
    expect(result.category).toBe("Core");
    expect(result.tier).toBe("core");
  });

  // Other prefix rules
  it("returns category Channels and tier experimental for discord.guildId", () => {
    const result = describeConfigEntry("discord.guildId");
    expect(result.category).toBe("Channels");
    expect(result.tier).toBe("experimental");
  });

  it("returns category Multi-Agent and tier experimental for deployment.target", () => {
    const result = describeConfigEntry("deployment.target");
    expect(result.category).toBe("Deployment");
    expect(result.tier).toBe("experimental");
  });

  it("returns category Knowledge and tier advanced for rag.chunkSize", () => {
    const result = describeConfigEntry("rag.chunkSize");
    expect(result.category).toBe("Knowledge");
    expect(result.tier).toBe("advanced");
  });
});

// ---------------------------------------------------------------------------
// buildConfigCatalogEntries
// ---------------------------------------------------------------------------

describe("buildConfigCatalogEntries", () => {
  it("returns empty array for empty config", () => {
    expect(buildConfigCatalogEntries({})).toEqual([]);
  });

  it("returns entries with correct tier and category for known keys", () => {
    const config = {
      unityProjectPath: "/path/to/unity",
      logLevel: "info",
    };

    const entries = buildConfigCatalogEntries(config);
    expect(entries).toHaveLength(2);

    const unityEntry = entries.find((e) => e.key === "unityProjectPath");
    expect(unityEntry).toBeDefined();
    expect(unityEntry!.category).toBe("Core");
    expect(unityEntry!.tier).toBe("core");

    const logEntry = entries.find((e) => e.key === "logLevel");
    expect(logEntry).toBeDefined();
    expect(logEntry!.category).toBe("Operations");
    expect(logEntry!.tier).toBe("advanced");
  });

  it("returns tier advanced and category System for unknown key", () => {
    const config = { unknownSetting: "value" };
    const entries = buildConfigCatalogEntries(config);

    expect(entries).toHaveLength(1);
    expect(entries[0]!.tier).toBe("advanced");
    expect(entries[0]!.category).toBe("System");
  });

  it("preserves the value as-is for string", () => {
    const entries = buildConfigCatalogEntries({ logLevel: "debug" });
    expect(entries[0]!.value).toBe("debug");
  });

  it("preserves the value as-is for boolean", () => {
    const entries = buildConfigCatalogEntries({ streamingEnabled: false });
    expect(entries[0]!.value).toBe(false);
  });

  it("preserves the value as-is for object", () => {
    const obj = { nested: { a: 1 } };
    const entries = buildConfigCatalogEntries({ someObj: obj });
    expect(entries[0]!.value).toBe(obj);
  });

  it("preserves the value as-is for null", () => {
    const entries = buildConfigCatalogEntries({ nullKey: null });
    expect(entries[0]!.value).toBeNull();
  });

  it("preserves the value as-is for number", () => {
    const entries = buildConfigCatalogEntries({ "web.port": 3000 });
    expect(entries[0]!.value).toBe(3000);
  });

  it("sorts entries alphabetically by key", () => {
    const config = {
      zebra: "z",
      apple: "a",
      mango: "m",
    };
    const entries = buildConfigCatalogEntries(config);
    const keys = entries.map((e) => e.key);
    expect(keys).toEqual(["apple", "mango", "zebra"]);
  });

  it("sorts entries correctly when keys have dotted paths mixed with plain keys", () => {
    const config = {
      "telegram.botToken": "tok",
      logLevel: "info",
      "agent.maxConcurrent": 4,
    };
    const entries = buildConfigCatalogEntries(config);
    const keys = entries.map((e) => e.key);
    // localeCompare ordering: 'agent.maxConcurrent' < 'logLevel' < 'telegram.botToken'
    expect(keys).toEqual(["agent.maxConcurrent", "logLevel", "telegram.botToken"]);
  });

  it("each entry includes key, value, category, tier, and description fields", () => {
    const entries = buildConfigCatalogEntries({ language: "en" });
    const entry = entries[0]!;
    expect(entry).toHaveProperty("key", "language");
    expect(entry).toHaveProperty("value", "en");
    expect(entry).toHaveProperty("category");
    expect(entry).toHaveProperty("tier");
    expect(entry).toHaveProperty("description");
  });

  it("prefix rule experimental applies correctly inside buildConfigCatalogEntries", () => {
    const entries = buildConfigCatalogEntries({ "telegram.chatId": "123" });
    expect(entries[0]!.tier).toBe("experimental");
    expect(entries[0]!.category).toBe("Channels");
  });

  it("exact rule takes priority over prefix inside buildConfigCatalogEntries — dashboard.enabled is core", () => {
    const entries = buildConfigCatalogEntries({ "dashboard.enabled": true });
    expect(entries[0]!.tier).toBe("core");
  });
});

// ---------------------------------------------------------------------------
// summarizeConfigCatalog
// ---------------------------------------------------------------------------

describe("summarizeConfigCatalog", () => {
  it("returns all-zero summary for empty array", () => {
    expect(summarizeConfigCatalog([])).toEqual({ core: 0, advanced: 0, experimental: 0 });
  });

  it("counts a single core entry correctly", () => {
    const entries = buildConfigCatalogEntries({ unityProjectPath: "/path" });
    expect(summarizeConfigCatalog(entries)).toEqual({ core: 1, advanced: 0, experimental: 0 });
  });

  it("counts a single advanced entry correctly", () => {
    const entries = buildConfigCatalogEntries({ logLevel: "info" });
    expect(summarizeConfigCatalog(entries)).toEqual({ core: 0, advanced: 1, experimental: 0 });
  });

  it("counts a single experimental entry correctly", () => {
    const entries = buildConfigCatalogEntries({ "telegram.botToken": "tok" });
    expect(summarizeConfigCatalog(entries)).toEqual({ core: 0, advanced: 0, experimental: 1 });
  });

  it("counts mixed entries correctly", () => {
    const config = {
      unityProjectPath: "/path",       // core
      language: "en",                  // core
      logLevel: "info",                // advanced
      "memory.dbPath": "./db",         // advanced
      someUnknown: "x",               // advanced (default)
      "telegram.botToken": "tok",      // experimental
      "agent.maxConcurrent": 4,        // experimental
    };
    const entries = buildConfigCatalogEntries(config);
    const summary = summarizeConfigCatalog(entries);
    expect(summary).toEqual({ core: 2, advanced: 3, experimental: 2 });
  });

  it("summary counts sum to total number of config keys (round-trip)", () => {
    const config = {
      unityProjectPath: "/path",
      providerChain: ["openai"],
      logLevel: "debug",
      "memory.dbPath": "./db",
      unknownKey: "value",
      "telegram.token": "tok",
      "discord.guildId": "guild",
      "agent.pool": 2,
    };
    const entries = buildConfigCatalogEntries(config);
    const summary = summarizeConfigCatalog(entries);
    const total = summary.core + summary.advanced + summary.experimental;
    expect(total).toBe(Object.keys(config).length);
  });

  it("summary counts sum to total for a larger config", () => {
    const config: Record<string, unknown> = {};
    for (let i = 0; i < 5; i++) config[`core${i}`] = i; // unknown → advanced
    const entries = buildConfigCatalogEntries(config);
    const summary = summarizeConfigCatalog(entries);
    expect(summary.core + summary.advanced + summary.experimental).toBe(5);
  });

  it("all-core config yields zero advanced and experimental", () => {
    const config = {
      unityProjectPath: "/p",
      providerChain: [],
      language: "en",
      streamingEnabled: true,
      shellEnabled: false,
    };
    const entries = buildConfigCatalogEntries(config);
    const summary = summarizeConfigCatalog(entries);
    expect(summary.advanced).toBe(0);
    expect(summary.experimental).toBe(0);
    expect(summary.core).toBe(5);
  });
});
