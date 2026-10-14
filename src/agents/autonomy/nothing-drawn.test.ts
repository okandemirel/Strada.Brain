import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readdirSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import os from 'node:os';
import { StradaConformanceGuard } from './strada-conformance.js';

/**
 * A game nobody has seen draw anything is not delivered.
 *
 * Identical captured frames mean nothing new was drawn, and a growing green
 * suite proves the simulation, not the picture. Tests prove the simulation;
 * only a frame proves the game.
 */

const deps = {
  coreInstalled: true, corePath: '/core',
  modulesInstalled: true, modulesPath: '/modules',
  mcpInstalled: true, mcpPath: '/mcp', mcpVersion: '1.0.0',
  warnings: [],
} as const;

function project(frames: string[], renderers = 0): { root: string; configPath: string } {
  const root = mkdtempSync(join(os.tmpdir(), 'nothing-drawn-'));
  const moduleRoot = join(root, 'Assets', 'Modules', 'ApiaryModule');
  const scripts = join(moduleRoot, 'Scripts');
  mkdirSync(scripts, { recursive: true });
  const configPath = join(scripts, 'ApiaryModuleConfig.cs');
  writeFileSync(configPath, 'public class ApiaryModuleConfig : ModuleConfig {}');
  writeFileSync(join(scripts, 'Game.Modules.Apiary.asmdef'), '{"name":"Game.Modules.Apiary"}');
  writeFileSync(join(moduleRoot, 'ApiaryModuleConfig.asset'), '%YAML 1.1');
  const tests = join(moduleRoot, 'Tests', 'Runtime');
  mkdirSync(tests, { recursive: true });
  writeFileSync(join(tests, 'Game.Modules.Apiary.Tests.asmdef'), '{"name":"Game.Modules.Apiary.Tests"}');
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
      body += `--- !u!1 &${i + 10}\nGameObject:\n  m_Name: Prop${i}\n`;
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

  it('asks for the play the design describes, naming no level structure of its own', () => {
    // This gate is sent to every game, and plenty of games have no levels: an
    // endless kelp-farm tide sandbox runs until the player stops, a two-player
    // tile duel has rounds, a museum walk has neither. An instruction to
    // "start a level" is one such a game cannot carry out, so the ask must
    // defer to the design's own word for its unit of play.
    const { root, configPath } = project(Array.from({ length: 12 }, () => 'same-pixels'));

    const prompt = promptFor(root, configPath);

    expect(prompt).toContain('[STRADA NOTHING DRAWN]');
    expect(prompt).toContain('the play its design describes, whatever the design calls that');
    expect(prompt).not.toMatch(/\blevel\b/i);
  });

  it("finds this run's frames behind thousands of older ones", () => {
    // Recordings/ can hold thousands of frames from earlier runs, with this
    // run's own in a fresh subfolder. A fixed-size sample of the folder used
    // to stop short of them, and the run was told it drew nothing.
    const old = Array.from({ length: 500 }, () => 'stale-pixels');
    const { root, configPath } = project(old);
    const rec = join(root, 'Recordings');
    const past = new Date(Date.now() - 3 * 60 * 60_000);
    for (const f of readdirSync(rec)) utimesSync(join(rec, f), past, past);
    utimesSync(rec, past, past);
    const fresh = join(rec, 'latest-run');
    mkdirSync(fresh);
    for (let i = 0; i < 12; i++) writeFileSync(join(fresh, `frame_${i}.png`), `varied-${i}-${'x'.repeat(i * 7)}`);

    const prompt = promptFor(root, configPath);

    expect(prompt).not.toContain('no frame has been captured in this run');
  });

  it('objects when no frame was ever captured', () => {
    const { root, configPath } = project([]);

    expect(promptFor(root, configPath)).toContain('[STRADA NOTHING DRAWN]');
  });

  it('objects when frame variety is below the distinctiveness bar', () => {
    // Frames in which only a small overlay changes over a static picture vary
    // too little; the gate requires >= 25% distinct digests as evidence of
    // real drawing.
    const frames = [...Array(10).fill('same-pixels'), 'overlay-changed'];
    const { root, configPath } = project(frames);

    const prompt = promptFor(root, configPath);
    expect(prompt).toContain('[STRADA NOTHING DRAWN]');
    expect(prompt).toContain('vary too little');
  });

  it('stays quiet when frames differ substantively from a sparse scene', () => {
    // A scene whose content is built from code at runtime holds few renderers
    // in its YAML, so substantive frame variety is the evidence.
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
 * What counts as "this run made something to look at".
 *
 * An entry condition that asks only whether COMPILABLE code was written into
 * Assets/ misses a run that writes a sprite under Assets/Art and a scene under
 * Assets/Scenes and no C# at all: it wrote nothing compilable, so the gate
 * would never apply and the run could capture identical frames and still
 * report the work delivered.
 */
describe('a run that wrote assets rather than code', () => {
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
  it('the scene census reports zero renderers for a scene that holds only a bootstrapper', async () => {
    const { countSceneRenderersImpl } = await import('./strada-conformance.js');
    const root = mkdtempSync(join(os.tmpdir(), 'strada-census-'));
    try {
      const scenes = join(root, 'Assets', 'Scenes');
      mkdirSync(scenes, { recursive: true });
      writeFileSync(join(scenes, 'Main.unity'), '--- !u!1 &1\nGameObject:\n  m_Name: Boot\n');

      expect(countSceneRenderersImpl(root)).toEqual({ scenes: 1, gameObjects: 1, renderers: 0 });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('counts both sprite and mesh renderers in a scene that does hold content', async () => {
    // Invented scene: a kelp-farm diorama with one sprite-drawn float and one
    // mesh-drawn trawler, plus a camera object that draws nothing itself.
    const { countSceneRenderersImpl } = await import('./strada-conformance.js');
    const root = mkdtempSync(join(os.tmpdir(), 'strada-census-'));
    try {
      const scenes = join(root, 'Assets', 'Scenes');
      mkdirSync(scenes, { recursive: true });
      writeFileSync(
        join(scenes, 'KelpFarm.unity'),
        [
          '--- !u!1 &11',
          'GameObject:',
          '  m_Name: TideCamera',
          '--- !u!1 &12',
          'GameObject:',
          '  m_Name: MarkerFloat',
          '--- !u!212 &13',
          'SpriteRenderer:',
          '--- !u!1 &14',
          'GameObject:',
          '  m_Name: Trawler',
          '--- !u!23 &15',
          'MeshRenderer:',
          '',
        ].join('\n'),
      );

      expect(countSceneRenderersImpl(root)).toEqual({ scenes: 1, gameObjects: 3, renderers: 2 });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
