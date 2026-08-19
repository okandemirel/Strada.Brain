/**
 * A refusal should stop the run once, and say something the run can act on.
 *
 * Traced from a measured run: four "execution stopped" reports, each ending
 * "No safer bounded replacement was produced in the same turn." That sentence
 * described a capability that does not exist — nothing in the system can
 * synthesize a replacement command, and the review contract has no field to
 * carry one — and the detector that produced it re-fired on old history.
 */

import { describe, it, expect, beforeAll } from "vitest";
import { SessionManager } from "./orchestrator-session-manager.js";
import { createLogger } from "../utils/logger.js";

beforeAll(() => { createLogger("error", "test.log"); });

const REJECTION =
  "Self-managed write review rejected (background mode) for 'shell_exec': " +
  "shell command looks destructive. Choose a safer bounded operation and continue.";

function sessionWith(content: string) {
  return {
    messages: [
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content }] },
    ],
  } as never;
}

const manager = () => new SessionManager({ } as never);

describe("reporting a refused write", () => {
  it("reports it once", () => {
    const sm = manager();
    const session = sessionWith(REJECTION);

    const first = sm.getPendingSelfManagedWriteRejectionVisibleText(session, "ok");
    const second = sm.getPendingSelfManagedWriteRejectionVisibleText(session, "ok");

    expect(first).toContain("Execution stopped");
    // The same rejection sits in history forever; without a consumed marker it
    // ended every later turn too.
    expect(second).toBeNull();
  });

  it("tells the run what it can do instead of naming a machine that does not exist", () => {
    const text = manager().getPendingSelfManagedWriteRejectionVisibleText(sessionWith(REJECTION), "ok");

    expect(text).toContain("shell command looks destructive");
    expect(text).toContain("narrower command");
    expect(text).not.toContain("No safer bounded replacement");
  });

  it("says nothing when the turn produced real work", () => {
    const text = manager().getPendingSelfManagedWriteRejectionVisibleText(
      sessionWith(REJECTION),
      "I read the config and found the module registration is missing.",
    );

    expect(text).toBeNull();
  });

  it("says nothing for an empty draft, which is a boundary and not an acknowledgement", () => {
    // A bare DONE/CONTINUE reflection normalizes to empty. The old guard let
    // that through and reported a stop that had not happened.
    expect(manager().getPendingSelfManagedWriteRejectionVisibleText(sessionWith(REJECTION), "")).toBeNull();
    expect(manager().getPendingSelfManagedWriteRejectionVisibleText(sessionWith(REJECTION), "DONE")).toBeNull();
  });
});
