/**
 * What the system knows without being told.
 *
 * The requirement: a design document plus "build this game" is a complete
 * instruction. The person asking may not be a developer. Everything a run
 * needs in order to reach a playable game has to live in the system, not in a
 * hand-written prompt — every rule below was a paragraph somebody typed into a
 * run today, and each one was typed because its absence had already cost hours.
 */

import { readFileSync } from "node:fs";

import { describe, expect, it, vi } from "vitest";
import type { IAIProvider, ProviderResponse } from "../providers/types.js";
import { GoalDecomposer } from "./goal-decomposer.js";

function recordingProvider(): { provider: IAIProvider; prompts: () => string } {
  const seen: string[] = [];
  const provider: IAIProvider = {
    name: "mock",
    capabilities: { streaming: false, vision: false, functionCalling: true },
    chat: vi.fn(async (prompt: string): Promise<ProviderResponse> => {
      seen.push(prompt);
      return {
        text: JSON.stringify({ nodes: [{ id: "s1", task: "do it", dependsOn: [] }] }),
        toolCalls: [],
        usage: { inputTokens: 1, outputTokens: 1 },
        stopReason: "end",
      };
    }),
  } as IAIProvider;
  return { provider, prompts: () => seen.join("\n") };
}

async function decompositionPrompt(
  task = "Build the game described in docs/design.md",
): Promise<string> {
  const { provider, prompts } = recordingProvider();
  await new GoalDecomposer(provider, 3).decomposeProactive("s", task);
  return prompts();
}

