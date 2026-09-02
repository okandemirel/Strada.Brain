import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import os from 'node:os';
import { StradaConformanceGuard } from './strada-conformance.js';

/**
 * A reference that resolves to nothing.
 *
 * Measured 2026-08-22: RenderingModuleConfig.asset carried
 * `_prefabs: {guid: 6813063e...}` and no asset in the project had that guid —
 * the prefab config it was supposed to point at had a different one. The C#
 * hides it:
 *
 *   public PresentationPrefabsConfig Prefabs =>
 *       _prefabs != null ? _prefabs : ScriptableObject.CreateInstance<...>();
 *
 * so the null becomes an empty config, the spawner gets no prefabs, and nothing
 * is logged. Forty-four of forty-four tests passed over a game that drew an
 * empty sky.
 *
 * Unity's own built-in guids (the all-zero forms) and anything a package owns
 * are not dangling; a check that flagged those would be noise and would train
 * the agent to ignore it.
 */

const deps = {
  coreInstalled: true, corePath: '/core',
  modulesInstalled: true, modulesPath: '/modules',
  mcpInstalled: true, mcpPath: '/mcp', mcpVersion: '1.0.0',
  warnings: [],
} as const;

function project(refGuid: string, realGuid: string): { root: string; configPath: string } {
  const root = mkdtempSync(join(os.tmpdir(), 'dangling-'));
  const moduleRoot = join(root, 'Assets', 'Modules', 'RenderingModule');
  const scripts = join(moduleRoot, 'Scripts');
  mkdirSync(scripts, { recursive: true });

  const configPath = join(scripts, 'RenderingModuleConfig.cs');
  writeFileSync(configPath, 'public class RenderingModuleConfig : ModuleConfig {}');
  writeFileSync(join(scripts, 'Game.Modules.Rendering.asmdef'), '{"name":"Game.Modules.Rendering"}');
  const tests = join(moduleRoot, 'Tests', 'Runtime');
  mkdirSync(tests, { recursive: true });
  writeFileSync(join(tests, 'Game.Modules.Rendering.Tests.asmdef'), '{"name":"Game.Modules.Rendering.Tests"}');
  writeFileSync(join(tests, 'T.cs'), '[Test] public void It() {}');

  // The module config asset, pointing at whatever the caller says.
  writeFileSync(
    join(moduleRoot, 'RenderingModuleConfig.asset'),
    `%YAML 1.1\n  _prefabs: {fileID: 11400000, guid: ${refGuid}, type: 2}\n  _builtin: {fileID: 0, guid: 0000000000000000f000000000000000, type: 0}\n`,
  );
  // The asset that actually exists, with its own guid.
  writeFileSync(join(moduleRoot, 'PresentationPrefabs.asset'), '%YAML 1.1\n');
  writeFileSync(join(moduleRoot, 'PresentationPrefabs.asset.meta'), `fileFormatVersion: 2\nguid: ${realGuid}\n`);

  const scenes = join(root, 'Assets', 'Scenes');
  mkdirSync(scenes, { recursive: true });
  writeFileSync(join(scenes, 'Main.unity'), '  _gameConfig: {fileID: 11400000, guid: abc}');
  return { root, configPath };
}

const promptFor = (root: string, configPath: string): string =>
  {
    const guard = new StradaConformanceGuard(deps, { projectPath: root, enabled: true });
    guard.trackToolCall('file_write', { path: configPath }, false);
    return guard.getPrompt() ?? '';
  };

const REAL = 'a3f1c9d84e2b47e6b0d5c8a1976f3210';
const MISSING = '6813063e5baa844d7a169fbe5f43269c';

/**
 * An imported asset pack: `count` textures, each with its .meta, under a
 * folder that sorts AFTER Modules/ — walkFiles pops directories LIFO, so this
 * subtree is walked first and eats an unfiltered budget before the module's
 * own .meta files are ever read.
 */
function importedPack(root: string, count: number): void {
  const textures = join(root, 'Assets', 'ZZThirdParty', 'PolygonPack', 'Textures');
  mkdirSync(textures, { recursive: true });
  for (let i = 0; i < count; i++) {
    writeFileSync(join(textures, `tex_${i}.png`), 'png');
    writeFileSync(join(textures, `tex_${i}.png.meta`), `fileFormatVersion: 2\nguid: ${i.toString(16).padStart(32, '0')}\n`);
  }
}

describe('an asset reference that points at nothing', () => {
  it('objects when a config references a guid no asset has', () => {
    const { root, configPath } = project(MISSING, REAL);

    const prompt = promptFor(root, configPath);

    expect(prompt).toContain('[STRADA REFERENCE DANGLING]');
    expect(prompt).toContain('RenderingModuleConfig');
    expect(prompt).toContain(MISSING.slice(0, 8));
  });

  it('stays quiet when the reference resolves', () => {
    const { root, configPath } = project(REAL, REAL);

    expect(promptFor(root, configPath)).not.toContain('[STRADA REFERENCE DANGLING]');
  });

  it("ignores Unity's built-in guids", () => {
    // Every prefab in a real project carries these; flagging them would be
    // noise and would teach the agent to skip the rule.
    const { root, configPath } = project(REAL, REAL);

    expect(promptFor(root, configPath)).not.toContain('0000000000000000f');
  });

  it('is not fooled by an imported asset pack larger than the walk budget', () => {
    // Audited 2026-09-02: the guid census walked Assets/ with the default
    // 4000-file budget and NO match filter, so the first ~2000 assets of any
    // kind (each with a .meta) filled it and every later .meta was never read.
    // A perfectly valid reference was then accused of dangling — an unbudgeted,
    // unclearable gate that hid every real gate behind it.
    const { root, configPath } = project(REAL, REAL);
    importedPack(root, 3000);

    expect(promptFor(root, configPath)).not.toContain('[STRADA REFERENCE DANGLING]');
  });

  it('says what the dangling reference costs', () => {
    const { root, configPath } = project(MISSING, REAL);

    expect(promptFor(root, configPath).toLowerCase()).toMatch(/null|nothing|silently|empty/u);
  });
});
