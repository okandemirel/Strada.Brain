/**
 * Detector for docs/contracts/gate-needs-an-asker.md, rule every-gate-has-an-asker.
 *
 * A gate that refuses work for a reason no prompt ever mentioned fails every
 * run for the same reason, and the failure reads as the model's fault. Found
 * three times on 2026-10-14 by reading a live run (ready modules, the
 * play-through driver, service registration) — each time the gate worked and
 * its tests passed; nothing had asked the plan for what it judges.
 *
 * So every `[STRADA …]` refusal the conformance gates can raise has a row here
 * naming the sentence — in the planner's rules, the worker's knowledge prompt
 * or a tool description the worker is given — that asks for what the gate
 * judges, BEFORE the refusal. A new gate without a row fails this file; a row
 * whose sentence has been edited away fails it too.
 *
 * What this file cannot do: judge MEANING. It proves the credited sentence is
 * there, not that it asks for what the gate judges. That is the job of whoever
 * writes or edits a row, and of the review: read the sentence against the
 * gate's own message.
 */
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const SRC_DIR = fileURLToPath(new URL("..", import.meta.url));

const DECOMPOSER = "src/goals/goal-decomposer.ts";
const KNOWLEDGE = "src/agents/context/strada-knowledge.ts";
const MODULE_TOOL = "src/agents/tools/strada/module-create.ts";

type Row =
  | { readonly asker: string; readonly phrase: string }
  /**
   * No asker, for one of two reasons only. `repair`: the gate names a broken
   * state the run itself created and its own message is the instruction —
   * nothing a plan produces. `review`: it asks for a check of finished work.
   */
  | { readonly none: "repair" | "review" };

const LEDGER: Readonly<Record<string, Row>> = {
  "[STRADA SPEC SCOPE]": { asker: DECOMPOSER, phrase: "Read the design for its shape and plan to that shape" },
  "[STRADA MODULE INCOMPLETE]": { asker: MODULE_TOOL, phrase: "Generates: ModuleConfig, asmdef" },
  "[STRADA DUPLICATE ASSEMBLY]": { none: "repair" },
  "[STRADA NO CAMERA]": { asker: DECOMPOSER, phrase: "Say what the scene contains — camera" },
  "[STRADA NOTHING RENDERS]": { asker: DECOMPOSER, phrase: "Nothing renders by itself" },
  "[STRADA SERVICE UNREGISTERED]": { asker: DECOMPOSER, phrase: "Plan the registration with the service" },
  "[STRADA REIMPLEMENTED]": { asker: DECOMPOSER, phrase: "Build WITH Strada.Core, not merely started by it" },
  "[STRADA REFERENCE DANGLING]": { asker: KNOWLEDGE, phrase: "NEVER hand-write a .unity scene or a .asset file" },
  "[STRADA PREFABS UNBOUND]": {
    asker: DECOMPOSER,
    phrase: "the plan must create its .asset instance and assign the references",
  },
  "[STRADA GAME NOT ASSEMBLED]": {
    asker: KNOWLEDGE,
    phrase: "A ModuleConfig CLASS does nothing until a ModuleConfig ASSET exists for it",
  },
  // An .asmdef with no test beside it is a state the run made by hand
  // (strada_create_module's template writes a test); the gate's message —
  // "Write the tests, or delete the assembly" — is the instruction. The
  // sentence once credited here was about reading a run's result, not about
  // what this gate judges: present, but not an asker.
  "[STRADA TEST ASSEMBLY EMPTY]": { none: "repair" },
  "[STRADA FILE TOO LONG]": { asker: KNOWLEDGE, phrase: "Keep a file under 200 lines" },
  "[STRADA MODULE TESTS MISSING]": { asker: MODULE_TOOL, phrase: "plus Tests/Runtime and Tests/Editor" },
  "[STRADA ASSETS UNSOURCED]": {
    asker: DECOMPOSER,
    phrase: "first unity_my_assets (local cache) or unity_my_assets_cloud",
  },
  "[STRADA ELEMENT ASSETS MISSING]": { asker: DECOMPOSER, phrase: "Every visible thing the design names" },
  "[STRADA NOTHING DRAWN]": { asker: DECOMPOSER, phrase: "Plan a play-mode capture and read it" },
  "[STRADA GAME NEVER RUN]": { asker: DECOMPOSER, phrase: "a play-mode run that passes with no test filter" },
  "[STRADA CONFORMANCE REQUIRED]": { none: "review" },
};

/** Rows with no asker. Raising this is a decision the diff should show. */
const PINNED_NONE = 3;

const GATE_TAG = /\[STRADA [A-Z][A-Z0-9 _-]+\]/g;
const COMMENT_LINE = /^\s*(\/\/|\*|\/\*)/;

function tsSources(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) tsSources(full, out);
    else if (/\.ts$/.test(entry) && !/\.(test|spec)\.ts$/.test(entry) && !/\.d\.ts$/.test(entry)) out.push(full);
  }
  return out;
}

/** Source text with comment lines dropped: a sentence in a comment asks nobody. */
function codeText(repoPath: string): string {
  const abs = join(SRC_DIR, repoPath.replace(/^src\//, ""));
  return readFileSync(abs, "utf8")
    .split("\n")
    .filter((line) => !COMMENT_LINE.test(line))
    .join("\n");
}

function gateTagsInSource(): Map<string, string[]> {
  const found = new Map<string, string[]>();
  for (const file of tsSources(SRC_DIR)) {
    const shown = `src/${relative(SRC_DIR, file).split(sep).join("/")}`;
    for (const line of readFileSync(file, "utf8").split("\n")) {
      if (COMMENT_LINE.test(line)) continue;
      for (const [tag] of line.matchAll(GATE_TAG)) {
        const files = found.get(tag) ?? [];
        if (!files.includes(shown)) files.push(shown);
        found.set(tag, files);
      }
    }
  }
  return found;
}

describe("every gate has an asker (docs/contracts/gate-needs-an-asker.md)", () => {
  const tags = gateTagsInSource();

  it("every [STRADA …] refusal in the source has a ledger row", () => {
    const missing = [...tags.entries()]
      .filter(([tag]) => !(tag in LEDGER))
      .map(([tag, files]) => `${tag} (raised in ${files.join(", ")})`);
    expect(missing, "add a row: which prompt sentence asks the plan for what this gate judges?").toEqual([]);
  });

  it("every ledger row still names a gate the source raises", () => {
    const gone = Object.keys(LEDGER).filter((tag) => !tags.has(tag));
    expect(gone, "a removed or renamed gate: delete or rename its row").toEqual([]);
  });

  it("every asker sentence is still in the prompt or tool text it is credited to", () => {
    const lost = Object.entries(LEDGER).flatMap(([tag, row]) =>
      "asker" in row && !codeText(row.asker).includes(row.phrase) ? [`${tag}: "${row.phrase}" not in ${row.asker}`] : [],
    );
    expect(lost, "the sentence that asked for this gate was edited away — restore it or credit the new one").toEqual(
      [],
    );
  });

  it("rows without an asker stay few and visible", () => {
    const none = Object.values(LEDGER).filter((row) => "none" in row).length;
    expect(none).toBe(PINNED_NONE);
  });
});
