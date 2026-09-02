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
 * Audited 2026-09-02: [STRADA SPEC SCOPE] was reachable only INSIDE the
 * nothing-drawn branch (`specScopePrompt() ?? "[STRADA NOTHING DRAWN] …"`),
 * where each SPEC SCOPE ask was charged to the nothing-drawn budget. A
 * non-rendering game with unimplemented elements heard SPEC SCOPE three times,
 * then both gates went silent, and the words "this game has never been
 * observed to render" — with the last-ask instruction — were never emitted
 * once. And a game whose frames DID vary was never checked against the
 * schedule at all.
 */
describe('SPEC SCOPE does not spend the NOTHING DRAWN budget', () => {
  const GDD = '| Unlock | Element |\n| --- | --- |\n| L21 | Rocket |\n';

  function withSchedule(frames: string[]): { root: string; configPath: string } {
    const fixture = project(frames);
    const docs = join(fixture.root, 'docs');
    mkdirSync(docs, { recursive: true });
    writeFileSync(join(docs, 'GDD.md'), GDD);
    return fixture;
  }

  /** Every gate tag heard across `turns` turns of work, in order. */
  function tagsHeard(root: string, configPath: string, turns: number): { tags: string[]; asked: string[] } {
    const guard = new StradaConformanceGuard(deps, { projectPath: root, enabled: true });
    guard.trackToolCall('file_write', { path: configPath }, false);
    guard.trackToolCall('unity_playmode_verify', {}, false);
    const asked: string[] = [];
    for (let turn = 0; turn < turns; turn++) {
      guard.trackToolCall('file_read', { path: configPath }, false);
      asked.push(guard.getPrompt() ?? '');
    }
    return { asked, tags: asked.map((p) => /\[STRADA ([A-Z ]+)\]/u.exec(p)?.[1] ?? '(none)') };
  }

  it('asks both, each on its own budget, and still delivers the last-ask instruction', () => {
    const { root, configPath } = withSchedule(Array.from({ length: 12 }, () => 'same-pixels'));

    const { tags, asked } = tagsHeard(root, configPath, 12);

    expect(tags).toContain('SPEC SCOPE');
    expect(tags.filter((t) => t === 'NOTHING DRAWN')).toHaveLength(3);
    const lastDrawn = asked.filter((p) => p.includes('NOTHING DRAWN')).at(-1) ?? '';
    expect(lastDrawn).toContain('rather than reporting it as delivered');
  });

  it('checks the schedule even when the frames vary', () => {
    const { root, configPath } = withSchedule(['a', 'b', 'c', 'd']);

    const { tags } = tagsHeard(root, configPath, 8);

    expect(tags).toContain('SPEC SCOPE');
    expect(tags).not.toContain('NOTHING DRAWN');
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
