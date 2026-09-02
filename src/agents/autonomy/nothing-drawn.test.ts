import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import os from 'node:os';
import { StradaConformanceGuard } from './strada-conformance.js';

/**
 * A game nobody has seen draw anything is not delivered.
 *
 * Measured across this whole session: 120 captured frames, every one byte-for-byte
 * identical, all of them empty sky — while the suite went from 33 tests to 54 and
 * reported green each time. Runs reported success on a project that has never been
 * observed to render, and the only reason anyone knew otherwise was that a person
 * opened a PNG and looked at it.
 *
 * Tests prove the simulation. Only a frame proves the game.
 */

const deps = {
  coreInstalled: true, corePath: '/core',
  modulesInstalled: true, modulesPath: '/modules',
  mcpInstalled: true, mcpPath: '/mcp', mcpVersion: '1.0.0',
  warnings: [],
} as const;

function project(frames: string[], renderers = 0): { root: string; configPath: string } {
  const root = mkdtempSync(join(os.tmpdir(), 'nothing-drawn-'));
  const moduleRoot = join(root, 'Assets', 'Modules', 'BoardModule');
  const scripts = join(moduleRoot, 'Scripts');
  mkdirSync(scripts, { recursive: true });
  const configPath = join(scripts, 'BoardModuleConfig.cs');
  writeFileSync(configPath, 'public class BoardModuleConfig : ModuleConfig {}');
  writeFileSync(join(scripts, 'Game.Modules.Board.asmdef'), '{"name":"Game.Modules.Board"}');
  writeFileSync(join(moduleRoot, 'BoardModuleConfig.asset'), '%YAML 1.1');
  const tests = join(moduleRoot, 'Tests', 'Runtime');
  mkdirSync(tests, { recursive: true });
  writeFileSync(join(tests, 'Game.Modules.Board.Tests.asmdef'), '{"name":"Game.Modules.Board.Tests"}');
  writeFileSync(join(tests, 'T.cs'), '[Test] public void It() {}');
  const scenes = join(root, 'Assets', 'Scenes');
  mkdirSync(scenes, { recursive: true });
  writeFileSync(join(scenes, 'Main.unity'), '  _gameConfig: {fileID: 11400000, guid: abc}');

  // Art in the project, because [STRADA ASSETS UNSOURCED] speaks before this
  // gate does — deliberately, since "there is nothing in it to draw" is the
  // cause and "the frames are identical" is the symptom. A fixture with no art
  // at all would test the cause gate while claiming to test this one.
  const art = join(root, 'Assets', 'Art');
  mkdirSync(art, { recursive: true });
  writeFileSync(join(art, 'tile.png'), 'pixels');

  if (frames.length > 0) {
    const rec = join(root, 'Recordings');
    mkdirSync(rec, { recursive: true });
    frames.forEach((content, i) => {
      writeFileSync(join(rec, `frame_${String(i).padStart(5, '0')}.png`), content);
    });
  }
  if (renderers > 0) {
    let body = '';
    for (let i = 0; i < renderers; i++) {
      body += `--- !u!1 &${i + 10}\nGameObject:\n  m_Name: Cube${i}\n`;
      body += `--- !u!212 &${i + 500}\nMeshRenderer:\n  m_GameObject: {fileID: ${i + 10}}\n`;
    }
    writeFileSync(join(scenes, 'Main.unity'), body);
  }
  return { root, configPath };
}

const promptFor = (root: string, configPath: string): string => {
  const guard = new StradaConformanceGuard(deps, { projectPath: root, enabled: true });
  guard.trackToolCall('file_write', { path: configPath }, false);
  // A game nobody has run yet has its own gate; this one only speaks after
  // someone has tried to make a picture.
  guard.trackToolCall('unity_playmode_verify', {}, false);
  return guard.getPrompt() ?? '';
};

describe('a game that has never been seen to draw', () => {
  it('objects when every captured frame is identical', () => {
    const { root, configPath } = project(Array.from({ length: 12 }, () => 'same-pixels'));

    const prompt = promptFor(root, configPath);

    expect(prompt).toContain('[STRADA NOTHING DRAWN]');
    expect(prompt).toContain('identical');
  });

  it('objects when no frame was ever captured', () => {
    const { root, configPath } = project([]);

    expect(promptFor(root, configPath)).toContain('[STRADA NOTHING DRAWN]');
  });

  it('objects when frame variety is HUD-level (below the distinctiveness bar)', () => {
    // Measured 2026-08-24 (PixelFlow): sixty frames, only 8 distinct (13%) —
    // the variety was the progress bar filling over an empty sky. The gate
    // requires >= 25% distinct digests as evidence of real drawing.
    const frames = [...Array(10).fill('same-pixels'), 'progress-bar-moved'];
    const { root, configPath } = project(frames);

    const prompt = promptFor(root, configPath);
    expect(prompt).toContain('[STRADA NOTHING DRAWN]');
    expect(prompt).toContain('vary too little');
  });

  it('stays quiet when frames differ substantively from a sparse scene', () => {
    // Runtime-construction architecture: scene YAML stays minimal, the
    // playfield spawns from code — substantive frame variety is the evidence.
    const { root, configPath } = project(['a', 'b', 'c', 'd'], 0);

    expect(promptFor(root, configPath)).not.toContain('[STRADA NOTHING DRAWN]');
  });

  it('names the tool and the option that produce a capture', () => {
    const { root, configPath } = project([]);
    const prompt = promptFor(root, configPath);

    expect(prompt).toContain('unity_playmode_verify');
    expect(prompt).toContain('captureFrames');
  });

  it('says what a green suite does not prove', () => {
    const { root, configPath } = project(Array.from({ length: 5 }, () => 'same'));

    expect(promptFor(root, configPath).toLowerCase()).toMatch(/test|suite|passing/u);
  });

  it("stays quiet until someone has tried to run the game", () => {
    // Without a play-mode attempt the honest complaint is GAME NEVER RUN, and
    // this gate placed ahead of it shadowed every other rule in the file.
    const { root, configPath } = project([]);
    const guard = new StradaConformanceGuard(deps, { projectPath: root, enabled: true });
    guard.trackToolCall('file_write', { path: configPath }, false);

    expect(guard.getPrompt() ?? '').not.toContain('[STRADA NOTHING DRAWN]');
  });
});

