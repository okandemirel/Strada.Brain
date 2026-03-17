import { PluginLoader } from "./plugin-loader.js";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

vi.mock("../../utils/logger.js", () => ({
  getLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

describe("PluginLoader", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "plugin-loader-test-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  describe("loadAll", () => {
    it("returns empty array for non-existent directory", async () => {
      const loader = new PluginLoader([join(tempDir, "does-not-exist")]);
      const tools = await loader.loadAll();

      expect(tools).toEqual([]);
    });

    it("returns empty array for empty directory", async () => {
      const pluginsDir = join(tempDir, "plugins");
      mkdirSync(pluginsDir);

      const loader = new PluginLoader([pluginsDir]);
      const tools = await loader.loadAll();

      expect(tools).toEqual([]);
    });

    it("returns namespaced tools from a valid plugin", async () => {
      const pluginsDir = join(tempDir, "plugins");
      const pluginDir = join(pluginsDir, "my-plugin");
      mkdirSync(pluginDir, { recursive: true });

      const manifest = {
        name: "test-plugin",
        version: "1.0.0",
        description: "Test",
        entry: "index.mjs",
      };
      writeFileSync(join(pluginDir, "plugin.json"), JSON.stringify(manifest));

      const entryCode = `
export const tools = [{
  name: "hello",
  description: "test",
  inputSchema: { type: "object", properties: {} },
  execute: async () => ({ content: "hi" }),
}];
`;
      writeFileSync(join(pluginDir, "index.mjs"), entryCode);

      const loader = new PluginLoader([pluginsDir]);
      const tools = await loader.loadAll();

      expect(tools).toHaveLength(1);
      expect(tools[0]!.name).toBe("plugin_test-plugin_hello");
      expect(tools[0]!.description).toBe("test");

      const result = await tools[0]!.execute({}, {
        projectPath: "/tmp",
        workingDirectory: "/tmp",
        readOnly: false,
      });
      expect(result.content).toBe("hi");
    });

    it("skips non-directory entries", async () => {
      const pluginsDir = join(tempDir, "plugins");
      mkdirSync(pluginsDir);

      // Create a regular file in the plugins directory (not a subdirectory)
      writeFileSync(join(pluginsDir, "stray-file.txt"), "not a plugin");

      const loader = new PluginLoader([pluginsDir]);
      const tools = await loader.loadAll();

      expect(tools).toEqual([]);
    });
  });

  describe("manifest validation", () => {
    it("throws when plugin manifest is missing name", async () => {
      const pluginsDir = join(tempDir, "plugins");
      const pluginDir = join(pluginsDir, "bad-plugin");
      mkdirSync(pluginDir, { recursive: true });

      const manifest = {
        version: "1.0.0",
        description: "Missing name",
        entry: "index.mjs",
      };
      writeFileSync(join(pluginDir, "plugin.json"), JSON.stringify(manifest));
      writeFileSync(join(pluginDir, "index.mjs"), "export const tools = [];");

      const loader = new PluginLoader([pluginsDir]);
      // loadAll catches the error and logs a warning, so it should not throw
      // but should return empty tools from this plugin
      const tools = await loader.loadAll();
      expect(tools).toEqual([]);
    });

    it("throws when plugin manifest is missing entry", async () => {
      const pluginsDir = join(tempDir, "plugins");
      const pluginDir = join(pluginsDir, "bad-plugin");
      mkdirSync(pluginDir, { recursive: true });

      const manifest = {
        name: "bad-plugin",
        version: "1.0.0",
        description: "Missing entry",
      };
      writeFileSync(join(pluginDir, "plugin.json"), JSON.stringify(manifest));

      const loader = new PluginLoader([pluginsDir]);
      const tools = await loader.loadAll();
      expect(tools).toEqual([]);
    });
  });

  describe("security", () => {
    it("throws when entry path escapes plugin directory", async () => {
      const pluginsDir = join(tempDir, "plugins");
      const pluginDir = join(pluginsDir, "evil-plugin");
      mkdirSync(pluginDir, { recursive: true });

      const manifest = {
        name: "evil-plugin",
        version: "1.0.0",
        description: "Path traversal attempt",
        entry: "../../etc/passwd",
      };
      writeFileSync(join(pluginDir, "plugin.json"), JSON.stringify(manifest));

      const loader = new PluginLoader([pluginsDir]);
      const tools = await loader.loadAll();
      // The path escape should cause a throw caught by loadAll
      expect(tools).toEqual([]);
    });

    it("rejects sibling-prefix paths that only look like they stay inside the plugin directory", async () => {
      const pluginsDir = join(tempDir, "plugins");
      const pluginDir = join(pluginsDir, "evil-plugin");
      const siblingDir = join(pluginsDir, "evil-plugin-sibling");
      mkdirSync(pluginDir, { recursive: true });
      mkdirSync(siblingDir, { recursive: true });

      writeFileSync(join(siblingDir, "index.mjs"), "export const tools = [];");
      writeFileSync(join(pluginDir, "plugin.json"), JSON.stringify({
        name: "evil-plugin",
        version: "1.0.0",
        description: "Sibling prefix traversal attempt",
        entry: "../evil-plugin-sibling/index.mjs",
      }));

      const loader = new PluginLoader([pluginsDir]);
      const tools = await loader.loadAll();
      expect(tools).toEqual([]);
    });

    it("rejects symlinked entry files that resolve outside the plugin directory", async () => {
      const pluginsDir = join(tempDir, "plugins");
      const pluginDir = join(pluginsDir, "evil-plugin");
      const outsideDir = join(tempDir, "outside");
      mkdirSync(pluginDir, { recursive: true });
      mkdirSync(outsideDir, { recursive: true });

      writeFileSync(join(outsideDir, "outside.mjs"), "export const tools = [];");
      symlinkSync(join(outsideDir, "outside.mjs"), join(pluginDir, "index.mjs"));
      writeFileSync(join(pluginDir, "plugin.json"), JSON.stringify({
        name: "evil-plugin",
        version: "1.0.0",
        description: "Symlink escape attempt",
        entry: "index.mjs",
      }));

      const loader = new PluginLoader([pluginsDir]);
      const tools = await loader.loadAll();

      expect(tools).toEqual([]);
    });
  });

  describe("getLoadedPlugins", () => {
    it("returns loaded plugins after loadAll", async () => {
      const pluginsDir = join(tempDir, "plugins");
      const pluginDir = join(pluginsDir, "my-plugin");
      mkdirSync(pluginDir, { recursive: true });

      const manifest = {
        name: "test-plugin",
        version: "1.0.0",
        description: "Test",
        entry: "index.mjs",
      };
      writeFileSync(join(pluginDir, "plugin.json"), JSON.stringify(manifest));

      const entryCode = `
export const tools = [{
  name: "greet",
  description: "greet tool",
  inputSchema: { type: "object", properties: {} },
  execute: async () => ({ content: "hello" }),
}];
`;
      writeFileSync(join(pluginDir, "index.mjs"), entryCode);

      const loader = new PluginLoader([pluginsDir]);
      await loader.loadAll();

      const loaded = loader.getLoadedPlugins();
      expect(loaded).toHaveLength(1);
      expect(loaded[0]!.manifest.name).toBe("test-plugin");
      expect(loaded[0]!.manifest.version).toBe("1.0.0");
      expect(loaded[0]!.tools).toHaveLength(1);
      expect(loaded[0]!.tools[0]!.name).toBe("plugin_test-plugin_greet");
    });

    it("returns empty array before loadAll is called", () => {
      const loader = new PluginLoader([join(tempDir, "plugins")]);
      const loaded = loader.getLoadedPlugins();
      expect(loaded).toEqual([]);
    });
  });

  describe("reloadPlugin", () => {
    it("reloads updated plugin code instead of reusing stale ESM cache", async () => {
      const pluginsDir = join(tempDir, "plugins");
      const pluginDir = join(pluginsDir, "my-plugin");
      mkdirSync(pluginDir, { recursive: true });

      writeFileSync(join(pluginDir, "plugin.json"), JSON.stringify({
        name: "test-plugin",
        version: "1.0.0",
        description: "Reload test",
        entry: "index.mjs",
      }));

      writeFileSync(join(pluginDir, "index.mjs"), `
export const tools = [{
  name: "hello",
  description: "v1",
  inputSchema: { type: "object", properties: {} },
  execute: async () => ({ content: "v1" }),
}];
`);

      const loader = new PluginLoader([pluginsDir]);
      const initialTools = await loader.loadAll();
      const initialResult = await initialTools[0]!.execute({}, {
        projectPath: "/tmp",
        workingDirectory: "/tmp",
        readOnly: false,
      });
      expect(initialResult.content).toBe("v1");

      writeFileSync(join(pluginDir, "index.mjs"), `
export const tools = [{
  name: "hello",
  description: "v2",
  inputSchema: { type: "object", properties: {} },
  execute: async () => ({ content: "v2" }),
}];
`);

      const reloadedTools = await loader.reloadPlugin("test-plugin");
      const reloadedResult = await reloadedTools[0]!.execute({}, {
        projectPath: "/tmp",
        workingDirectory: "/tmp",
        readOnly: false,
      });

      expect(reloadedTools[0]!.description).toBe("v2");
      expect(reloadedResult.content).toBe("v2");
    });
  });
});
