/**
 * What the system knows without being told.
 *
 * The requirement: a design document plus "build this game" is a complete
 * instruction. The person asking may not be a developer. Everything a run
 * needs in order to reach a playable game has to live in the system, not in a
 * hand-written prompt — every rule below was a paragraph somebody typed into a
 * run today, and each one was typed because its absence had already cost hours.
 */

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

async function decompositionPrompt(): Promise<string> {
  const { provider, prompts } = recordingProvider();
  await new GoalDecomposer(provider, 3).decomposeProactive(
    "s",
    "Build the game in PixelFlow_GDD.docx",
  );
  return prompts();
}

describe("planning a game", () => {
  it("treats a design document plus 'build it' as a complete instruction", async () => {
    const prompt = await decompositionPrompt();

    expect(prompt).toContain("may not be a developer");
    // The failure this prevents: planning a goal whose output is a question.
    expect(prompt).toContain("Do not plan a goal whose output is a question");
    expect(prompt).toContain("they already gave you one");
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
    // Measured 2026-08-22: twenty-five prefabs, twenty-five sprites, a config
    // class declaring three GameObject fields — and zero .asset instances of
    // it, so nothing held a reference to any prefab at run time. Making the
    // asset is not a detail discovered later; it is the step between having
    // prefabs and having a game.
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
    // Forty-four of forty-four passed while every captured frame was the same
    // empty sky. Tests prove the simulation; only a frame proves the game.
    const prompt = await decompositionPrompt();

    expect(prompt).toContain("captured frame");
    expect(prompt).toContain("identical");
  });
});
