import { describe, expect, it, vi, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  extractLookDescription,
  judgeVisualConformance,
  renderVisualConformance,
  selectGameplayFrame,
} from "./visual-conformance.js";

const dirs: string[] = [];
function tmp(): string { const d = mkdtempSync(join(tmpdir(), "vc-")); dirs.push(d); return d; }
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

describe("look description", () => {
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
