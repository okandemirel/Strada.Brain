import { describe, expect, it, vi, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  extractLookDescription,
  judgeVisualConformance,
  renderVisualConformance,
  selectGameplayFrame, artDirectionText } from "./visual-conformance.js";

const dirs: string[] = [];
function tmp(): string { const d = mkdtempSync(join(tmpdir(), "vc-")); dirs.push(d); return d; }
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

describe("look description", () => {
  it("a Markdown '## Art Direction' section is prose, not a contents listing (Codex 2026-09-11 B#23)", () => {
    const gdd = [
      "# Game", "## 1. Overview", "Some overview text.", "",
      "## Art Direction", "### Palette", "Warm ochre and deep indigo, high contrast, no pastels anywhere.",
      "### Shapes", "Chunky silhouettes with thick outlines; every element reads at 64 px on a phone screen.",
      "### Motion", "Snappy 2-frame anticipation, no easing longer than 120 ms, and a soft screen shake on impact.",
    ].join("\n");
    const look = extractLookDescription(gdd);
    expect(look.found).toBe(true);
    expect(look.text).toContain("Warm ochre");
    expect(look.text).not.toContain("### Palette");
  });

  it("takes the art-direction PROSE, never the table of contents", () => {
    // The shape that sank the earlier attempt: a TOC entry ~1100 lines above
    // the real section, both matching the same heading.
    const gdd = [
      "CONTENTS",
      "11.  ECONOMY",
      "12.  ART DIRECTION",
      "13.  AUDIO DESIGN",
      ...Array.from({ length: 40 }, (_, i) => `filler line ${i}`),
      "12.  ART DIRECTION",
      "12.1 Visual Style",
      "Two-layer look: crisp flat pixel-art canvases on softly rendered dimensional stages, ",
      "plus plump, glossy 3D-feel pigs with 2D-animation snappiness that read instantly against ",
      "the destructible layer, in bright warm colour with heavy contrast for readability.",
    ].join("\n");

    const look = extractLookDescription(gdd);
    expect(look.found).toBe(true);
    expect(look.text).toContain("pixel-art canvases");
    expect(look.text).not.toContain("AUDIO DESIGN");
  });

  it("says what is missing rather than guessing", () => {
    expect(extractLookDescription("# GDD\nNo art section here.").found).toBe(false);
    expect(extractLookDescription("").reason).toContain("empty");
  });
});

describe("frame selection", () => {
  it("takes the newest frame from this sprint's own run, under Recordings only", () => {
    const root = tmp();
    mkdirSync(join(root, "Recordings"), { recursive: true });
    mkdirSync(join(root, "Assets", "Art", "Prerendered"), { recursive: true });
    const old = join(root, "Recordings", "old.png");
    const fresh = join(root, "Recordings", "fresh.png");
    const art = join(root, "Assets", "Art", "Prerendered", "hero.png");
    for (const f of [old, fresh, art]) writeFileSync(f, "x".repeat(2048));
    const sprintStart = Date.now() - 60_000;
    utimesSync(old, new Date(sprintStart - 600_000), new Date(sprintStart - 600_000));

    const picked = selectGameplayFrame(root, sprintStart);
    expect(picked.path).toBe(fresh);
    expect(picked.path).not.toContain("Prerendered");
  });

  it("says so when this sprint captured nothing", () => {
    const root = tmp();
    mkdirSync(join(root, "Recordings"), { recursive: true });
    const stale = join(root, "Recordings", "stale.png");
    writeFileSync(stale, "x");
    utimesSync(stale, new Date(Date.now() - 86_400_000), new Date(Date.now() - 86_400_000));

    expect(selectGameplayFrame(root, Date.now() - 1000).reason).toContain("captured during this sprint");
  });
});

