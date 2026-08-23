import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
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

function project(frames: string[]): { root: string; configPath: string } {
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

  if (frames.length > 0) {
    const rec = join(root, 'Recordings');
    mkdirSync(rec, { recursive: true });
    frames.forEach((content, i) => {
      writeFileSync(join(rec, `frame_${String(i).padStart(5, '0')}.png`), content);
    });
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

  it('stays quiet once the frames differ from each other', () => {
    const { root, configPath } = project(['a-frame', 'b-frame', 'c-frame']);

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
