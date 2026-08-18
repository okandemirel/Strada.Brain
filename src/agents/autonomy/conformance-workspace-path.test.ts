/**
 * Which tree the conformance rules read.
 *
 * Measured on a 68-minute run: the agent wrote into a workspace lease at
 * /var/folders/.../strada-workspaces/<id>/, the guard was handed the source
 * root, and the source root received nothing until the commit at the very end.
 * Every rule that reads the project — is this module complete, does this test
 * assembly hold a test, is there a scene — spent the whole run judging the
 * state the run started from.
 */

import { describe, expect, it } from "vitest";
import { conformanceProjectPath } from "./strada-conformance.js";

describe("where the guard looks", () => {
  it("reads the lease when the run has one, because that is where the writes go", () => {
    expect(conformanceProjectPath("/tmp/strada-workspaces/task_1", "/project")).toBe(
      "/tmp/strada-workspaces/task_1",
    );
  });

  it("reads the project when there is no lease", () => {
    expect(conformanceProjectPath(undefined, "/project")).toBe("/project");
  });

  it("has nothing to read when neither is known", () => {
    // Not an error: the guard's own rules already stay silent without a path,
    // rather than accusing a project they cannot see.
    expect(conformanceProjectPath(undefined, undefined)).toBeUndefined();
  });
});