describe("the judgement", () => {
  const look = { found: true, text: "flat pixel-art canvases and glossy 3D-feel pigs" };

  it("asks the provider and reports its one-line answer", async () => {
    const root = tmp();
    const frame = join(root, "f.png");
    writeFileSync(frame, "x".repeat(64));
    const chat = vi.fn(async () => ({ text: "No — the frame shows a plain grid of flat squares with no pigs." }));

    const result = await judgeVisualConformance({
      look, frame: { path: frame },
      visionProvider: { provider: { chat, capabilities: { vision: true } } as never, name: "claude" },
    });

    expect(result.status).toBe("checked");
    expect(result.detail).toContain("plain grid");
    expect(renderVisualConformance(result, { path: frame })).toContain("claude");
  });

  it("reads the MATCH line as the verdict and renders it; no line, no verdict (2026-09-10)", async () => {
    const root = tmp();
    const frame = join(root, "f.png");
    writeFileSync(frame, "x".repeat(64));
    const no = await judgeVisualConformance({
      look, frame: { path: frame },
      visionProvider: { provider: { chat: vi.fn(async () => ({ text: "The frame shows a flat grid, no pigs.\nMATCH: no" })), capabilities: { vision: true } } as never, name: "claude" },
    });
    expect(no).toMatchObject({ status: "checked", matches: false, detail: "The frame shows a flat grid, no pigs." });
    expect(renderVisualConformance(no, { path: frame })).toContain("NO MATCH — The frame shows a flat grid");
    const yes = await judgeVisualConformance({
      look, frame: { path: frame },
      visionProvider: { provider: { chat: vi.fn(async () => ({ text: "MATCH: yes\nPlump pigs on a dimensional stage, as described." })), capabilities: { vision: true } } as never, name: "claude" },
    });
    expect(yes).toMatchObject({ status: "checked", matches: true, detail: "Plump pigs on a dimensional stage, as described." });
    const none = await judgeVisualConformance({
      look, frame: { path: frame },
      visionProvider: { provider: { chat: vi.fn(async () => ({ text: "Looks about right." })), capabilities: { vision: true } } as never, name: "claude" },
    });
    expect(none.matches).toBeUndefined();
  });

  it("NEVER passes silently when there is no vision provider", async () => {
    const root = tmp();
    const frame = join(root, "f.png");
    writeFileSync(frame, "x");
    const result = await judgeVisualConformance({ look, frame: { path: frame }, visionProvider: null });
    expect(result.status).toBe("not-checked");
    expect(result.detail).toContain("no configured provider reports vision");
    expect(renderVisualConformance(result, {})).toContain("⚠️");
  });

  it("reports a provider failure as not-checked, not as a pass", async () => {
    const root = tmp();
    const frame = join(root, "f.png");
    writeFileSync(frame, "x");
    const chat = vi.fn(async () => { throw new Error("429 rate limited"); });
    const result = await judgeVisualConformance({
      look, frame: { path: frame },
      visionProvider: { provider: { chat, capabilities: { vision: true } } as never, name: "openai" },
    });
    expect(result.status).toBe("not-checked");
    expect(result.detail).toContain("429");
  });
});

