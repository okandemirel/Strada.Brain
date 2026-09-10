/**
 * Sound, motion and effects: the GDD's asks against the shipped scenes.
 * Until 2026-09-10 a silent, static delivery against a cue list read as
 * complete — nothing counted an AudioSource, an Animator or a ParticleSystem.
 */
import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import os from "node:os";
import { assessBuiltAsSpecified } from "./built-as-specified.js";
import { describeMedia } from "./gdd-media.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function project(): string {
  const root = mkdtempSync(join(os.tmpdir(), "gdd-media-"));
  roots.push(root);
  mkdirSync(join(root, "Assets"), { recursive: true });
  return root;
}
function put(root: string, rel: string, body: string, guid?: string): void {
  const abs = join(root, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, body);
  if (guid) writeFileSync(`${abs}.meta`, `fileFormatVersion: 2\nguid: ${guid}\n`);
}
function buildSettings(root: string, scenes: string[]): void {
  const body = scenes.map((p, i) => `  - enabled: 1\n    path: ${p}\n    guid: ${String(i).padStart(32, "a")}\n`).join("");
  put(root, "ProjectSettings/EditorBuildSettings.asset", `EditorBuildSettings:\n  m_Scenes:\n${body}`);
}
const HEADER = "%YAML 1.1\n%TAG !u! tag:unity3d.com,2011:\n";
const CAMERA = "--- !u!20 &900\nCamera:\n  m_Enabled: 1\n  orthographic: 1\n";
const SPRITE = "--- !u!212 &8\nSpriteRenderer:\n  m_Enabled: 1\n  m_Sprite: {fileID: 21300000, guid: 22222222222222222222222222222222, type: 3}\n";
const AUDIO = (clipGuid?: string): string =>
  `--- !u!82 &300\nAudioSource:\n  m_Enabled: 1\n  m_audioClip: ${clipGuid ? `{fileID: 8300000, guid: ${clipGuid}, type: 3}` : "{fileID: 0}"}\n  m_PlayOnAwake: 1\n`;
const ANIMATOR = (controllerGuid?: string): string =>
  `--- !u!95 &301\nAnimator:\n  m_Enabled: 1\n  m_Controller: ${controllerGuid ? `{fileID: 9100000, guid: ${controllerGuid}, type: 2}` : "{fileID: 0}"}\n`;
const PARTICLES = "--- !u!198 &302\nParticleSystem:\n  serializedVersion: 8\n  lengthInSec: 5\n";
const CLIP = "33333333333333333333333333333333";
const CONTROLLER = "44444444444444444444444444444444";
const GDD =
  "# GDD\n\n## Audio\nMusic base loop per area; SFX for tap, merge and win; audio ducks on pause.\n" +
  "## Feel\nPigs use squash-and-stretch animation; every merge is animated with a tween.\n" +
  "## Effects\nConfetti particles on level clear, a sparkle on merge, screen shake on the boss.\n";

function withScene(body: string, extraFiles?: (root: string) => void): ReturnType<typeof assessBuiltAsSpecified> {
  const root = project();
  buildSettings(root, ["Assets/Scenes/Main.unity"]);
  put(root, "Assets/Scenes/Main.unity", `${HEADER}${CAMERA}${SPRITE}${body}`, "5ce5e5e5e5e5e5e5e5e5e5e5e5e5e5e5");
  put(root, "Assets/Art/pig.png", "pixels", "22222222222222222222222222222222");
  extraFiles?.(root);
  return assessBuiltAsSpecified(root);
}
const withClip = (root: string): void => put(root, "Assets/Audio/merge.wav", "RIFF", CLIP);

