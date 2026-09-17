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

  /** A rejection followed by later tool activity; names resolve via the assistant's tool_use ids. */
  function sessionAfterRejection(later: Array<{ name: string; content: string; is_error?: boolean }>) {
    return {
      messages: [
        { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "shell_exec", input: {} }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: REJECTION }] },
        {
          role: "assistant",
          content: later.map((l, i) => ({ type: "tool_use", id: `t${i + 2}`, name: l.name, input: {} })),
        },
        {
          role: "user",
          content: later.map((l, i) => ({
            type: "tool_result",
            tool_use_id: `t${i + 2}`,
            content: l.content,
            ...(l.is_error === undefined ? {} : { is_error: l.is_error }),
          })),
        },
      ],
    } as never;
  }

  it("is resolved by a later successful write — the safer bounded replacement the review asked for (Codex 2026-09-17)", () => {
    // Shell write refused, then the dedicated file tool did the edit: the
    // run finished its work. Reporting the old refusal — now as a blocked
    // terminal status — sent a finished task into a retry.
    const session = sessionAfterRejection([{ name: "file_write", content: "Wrote Assets/Scripts/Hud.cs (42 lines)" }]);
    expect(manager().getPendingSelfManagedWriteRejectionVisibleText(session, "Done.")).toBeNull();
  });

  it("…but a later READ does not resolve it, and neither does a failed write", () => {
    const readOnly = sessionAfterRejection([{ name: "file_read", content: "namespace Game {}" }]);
    expect(manager().getPendingSelfManagedWriteRejectionVisibleText(readOnly, "Done.")).toContain("Execution stopped");
    const failed = sessionAfterRejection([{ name: "file_write", content: "Error: EACCES", is_error: true }]);
    expect(manager().getPendingSelfManagedWriteRejectionVisibleText(failed, "Done.")).toContain("Execution stopped");
  });

  it("uses the caller's tool metadata when given (a tool named like a read can still write)", () => {
    const session = sessionAfterRejection([{ name: "unity_get_or_create", content: "created" }]);
    const byName = manager().getPendingSelfManagedWriteRejectionVisibleText(session, "Done.");
    expect(byName).toContain("Execution stopped"); // the heuristic reads "get" as read-only
    const byMeta = manager().getPendingSelfManagedWriteRejectionVisibleText(session, "Done.", () => true);
    expect(byMeta).toBeNull();
  });

  it("says nothing for an empty draft, which is a boundary and not an acknowledgement", () => {
    // A bare DONE/CONTINUE reflection normalizes to empty. The old guard let
    // that through and reported a stop that had not happened.
    expect(manager().getPendingSelfManagedWriteRejectionVisibleText(sessionWith(REJECTION), "")).toBeNull();
    expect(manager().getPendingSelfManagedWriteRejectionVisibleText(sessionWith(REJECTION), "DONE")).toBeNull();
  });
});