describe("the art direction a gate judges against (Codex 2026-09-11 F#3, H#13)", () => {
  it("extracts a SHORT explicit brief instead of falling back to the whole document", () => {
    const gdd = "## Art Direction\nMinimalist flat geometric art: use solid colored squares.\n";
    const look = extractLookDescription(gdd);
    // 57 characters, and it says everything the gate needs.
    expect(look.found).toBe(true);
    expect(look.text).toContain("solid colored squares");
    expect(artDirectionText(look, gdd)).toBe(look.text);
    // A section long enough for the ordinary floor still wins too.
    const long = `## Art Direction\n${"Hand-painted watercolour backdrops with visible brush texture, warm ochre and teal, soft edges everywhere and no hard outlines. ".repeat(3)}\n`;
    const found = extractLookDescription(long);
    expect(found.found).toBe(true);
    expect(artDirectionText(found, long)).toBe(found.text);
    expect(artDirectionText(undefined, undefined)).toBeUndefined();
  });

  it("stops at the next heading, keeps a one-word brief, and ignores generic verbs (Codex 2026-09-11 I#10)", () => {
    // The art section came FIRST and its body ran past "## Gameplay".
    const artFirst = [
      "## Art Direction",
      "Rich hand-painted watercolor environments and detailed painted characters.",
      "## Gameplay",
      "Solve geometric puzzles.",
    ].join("\n");
    const look = extractLookDescription(artFirst);
    expect(look.found).toBe(true);
    expect(look.text).not.toContain("geometric puzzles");

    // An EMPTY art section does not swallow the next heading's content
    // (Codex 2026-09-11 J#22).
    const empty = ["## Art Direction", "## Gameplay", "Solve geometric puzzles."].join("\n");
    const emptyLook = extractLookDescription(empty);
    expect(emptyLook.text ?? "").not.toContain("geometric puzzles");
    expect(artDirectionText(emptyLook, empty)).toBeUndefined();

    // "## Art Direction / Monochrome." is a complete brief.
    const oneWord = "## Art Direction\nMonochrome.\n";
    const mono = extractLookDescription(oneWord);
    expect(mono.found).toBe(true);
    expect(mono.text).toContain("Monochrome");

    // "look" is a gameplay verb, not evidence of art direction.
    const gameplayLook = "Players look for geometric clues. Levels are timed.";
    expect(artDirectionText(extractLookDescription(gameplayLook), gameplayLook)).toBeUndefined();
    const both = "Players look for geometric clues. Use richly painted watercolor environments.";
    const text = artDirectionText(extractLookDescription(both), both)!;
    expect(text).toContain("watercolor");
    expect(text).not.toContain("geometric clues");
  });

  it("a numbered heading, a subheading-only body and an inline brief (Codex 2026-09-11 K#11)", () => {
    // A NUMBERED heading ends the section too, empty body or not.
    const numbered = "1. ART DIRECTION\n2. GAMEPLAY\nSolve geometric puzzles.\nReach the exit.";
    const numberedLook = extractLookDescription(numbered);
    expect(numberedLook.text ?? "").not.toContain("geometric puzzles");
    expect(artDirectionText(numberedLook, numbered)).toBeUndefined();

    // A body of SUBHEADINGS is not a brief.
    const headingsOnly = "## Art Direction\n### Palette and references\n## Gameplay";
    const headingsLook = extractLookDescription(headingsOnly);
    expect(headingsLook.found).toBe(false);

    // …and a brief written INTO the heading is the brief.
    const inline = "## Art Direction: Richly painted watercolor environments.\n## Gameplay";
    const inlineLook = extractLookDescription(inline);
    expect(inlineLook.found).toBe(true);
    expect(inlineLook.text).toContain("watercolor");
  });

  it("never hands GAMEPLAY vocabulary to the style check (Codex 2026-09-11 H#13)", () => {
    // "Solve geometric puzzles." made asksForFlatArt true and waived the
    // placeholder-art refusal for a document asking for watercolour.
    const gdd = [
      "## Gameplay",
      "Solve geometric puzzles.",
      "## Art Direction",
      "Rich hand-painted watercolor environments and detailed painted characters.",
    ].join("\n");
    const look = extractLookDescription(gdd);
    expect(look.found).toBe(true);
    const text = artDirectionText(look, gdd)!;
    expect(text).toContain("watercolor");
    expect(text).not.toContain("geometric puzzles");

    // With NO art section at all, only the sentences about the LOOK speak.
    const noSection = "Solve geometric puzzles. Levels are procedurally generated.";
    expect(artDirectionText(extractLookDescription(noSection), noSection)).toBeUndefined();
    const inline = "Solve geometric puzzles. The art style is flat, minimal, solid colours only.";
    const inlineText = artDirectionText(extractLookDescription(inline), inline)!;
    expect(inlineText).toContain("flat, minimal");
    expect(inlineText).not.toContain("geometric puzzles");
  });
});