/**
 * What counts as "this sprint made something to look at".
 *
 * Audited 2026-09-02: the gate's entry condition asked only whether COMPILABLE
 * code had been written into Assets/. An art-and-scene sprint — the kind that
 * writes a sprite under Assets/Art and a scene under Assets/Scenes and no C# at
 * all — wrote nothing compilable, so the gate never applied and the run could
 * capture sixty identical frames and still report the sprint delivered.
 */
describe('a sprint that wrote assets rather than code', () => {
  /** Only renderables: a sprite and a scene, no .cs anywhere. */
  function assetOnlyRun(root: string, frames: string[]): StradaConformanceGuard {
    const art = join(root, 'Assets', 'Art');
    const scenes = join(root, 'Assets', 'Scenes');
    mkdirSync(art, { recursive: true });
    mkdirSync(scenes, { recursive: true });
    writeFileSync(join(art, 'tile.png'), 'pixels');
    writeFileSync(join(scenes, 'Main.unity'), '--- !u!1 &1\nGameObject:\n  m_Name: Boot\n');
    if (frames.length > 0) {
      const rec = join(root, 'Recordings');
      mkdirSync(rec, { recursive: true });
      frames.forEach((c, i) => writeFileSync(join(rec, `frame_${i}.png`), c));
    }

    const guard = new StradaConformanceGuard(deps, { projectPath: root, enabled: true });
    // Asked what the user already owns, so [STRADA ASSETS UNSOURCED] — which
    // speaks before this gate — has nothing to say and the drawing gate is the
    // one under test.
    guard.trackToolCall('unity_my_assets_cloud', { query: 'tiles' }, false);
    guard.trackToolCall('file_write', { path: join(art, 'tile.png') }, false);
    guard.trackToolCall('file_write', { path: join(scenes, 'Main.unity') }, false);
    guard.trackToolCall('unity_playmode_verify', { captureFrames: 12 }, false);
    return guard;
  }

  it('is held to the drawing gate for the sprite and scene it wrote', () => {
    const root = mkdtempSync(join(os.tmpdir(), 'asset-only-'));
    const guard = assetOnlyRun(root, Array.from({ length: 12 }, () => 'same-pixels'));

    expect(guard.getPrompt() ?? '').toContain('[STRADA NOTHING DRAWN]');
    expect(guard.unmetDeliveryConditions()).toEqual([
      expect.stringContaining('never been observed to render'),
    ]);
  });

  it('stays quiet for a run that wrote nothing renderable and no game code', () => {
    // A question about the project, or a note written outside Assets/, owes
    // nobody a rendered frame — widening the gate must not turn it on for
    // every run that happens to call play mode.
    const root = mkdtempSync(join(os.tmpdir(), 'no-renderable-'));
    mkdirSync(join(root, 'docs'), { recursive: true });
    const guard = new StradaConformanceGuard(deps, { projectPath: root, enabled: true });
    guard.trackToolCall('file_write', { path: join(root, 'docs', 'notes.md') }, false);
    guard.trackToolCall('file_write', { path: join(root, 'Tools', 'Helper.cs') }, false);
    guard.trackToolCall('unity_playmode_verify', { captureFrames: 12 }, false);

    expect(guard.getPrompt() ?? '').not.toContain('[STRADA NOTHING DRAWN]');
    expect(guard.unmetDeliveryConditions()).toEqual([]);
  });
});

describe('nothingDrawn — differing frames are not proof of drawing', () => {
  it('the scene census counts renderers a playfield needs', async () => {
    const { countSceneRenderersImpl, MIN_PLAYFIELD_RENDERERS } = await import('./strada-conformance.js');
    const root = mkdtempSync(join(os.tmpdir(), 'strada-hudonly-'));
    try {
      const scenes = join(root, 'Assets', 'Scenes');
      mkdirSync(scenes, { recursive: true });
      writeFileSync(join(scenes, 'Main.unity'), '--- !u!1 &1\nGameObject:\n  m_Name: Boot\n');
      const census = countSceneRenderersImpl(root);
      expect(census.renderers).toBe(0);
      expect(census.renderers).toBeLessThan(MIN_PLAYFIELD_RENDERERS);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