describe("planning a game", () => {
  /**
   * Rung 7 of the north star is "ready modules are used", and nothing in the
   * plan's own rules had ever asked for one: measured mid-run 2026-10-14,
   * Strada.Modules was installed in the project and 0 of its 16 game files
   * referenced it, while the plan declared modules of its own.
   */
  /**
   * Rung 8 of the north star is "the delivered game is playable through real
   * input", and the play-through the system runs is what judges it — but
   * nothing in the plan's rules had ever named the driver it resolves.
   * Measured live 2026-10-14: a sprint assembled a scene, ran its tests and
   * was refused with "the game registers no Strada.Core.Play.IPlaythroughDriver".
   */
  it("plans the play-through driver the delivery gate resolves, with the work it drives", async () => {
    const prompt = await decompositionPrompt();

    expect(prompt).toContain("THE GAME MUST BE PLAYABLE BY THE FRAMEWORK");
    expect(prompt).toContain("Strada.Core.Play.IPlaythroughDriver");
    // And the catalog, so a game of levels is played through all of them.
    expect(prompt).toContain("Strada.Core.Play.ISessionCatalog");
    // Not a detail for the end: the driver is planned with its work.
    expect(prompt).toContain("not after it");
    // A suite and a capture are not substitutes for being played.
    expect(prompt).toContain("no suite or capture substitutes for it");
  });

  it("plans a requirement a ready module already covers as a use of that module", async () => {
    const prompt = await decompositionPrompt();

    expect(prompt).toContain("A READY MODULE IS NOT REWRITTEN");
    expect(prompt).toContain("never as a module of your own that does the same thing");
    // And it must be named in the plan, or nobody can tell afterwards which
    // requirement was supposed to use which module.
    expect(prompt).toContain("Say in the plan which ready module each such requirement uses");
    // A requirement no ready module covers is a line in the plan, not silence.
    expect(prompt).toContain("if none fits");
  });

  it("treats a design document plus 'build it' as a complete instruction", async () => {
    const prompt = await decompositionPrompt();

    expect(prompt).toContain("may not be a developer");
    // The failure this prevents: planning a goal whose output is a question.
    expect(prompt).toContain("Do not plan a goal whose output is a question");
    expect(prompt).toContain("they already gave you one");
  });

  it("never makes a measurement, check or commit its own goal, even when the task lists it as a step (measured 2026-09-09: whole 60-minute node budgets on 'Run unity_delivery_measure')", async () => {
    const prompt = await decompositionPrompt();

    expect(prompt).toContain("never its own sub-goal, even when the task lists it as a numbered step");
    expect(prompt).toContain("re-measure, verify and commit\" is ONE goal");
  });

  it("requires the plan to reach something playable, not something that compiles", async () => {
    const prompt = await decompositionPrompt();

    expect(prompt).toContain("not a library that compiles");
    expect(prompt).toContain("no test filter");
  });

  it("has the plan decide which modules render, before planning them", async () => {
    const prompt = await decompositionPrompt();

    // Not every module gets a MonoBehaviour — that is the exception, not the shape.
    expect(prompt).toContain("Most modules are mechanics");
    expect(prompt).toContain("does not get one by default");
    expect(prompt).toContain("its own goals");
    expect(prompt).toContain("do not sprinkle rendering through every module");
  });

  it("asks for art for everything the design names, with or without a schedule section", async () => {
    // An invented design with no schedule of any kind: a one-page brief for a
    // tide-pool sorting game, where the player drags urchins, limpets and kelp
    // fronds into three baskets over a rockpool backdrop. It names what has to
    // be drawn and never says when anything is introduced — so a rule keyed to
    // "what the design schedules" has nothing to anchor on and plans no art at
    // all, while the capability it carries is needed by every game.
    const prompt = await decompositionPrompt(
      "Build the tide-pool sorting game in TidePool_brief.md — one page of prose, no tables",
    );

    expect(prompt).toContain("Every visible thing the design names");
    expect(prompt).toContain("characters, props, obstacles, backgrounds, interface pieces");
    // The chain the rule exists for, unchanged by the rewording: look for
    // owned art first, then generate what fits, then BIND it.
    expect(prompt).toContain("unity_my_assets_cloud");
    expect(prompt).toContain("unity_generate_sprite");
    expect(prompt).toContain("unity_generate_mesh");
    expect(prompt).toContain("unity_prerender_frames");
    expect(prompt).toContain("always the binding of that asset");
  });

  it("says nothing renders by itself, and names the framework's bridge", async () => {
    const prompt = await decompositionPrompt();

    expect(prompt).toContain("deliberately NOT MonoBehaviours");
    expect(prompt).toContain("EntityMediator");
    expect(prompt).toContain("ViewSyncRunner");
  });

  it("asks for the framework to be used, without demanding every subsystem", async () => {
    const prompt = await decompositionPrompt();

    expect(prompt).toContain("not merely started by it");
    expect(prompt).toContain("StradaLog");
    // ECS and DI are alternatives; a rule that demanded both would be wrong.
    expect(prompt).toContain("you need not use every subsystem");
  });

  it("does not let a plan end at writing code", async () => {
    const prompt = await decompositionPrompt();

    expect(prompt).toContain("Strada.MCP");
    expect(prompt).toContain('ends at "write the code"');
  });

  it("knows a prefab nothing references is invisible", async () => {
    // A config type that declares prefab fields references nothing until an
    // .asset instance of it exists with the references assigned; without
    // that, no prefab is reachable at run time. Making the asset is the step
    // between having prefabs and having a game.
    const prompt = await decompositionPrompt();

    expect(prompt).toContain("nothing references is invisible");
    expect(prompt).toContain("assign the references");
  });

  it("refuses to call a scene holding only a bootstrapper a scene", async () => {
    const prompt = await decompositionPrompt();

    expect(prompt).toContain("only a bootstrapper");
    expect(prompt).toContain("what the scene contains");
  });

  it("plans levels as work when the design has levels", async () => {
    const prompt = await decompositionPrompt();

    expect(prompt.toLowerCase()).toContain("level");
    expect(prompt).toContain("progression");
  });

  it("does not accept a green suite as proof that anything was drawn", async () => {
    // A passing suite proves the simulation, not the picture: only captured
    // frames that differ from an empty or uniform frame show that anything
    // renders.
    const prompt = await decompositionPrompt();

    expect(prompt).toContain("captured frame");
    expect(prompt).toContain("identical");
  });

  it("plans against the framework as it actually is, not as remembered", async () => {
    // The orchestrator, the agent stage and the delegation manager all received
    // the live API read from Strada.Core's own source at startup; planning was
    // the one place it never reached, so every plan was written against prose
    // typed after an incident. This is that gap closed.
    const { provider, prompts } = recordingProvider();
    const decomposer = new GoalDecomposer(provider, 2);
    decomposer.setDecompositionContext({
      providerCount: 1,
      frameworkKnowledge: () => "## Strada.Core Framework Knowledge (live)\n- `Strada.Core.Sync`",
    });

    await decomposer.decomposeProactive("build the game in the GDD");

    expect(prompts()).toContain("Strada.Core Framework Knowledge (live)");
    expect(prompts()).toContain("read from their own source");
  });

  it("says nothing extra when no snapshot has been taken yet", async () => {
    // Boot wires the generator asynchronously; a plan made before it lands must
    // not carry an empty heading pretending to be knowledge.
    const { provider, prompts } = recordingProvider();
    const decomposer = new GoalDecomposer(provider, 2);
    decomposer.setDecompositionContext({ providerCount: 1, frameworkKnowledge: () => null });

    await decomposer.decomposeProactive("build the game in the GDD");

    expect(prompts()).not.toContain("read from their own source");
  });

  it("is what bootstrap actually supplies", () => {
    // Proving the decomposer uses the getter says nothing about whether anyone
    // passes one. Removing the boot wiring left every other test in this file
    // green, which is exactly the gap this asserts.
    const source = readFileSync("src/core/bootstrap.ts", "utf8");
    const at = source.indexOf("initializeSupervisorStage({");
    const call = source.slice(at, source.indexOf("});", at));

    expect(at, "the supervisor stage call moved; this measures nothing").toBeGreaterThan(-1);
    expect(call, "planning is constructed without the live framework API").toContain(
      "getFrameworkKnowledge",
    );
    expect(call).toContain("buildFrameworkKnowledgeSection()");
  });
});
