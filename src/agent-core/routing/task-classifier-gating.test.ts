/**
 * What `complexity` actually decides.
 *
 * detectComplexity carried a comment asserting that complexity "does NOT gate
 * tool availability or supervisor activation (those decisions use shouldDecompose
 * + LLM)". Two files away, `Orchestrator.shouldActivateSupervisor` returns
 * `classification.complexity === "complex"` and nothing else, and that boolean is
 * the sole admission gate for the supervisor path.
 *
 * The comment cost real time in this repo: it was read, believed, and used to
 * rule the classifier out as the cause of a request being fanned into a
 * seven-node goal tree — which is exactly what it had done. A comment that
 * contradicts the code is worse than no comment, because it is trusted.
 *
 * These tests pin the relationship so the two cannot drift apart silently again.
 * They assert the boundary as it is, not as it should be: 120 characters is a
 * crude proxy for "this is several pieces of work", and replacing it needs
 * evidence rather than a different guess — a prose request naming no files is
 * exactly the kind that most needs decomposing and would score zero on any
 * target-counting rule.
 */

import { describe, it, expect } from "vitest";
import { TaskClassifier } from "./task-classifier.js";

const classify = (prompt: string) => new TaskClassifier().classify(prompt);

describe("complexity is decided by length alone", () => {
  const cases: Array<[string, number, string]> = [
    ["trivial", 10, "hi"],
    ["simple", 40, "fix the build"],
    ["moderate", 100, "add a service"],
    ["complex", 200, "add a service"],
  ];

  for (const [expected, length, seed] of cases) {
    it(`calls a ${length}-character request "${expected}"`, () => {
      // Padded with a word, not spaces: detectComplexity measures trim().length.
      const prompt = (seed + " thoroughly".repeat(40)).slice(0, length);
      expect(prompt.trim().length).toBe(length);
      expect(classify(prompt).complexity).toBe(expected);
    });
  }

  it("draws the complex boundary at 120 characters", () => {
    const under = "a".repeat(119);
    const over = "a".repeat(120);

    expect(classify(under).complexity).toBe("moderate");
    expect(classify(over).complexity).toBe("complex");
  });

  it("is blind to how many things the request actually names", () => {
    // The measured case that makes any target-counting replacement a bad trade:
    // a short request naming three files scores lower than a long one naming
    // none, and it is the long prose one that needs decomposing.
    const threeFiles = "fix `A.cs`, `B.cs` and `C.cs`";
    const prose = "a".repeat(200);

    expect(classify(threeFiles).complexity).not.toBe("complex");
    expect(classify(prose).complexity).toBe("complex");
  });
});
