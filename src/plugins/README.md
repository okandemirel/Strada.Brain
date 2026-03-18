# src/plugins/

Two distinct plugin mechanisms serve different purposes.

## Core Plugin Registry (`registry.ts`)

A capabilities/lifecycle registry for first-class internal plugins.

- `Map<string, Plugin>` stores plugins by name
- Initialization uses **topological sort** (DFS with cycle detection) to order plugins by dependency
- `disposeAll()` reverses the sorted order so dependents shut down before their dependencies
- `unregister()` prevents removing a plugin while others depend on it
- Concurrent `initializeAll()` calls are coalesced into a single run

**Security note:** Plugins run with full Node.js process access today. Treat `PLUGIN_DIRS` as trusted code inputs, not as a sandbox boundary.

## Hot Reload (`hot-reload.ts`)

Uses `chokidar` to watch `**/*.js` files in configured directories.

- 1000ms debounce per file path
- On change: deletes `require.cache[absolutePath]`
- **Limitation:** Only works for CommonJS. ESM modules are permanently cached in V8 — file changes require a process restart.
- No automatic integration with `PluginLoader.reloadAll()` — callers must wire the `onReload` callback.

## External Tool Plugins (`../agents/plugins/plugin-loader.ts`)

Dynamic loading of external tools from directories specified in `PLUGIN_DIRS` env var.

### Plugin Structure

```
plugins/my-plugin/
  plugin.json    # { name, version, description, entry }
  index.js       # exports { tools: ITool[] } or default ITool[]
```

### Loading Flow

1. Scan all directories in `PLUGIN_DIRS`
2. Read `plugin.json` manifest, validate required fields
3. Path traversal check: `relative(pluginPath, entryPath)` must stay inside the plugin directory
4. Dynamic `import(entryPath)`
5. Validate each exported tool has the `ITool` interface

### Namespacing

Tools are namespaced: `plugin_${manifest.name}_${tool.name}`. All tools get `isPlugin: true`.

## Key Files

| File | Purpose |
|------|---------|
| `registry.ts` | Core plugin registry with topological sort |
| `hot-reload.ts` | Chokidar file watcher with CJS cache invalidation |
| `../agents/plugins/plugin-loader.ts` | External tool plugin discovery and loading |
