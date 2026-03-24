import { describe, it, expect, vi } from "vitest";
import { CapabilityMatcher } from "../capability-matcher.js";
import type { GoalNode } from "../../goals/types.js";

function makeNode(task: string, id = "goal_1"): GoalNode {
  return {
    id: id as any,
    parentId: null,
    task,
    dependsOn: [],
    depth: 0,
    status: "pending",
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

describe("CapabilityMatcher", () => {
  describe("heuristic matching", () => {
    const matcher = new CapabilityMatcher();

    it("detects vision from image keywords", () => {
      const node = makeNode("Process uploaded image and generate thumbnail");
      const profile = matcher.matchHeuristic(node);
      expect(profile.primary).toContain("vision");
      expect(profile.confidence).toBeGreaterThanOrEqual(0.7);
    });

    it("detects reasoning from analysis keywords", () => {
      const node = makeNode("Analyze and debug the authentication flow");
      const profile = matcher.matchHeuristic(node);
      expect(profile.primary).toContain("reasoning");
    });

    it("detects code-gen from implementation keywords", () => {
      const node = makeNode("Implement user registration endpoint");
      const profile = matcher.matchHeuristic(node);
      expect(profile.primary).toContain("code-gen");
    });

    it("detects speed preference from quick keywords", () => {
      const node = makeNode("Quick lint check on the file");
      const profile = matcher.matchHeuristic(node);
      expect(profile.preference).toBe("speed");
    });

    it("detects quality preference from critical keywords", () => {
      const node = makeNode("Security review of the production auth code");
      const profile = matcher.matchHeuristic(node);
      expect(profile.preference).toBe("quality");
    });

    it("returns low confidence for ambiguous tasks", () => {
      const node = makeNode("Handle the data processing step");
      const profile = matcher.matchHeuristic(node);
      expect(profile.confidence).toBeLessThan(0.7);
    });

    it("returns high confidence with multiple matches", () => {
      const node = makeNode("Implement and build the new code feature with refactoring");
      const profile = matcher.matchHeuristic(node);
      expect(profile.confidence).toBeGreaterThanOrEqual(0.9);
    });

    it("detects multiple primary capabilities", () => {
      const node = makeNode("Analyze the uploaded screenshot and debug the visual layout");
      const profile = matcher.matchHeuristic(node);
      expect(profile.primary).toContain("vision");
      expect(profile.primary).toContain("reasoning");
    });

    it("detects cost preference", () => {
      const node = makeNode("Do a simple straightforward config change");
      const profile = matcher.matchHeuristic(node);
      expect(profile.preference).toBe("cost");
    });

    it("defaults to code-gen when no signals match", () => {
      const node = makeNode("Handle the thing");
      const profile = matcher.matchHeuristic(node);
      expect(profile.primary).toContain("code-gen");
    });
  });

  describe("matchNodes (full pipeline)", () => {
    it("processes multiple nodes, skips LLM for high-confidence", async () => {
      const matcher = new CapabilityMatcher();
      const nodes = [
        makeNode("Implement login endpoint", "goal_1"),
        makeNode("Analyze the debug trace carefully", "goal_2"),
      ];
      const results = await matcher.matchNodes(nodes);
      expect(results).toHaveLength(2);
      expect(results[0].capabilityProfile.primary).toContain("code-gen");
      expect(results[1].capabilityProfile.primary).toContain("reasoning");
    });

    it("assigns default profile when no signals match and no triage provider", async () => {
      const matcher = new CapabilityMatcher();
      const nodes = [makeNode("Do the thing")];
      const results = await matcher.matchNodes(nodes);
      expect(results[0].capabilityProfile.primary).toContain("code-gen");
      expect(results[0].capabilityProfile.preference).toBe("quality");
    });

    it("uses triage provider for ambiguous nodes when available", async () => {
      const mockProvider = {
        name: "groq",
        capabilities: {},
        chat: vi.fn().mockResolvedValue({
          text: '[{"capabilities": ["reasoning", "tool-use"], "preference": "speed"}]',
          toolCalls: [],
          stopReason: "end_turn",
          usage: { inputTokens: 0, outputTokens: 0 },
        }),
      };
      const matcher = new CapabilityMatcher(mockProvider as any);
      const nodes = [makeNode("Do the ambiguous thing")];
      const results = await matcher.matchNodes(nodes);
      expect(mockProvider.chat).toHaveBeenCalled();
      expect(results[0].capabilityProfile.primary).toContain("reasoning");
    });
  });
});