describe("built-as-specified counts sound, motion and effects", () => {
  it("counts AudioSource/Animator/Animation/ParticleSystem and which are bound", () => {
    const r = withScene(`${AUDIO(CLIP)}${AUDIO()}${ANIMATOR(CONTROLLER)}${ANIMATOR()}${PARTICLES}`, (root) => {
      withClip(root);
      put(root, "Assets/Anim/Pig.controller", "controller", CONTROLLER);
      put(root, "Assets/Anim/Squash.anim", "clip");
    });
    expect(r.shippedAudioSources).toBe(2);
    expect(r.shippedAudioSourcesBound).toBe(1);
    expect(r.shippedAnimators).toBe(2);
    expect(r.shippedAnimatorsBound).toBe(1);
    expect(r.shippedParticleSystems).toBe(1);
    expect(r.reachableAudioClips).toBe(1);
    expect(r.animatorControllers).toBe(1);
    expect(r.animationClips).toBe(1);
    expect(r.scenes[0]!.audioClipsBound).toEqual(["Assets/Audio/merge.wav"]);
    expect(r.disclosures.join("\n")).toContain("2 AudioSource(s) (1 with a project clip; 1 of the 1 clip(s) reachable from a shipped scene by any route), 2 Animator(s) (1 with a controller; project holds 1 controller(s), 1 clip(s)), 0 legacy Animation(s), 1 ParticleSystem(s).");
  });
});

describe("describeMedia", () => {
  it("refuses the strong audio case: the GDD asks, clips exist, no shipped scene reaches one", () => {
    const d = describeMedia(GDD, withScene("", withClip));
    expect(d.signals.map((s) => [s.kind, s.count >= 3])).toEqual([["audio", true], ["animation", true], ["vfx", true]]);
    expect(d.refusal).toMatch(/^the GDD specifies audio \(\d+ mentions\) and the project holds 1 audio clip\(s\), but no shipped scene carries an AudioSource or reaches a single clip/);
    const text = d.lines.join("\n");
    expect(text).toContain("GDD audio (×");
    expect(text).toContain("shipped scenes carry 0 AudioSource(s), 0 bound to a clip; 0 of the project's 1 clip(s) are reachable");
    expect(text).toContain("GDD animation (×");
    expect(text).toContain("0 Animator(s) (0 with a controller)");
    expect(text).toContain("GDD effects (×");
    expect(text).toContain("0 ParticleSystem(s)");
  });

  it("a clip reachable through a config asset is not silent; animation and effects never refuse", () => {
    const d = describeMedia(
      GDD,
      withScene("", (root) => {
        withClip(root);
        // The scene references a config asset that references the clip: code can play it.
        put(root, "Assets/Settings/Audio.asset", `MonoBehaviour:\n  clip: {fileID: 8300000, guid: ${CLIP}, type: 3}\n`, "55555555555555555555555555555555");
        put(root, "Assets/Scenes/Main.unity", `${HEADER}${CAMERA}${SPRITE}--- !u!114 &9\nMonoBehaviour:\n  m_EditorClassIdentifier: A::B.Boot\n  cfg: {fileID: 11400000, guid: 55555555555555555555555555555555, type: 2}\n`, "5ce5e5e5e5e5e5e5e5e5e5e5e5e5e5e5");
      }),
    );
    expect(d.refusal).toBeUndefined();
    expect(d.lines.join("\n")).toContain("1 of the project's 1 clip(s) are reachable");
  });

  it("no clips at all is disclosed, not refused here; a GDD without media asks says so; unreadable GDD says so", () => {
    const none = describeMedia(GDD, withScene(""));
    expect(none.refusal).toBeUndefined();
    expect(none.lines.join("\n")).toContain("the project holds NO audio clips at all");
    expect(describeMedia("# GDD\n\nA quiet puzzle.", withScene("")).lines).toEqual([
      "Sound/motion/effects: the GDD names no audio, animation or effects — nothing to compare the scenes against.",
    ]);
    expect(describeMedia(undefined, withScene("")).lines[0]).toContain("NOT checked");
  });

  it("a passing mention is not an ask: below the threshold nothing refuses", () => {
    const d = describeMedia("# GDD\n\nA little music would be nice.", withScene("", withClip));
    expect(d.signals[0]).toMatchObject({ kind: "audio", count: 1 });
    expect(d.refusal).toBeUndefined();
  });
});
