/**
 * Sound, motion and effects: what the GDD asks for against what ships.
 *
 * Until 2026-09-10 a GDD's cue list ("music base loop, area variations, a
 * complete SFX list"), its animation brief ("squash-and-stretch pigs") and
 * its effects ("confetti on level clear") were measured by nothing: the
 * structural gate counted renderers and sprites, the art inventory counted
 * clips on disk, and a silent, static delivery read as complete.
 *
 * This is the same shape as the dimensionality disclosure: the GDD's own
 * words with counts and excerpts, beside the counts the shipped scenes carry
 * (built-as-specified scans AudioSource / Animator / Animation /
 * ParticleSystem documents in the enabled scenes and the prefabs they place,
 * and the audio clips any shipped scene reaches by guid). Animation and
 * effects are disclosure only — a tween in code or a sprite-sheet flipbook is
 * a legitimate animation a file scan cannot see. Audio refuses on the strong
 * case alone: the GDD asks for it, the project holds clips, and no shipped
 * scene reaches a single one of them by any route.
 */
import type { BuiltAsSpecifiedReport } from "./built-as-specified.js";

export type MediaKind = "audio" | "animation" | "vfx";

export interface MediaSignal {
  readonly kind: MediaKind;
  readonly count: number;
  readonly excerpts: readonly string[];
}

export interface MediaDisclosure {
  readonly signals: readonly MediaSignal[];
  /** Report lines — every kind the GDD names gets one. */
  readonly lines: readonly string[];
  /** Set only for the strong audio case; see the module comment. */
  readonly refusal?: string;
}

/**
 * Does the document ASK FOR SILENCE — as against asking that the game be
 * PLAYABLE in silence?
 *
 * "Play without sound is fully equivalent (no audio-only cues)" is an
 * accessibility requirement, and it matched the denial, so the vehicle's whole
 * audio gate was switched off on a project with twenty-nine imported clips and
 * none reachable from a shipped scene (Codex 2026-09-12 V). An accessibility
 * promise cannot negate the sound the same document specifies.
 */
const DENIES_SOUND_RE = /\b(?:no (?:music|audio|sound|sfx)\b|silent by design|without (?:any )?(?:music|audio|sound))\b/gi;
/** The clause words that make such a sentence an accessibility promise. */
const ACCESSIBILITY_CLAUSE_RE =
  /\b(?:accessib\w*|equivalent|optional(?:ly)?|assist|reduced motion|subtitle|caption|colou?r ?blind|haptics?|toggle|mute[ds]?|deaf|hard of hearing)\b/i;

export function deniesSoundAnywhere(documentText: string): boolean {
  DENIES_SOUND_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = DENIES_SOUND_RE.exec(documentText)) !== null) {
    const at = m.index;
    // …and "no audio-ONLY cues" denies a KIND of cue, not the sound itself.
    if (/^-?only\b/i.test(documentText.slice(at + m[0].length, at + m[0].length + 6))) continue;
    const from = Math.max(0, documentText.lastIndexOf("\n", at), documentText.lastIndexOf(".", at) + 1);
    let to = documentText.indexOf("\n", at);
    if (to < 0) to = documentText.length;
    if (ACCESSIBILITY_CLAUSE_RE.test(documentText.slice(from, to))) continue;
    return true;
  }
  return false;
}

/**
 * Does the document ask for sound anywhere? A prose cue ("SFX for the tap"),
 * a labelled list or column ("Audio: pop_tap"), or a section of its own — the
 * vehicle states its cues as an Event/Visual/Audio/Haptic table, which no
 * prose pattern can see (Codex 2026-09-12 V).
 */
export function asksForSoundAnywhere(documentText: string): boolean {
  if (/\b(?:sfx|sound effects?|voice ?over|music)\s+(?:for|on|when|plays?|cue)/i.test(documentText)) return true;
  // A colon, or a dash with a space: "audio-only" is a kind of cue, not a
  // label introducing one.
  if (/\b(?:sfx|sound effects?|audio|music|soundtrack|jingle|voice ?over)\b\s*(?::\s*\S|[—–-]\s+\S)/i.test(documentText)) return true;
  // A heading or table column of its own: a document with an AUDIO section is
  // not a document asking for silence.
  if (/^[\s#>•*\-\t]*(?:audio|sound(?:track)?|music|sfx)\b[^\n]{0,40}$/im.test(documentText)) return true;
  return false;
}

/** How many mentions make a category a stated requirement rather than a passing word. */
export const MEDIA_ASK_THRESHOLD = 3;

/**
 * The audio CUES a document names, as its own sentences.
 *
 * One reachable clip used to clear a cue list of any length: the gate asked
 * whether ANY clip was reachable, so a document listing "SFX for the tap,
 * music on the menu, a jingle when the level ends…" was satisfied by a single
 * imported sound (Codex 2026-09-12 R#12). Only explicit cue statements count —
 * a sound named FOR an event — so a document that merely says "audio" many
 * times names no cues and this measures nothing.
 */
const AUDIO_CUE_RE =
  /\b(sfx|sound\s+effects?|sound|music|soundtrack|jingle|voice[- ]?over|ambien(?:ce|t\s+sound))\b[^.\n]{0,40}?\b(?:for|on|when|plays?\s+(?:on|when)|cue(?:s|d)?\s+(?:on|when))\b([^.\n]{3,60})/giu;

/** Distinct audio cues the document states, as "<sound> → <event>" keys. */
export function audioCuesNamed(documentText: string): string[] {
  const cues = new Set<string>();
  AUDIO_CUE_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = AUDIO_CUE_RE.exec(documentText)) !== null) {
    const sound = m[1]!.toLowerCase().replace(/\s+/gu, " ");
    const event = m[2]!.toLowerCase().replace(/[^a-z0-9 ]+/gu, " ").replace(/\s+/gu, " ").trim().slice(0, 40);
    if (event.length < 3) continue;
    cues.add(`${sound} → ${event}`);
    if (cues.size >= 64) break;
  }
  return [...cues];
}

/** Below this, a cue list is too small to measure a shortfall against. */
export const MIN_CUES_TO_MEASURE = 3;

const MEDIA_TERMS: ReadonlyArray<{ kind: MediaKind; re: RegExp }> = [
  { kind: "audio", re: /\b(?:music|soundtrack|sfx|sound\s+effects?|audio|jingle|ambien(?:ce|t\s+sound)|voice[- ]?over)\b/giu },
  { kind: "animation", re: /\b(?:animat(?:ion|ions|ed|e|es|ing)|squash[- ]and[- ]stretch|tween(?:s|ing)?|keyframes?)\b/giu },
  { kind: "vfx", re: /\b(?:particles?|vfx|visual\s+effects?|confetti|sparkles?|explosions?|screen\s+shake|trail\s+effects?)\b/giu },
];

function excerptAround(text: string, index: number, length: number): string {
  const from = Math.max(0, index - 60);
  const to = Math.min(text.length, index + length + 60);
  return `…${text.slice(from, to).replace(/\s+/gu, " ").trim()}…`;
}

export function describeMedia(gddText: string | undefined, report: BuiltAsSpecifiedReport): MediaDisclosure {
  const signals: MediaSignal[] = [];
  if (gddText) {
    for (const { kind, re } of MEDIA_TERMS) {
      const excerpts: string[] = [];
      let count = 0;
      let m: RegExpExecArray | null;
      re.lastIndex = 0;
      while ((m = re.exec(gddText)) !== null) {
        count++;
        if (excerpts.length < 2) excerpts.push(excerptAround(gddText, m.index, m[0].length));
        if (count > 5_000) break;
      }
      if (count > 0) signals.push({ kind, count, excerpts });
    }
  }
  const lines: string[] = [];
  if (!gddText) {
    lines.push("Sound/motion/effects: the GDD text was not readable, so what it asks for was NOT checked against the scenes.");
    return { signals, lines };
  }
  if (signals.length === 0) {
    lines.push("Sound/motion/effects: the GDD names no audio, animation or effects — nothing to compare the scenes against.");
    return { signals, lines };
  }
  if (!report.measured) {
    lines.push(
      `Sound/motion/effects the GDD names: ${signals.map((s) => `${s.kind} ×${s.count}`).join(", ")}; the shipped scenes could not be measured, so the comparison was NOT made.`,
    );
    return { signals, lines };
  }
  const asks = (kind: MediaKind): MediaSignal | undefined => signals.find((s) => s.kind === kind && s.count >= MEDIA_ASK_THRESHOLD);
  let refusal: string | undefined;

  const audio = signals.find((s) => s.kind === "audio");
  if (audio) {
    const clips = report.artInventory.audio;
    lines.push(
      `GDD audio (×${audio.count}; e.g. ${audio.excerpts[0] ?? ""}): shipped scenes carry ${report.shippedAudioSources} AudioSource(s), ` +
        `${report.shippedAudioSourcesBound} bound to a clip; ${report.reachableAudioClips} of the project's ${clips} clip(s) are reachable from a shipped scene by any route.`,
    );
    // AN UNBOUND AudioSource IS NOT SOUND, and a GDD that asks for audio with
    // NO clip in the project is a cue list nobody made — both used to pass
    // (Codex 2026-09-11 B#12). What still cannot be judged from files (mixing,
    // triggers, loop points) stays a disclosure.
    const documentText = gddText ?? "";
    // A game may generate its sound in code, and a document may ASK for
    // silence; neither is a missing cue list (Codex 2026-09-11 C#17).
    const proceduralAudio = /\b(?:onaudiofilterread|procedural(?:ly)?[- ]generated (?:audio|music|sound)|synthesi[sz]ed at runtime|audio synthesis)\b/i.test(documentText);
    // Silence must be the WHOLE document's answer: "No music. SFX for hits"
    // still asks for sound, and a blanket exemption let it ship silent (Codex
    // 2026-09-11 D#28). A positive ask anywhere cancels it.
    const deniesSound = deniesSoundAnywhere(documentText);
    const asksForSound = asksForSoundAnywhere(documentText);
    const asksForSilence = deniesSound && !asksForSound;
    if (asks("audio") && clips === 0 && !proceduralAudio && !asksForSilence) {
      refusal =
        `the GDD specifies audio (${audio.count} mentions) and the project holds NO audio clip at all — ` +
        "the cue list was never produced, so the delivery is silent";
    } else if (asks("audio") && clips === 0) {
      lines.push(
        proceduralAudio
          ? "GDD audio: no imported clips, and the document says the sound is generated at runtime — not measurable from files (disclosed)."
          : "GDD audio: the document asks for silence, and the project holds no clips — consistent (disclosed).",
      );
    } else if (asks("audio") && clips > 0 && report.reachableAudioClips === 0 && report.shippedAudioSourcesBound === 0
      && !proceduralAudio && !asksForSilence) {
      // (the zero-reachable case is below; the cue-count case follows it)
      // An unused package clip appearing in the project did not turn a
      // deliberately silent or procedurally-scored game into a defect
      // (Codex 2026-09-11 D#29).
      refusal =
        `the GDD specifies audio (${audio.count} mentions) and the project holds ${clips} audio clip(s), but no shipped scene reaches a ` +
        `single clip by any route and none of its ${report.shippedAudioSources} AudioSource(s) is bound to one — the delivery is silent`;
    } else if (asks("audio") && !proceduralAudio && !asksForSilence) {
      // A CUE LIST IS A LIST. The gate above only asks whether ANY clip is
      // reachable, so one sound cleared a document naming a dozen cues
      // (Codex 2026-09-12 R#12). What the document states as cues is counted,
      // and the shortfall is named with both numbers.
      const cues = audioCuesNamed(documentText);
      // A CUE IS NOT A CLIP. "SFX for win. SFX for retry. Use the same click
      // clip for all three" names three cues and one correct clip, and
      // comparing the counts refused it (Codex 2026-09-12 U#F8). When the
      // document says the clips are shared, the counts are disclosed instead
      // — whether each event is actually wired is a producer measurement.
      const sharesClips = /\b(?:same|shared|one|single|reuse[ds]?|reusing)\b[^.\n]{0,40}\bclip\b|\bclip\b[^.\n]{0,30}\b(?:for all|shared|reused)\b/i.test(documentText);
      if (cues.length >= MIN_CUES_TO_MEASURE && report.reachableAudioClips < cues.length && !sharesClips) {
        refusal =
          `the GDD names ${cues.length} audio cues (${cues.slice(0, 4).join("; ")}${cues.length > 4 ? "; …" : ""}) and the shipped scenes ` +
          `reach ${report.reachableAudioClips} clip(s) — the cue list is not produced`;
      } else if (cues.length >= MIN_CUES_TO_MEASURE) {
        lines.push(
          `GDD audio: ${cues.length} cue(s) named, ${report.reachableAudioClips} clip(s) reachable from a shipped scene` +
          `${sharesClips ? " — the document says clips are shared between cues, so the counts are not compared" : ""} (disclosed).`,
        );
      }
    }
  }
  const anim = signals.find((s) => s.kind === "animation");
  if (anim) {
    lines.push(
      `GDD animation (×${anim.count}; e.g. ${anim.excerpts[0] ?? ""}): shipped scenes carry ${report.shippedAnimators} Animator(s) ` +
        `(${report.shippedAnimatorsBound} with a controller) and ${report.shippedAnimations} legacy Animation(s); the project holds ` +
        `${report.animatorControllers} controller(s) and ${report.animationClips} clip(s). A tween in code or a sprite flipbook is animation a file scan cannot see — counts, not a verdict.`,
    );
  }
  const vfx = signals.find((s) => s.kind === "vfx");
  if (vfx) {
    lines.push(
      `GDD effects (×${vfx.count}; e.g. ${vfx.excerpts[0] ?? ""}): shipped scenes carry ${report.shippedParticleSystems} ParticleSystem(s). ` +
        "Sprite-based effects are not counted here — counts, not a verdict.",
    );
  }
  return { signals, lines, ...(refusal ? { refusal } : {}) };
}
