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

/** What shell_exec returns for a command that exited 0: its own footer, then the output. */
function shellOk(command: string, stdout = "ok"): string {
  return `$ ${command}\nExit code: 0 | Duration: 1ms\n\n--- stdout ---\n${stdout}`;
}

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
  function sessionAfterRejection(later: Array<{ name: string; content: string; is_error?: boolean; input?: Record<string, unknown> }>) {
    return {
      messages: [
        { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "shell_exec", input: {} }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: REJECTION }] },
        {
          role: "assistant",
          content: later.map((l, i) => ({ type: "tool_use", id: `t${i + 2}`, name: l.name, input: l.input ?? {} })),
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

  it("an INSPECTION through a write-capable tool is not the replacement (Codex 2026-09-17 #3)", () => {
    // shell_exec can write, but `git status` did not; neither did a stash
    // listing. Both cleared the rejection.
    const gitStatus = sessionAfterRejection([{ name: "shell_exec", content: shellOk("git status", "On branch main"), input: { command: "git status" } }]);
    expect(manager().getPendingSelfManagedWriteRejectionVisibleText(gitStatus, "Done.", () => true)).toContain("Execution stopped");
    const stashList = sessionAfterRejection([{ name: "git_stash", content: "stash@{0}: WIP", input: { action: "list" } }]);
    expect(manager().getPendingSelfManagedWriteRejectionVisibleText(stashList, "Done.", () => true)).toContain("Execution stopped");
    const lsChain = sessionAfterRejection([{ name: "shell_exec", content: shellOk("cd Assets && ls -la | head", "…"), input: { command: "cd Assets && ls -la | head" } }]);
    expect(manager().getPendingSelfManagedWriteRejectionVisibleText(lsChain, "Done.", () => true)).toContain("Execution stopped");
    // …while a narrower shell WRITE is exactly the replacement the review asked for.
    const sedWrite = sessionAfterRejection([{ name: "shell_exec", content: shellOk("sed -i '' 's/a/b/' Assets/Scripts/Hud.cs"), input: { command: "sed -i '' 's/a/b/' Assets/Scripts/Hud.cs" } }]);
    expect(manager().getPendingSelfManagedWriteRejectionVisibleText(sedWrite, "Done.", () => true)).toBeNull();
    const redirect = sessionAfterRejection([{ name: "shell_exec", content: shellOk("echo x > notes.txt"), input: { command: "echo x > notes.txt" } }]);
    expect(manager().getPendingSelfManagedWriteRejectionVisibleText(redirect, "Done.", () => true)).toBeNull();
  });

  it("only POSITIVE mutation evidence resolves it; unknown and inspecting commands do not (Codex 2026-09-17 #4/#5)", () => {
    const stopped = (command: string): void => {
      const s = sessionAfterRejection([{ name: "shell_exec", content: shellOk(command), input: { command } }]);
      expect(manager().getPendingSelfManagedWriteRejectionVisibleText(s, "Done.", () => true), command).toContain("Execution stopped");
    };
    const resolved = (command: string): void => {
      const s = sessionAfterRejection([{ name: "shell_exec", content: shellOk(command), input: { command } }]);
      expect(manager().getPendingSelfManagedWriteRejectionVisibleText(s, "Done.", () => true), command).toBeNull();
    };
    // Inspections and unknowns: not a replacement.
    stopped("git -C . status");
    stopped("git status > /dev/null");
    stopped("sed -n 1,20p package.json");
    stopped('python -c "print(1)"');
    stopped("git branch -a");
    stopped("git tag -l");
    stopped("git remote -v");
    stopped("dotnet --list-sdks");
    stopped("npm ls");
    // Real writes: a replacement.
    resolved("git branch fix/hud");
    resolved("git tag v1.0");
    resolved("git remote add origin https://x/y.git");
    resolved("env sed -i s/a/b/ X.cs");
    resolved('find Assets -name "*.tmp" -delete');
    resolved("git add -A && git commit -m x");
    resolved("git -C . apply fix.patch");
    resolved("dotnet build");
    resolved("npm run build");
    resolved("cat a | xargs rm");
    // Round two (Codex 2026-09-17): quoting, descriptor duplication and
    // program-specific arguments.
    stopped('printf "a > b"');
    stopped('echo "x; touch ignored"');
    stopped("git status 2>&1");
    stopped("git status >> /dev/null");
    stopped("npm run lint");
    stopped("dotnet test --no-build");
    stopped("curl -I https://example.com");
    stopped("tar -tf archive.tar");
    stopped("find Assets -exec cat {} +");
    resolved("npm run build");
    resolved("curl -o out.zip https://example.com/a.zip");
    resolved("tar -xf archive.tar");
    resolved("find Assets -name '*.tmp' -exec rm {} +");
    resolved('"/Applications/Unity/Unity.exe" -batchmode -executeMethod Builder.Build');
    resolved("cat list | xargs -0 rm");
  });

  it("counts only the shell segments that PROVABLY ran, and reads inline interpreter bodies (Codex wave 0-A review 2026-09-17 finding #5)", () => {
    // The detector split on `&&`, `||`, `;` and `|` alike and accepted any
    // mutating segment, so `true || touch x` (exit 0, nothing written)
    // cleared a rejection. And `python3 -c "…write_text(…)"` — a bounded
    // replacement that DID write — was not recognised, so "Done." stayed
    // blocked and the run entered keep-alive.
    const stopped = (command: string): void => {
      const s = sessionAfterRejection([{ name: "shell_exec", content: shellOk(command), input: { command } }]);
      expect(manager().getPendingSelfManagedWriteRejectionVisibleText(s, "Done.", () => true), command).toContain("Execution stopped");
    };
    const resolved = (command: string): void => {
      const s = sessionAfterRejection([{ name: "shell_exec", content: shellOk(command), input: { command } }]);
      expect(manager().getPendingSelfManagedWriteRejectionVisibleText(s, "Done.", () => true), command).toBeNull();
    };
    // Skipped branches: exit 0 does not say the write ran.
    stopped("true || touch Assets/level3.json");
    stopped("false && touch Assets/level3.json");
    stopped("test -f a && touch x || echo fallback");
    stopped("echo touch x");
    // Provably ran: exit 0 forces every `&&` segment; `false ||` forces its alternative.
    resolved("mkdir -p d && touch d/x");
    resolved("false || touch x");
    // Exit 0 cannot say whether the segment before `|| true` SUCCEEDED, and
    // the detector does not pretend to know (Codex 2026-09-17 on 2df6170e #5).
    stopped("cp a b || true");
    // `&&`/`||` are left-associative: `(git status || true) && touch x`, so
    // exit 0 proves `touch x` ran and succeeded (Codex 2026-09-17 round 3 #15).
    resolved("git status || true && touch x");
    resolved("cat in | tee out");
    resolved("ls; touch x");
    resolved("ls\ntouch x");
    // Inline interpreter bodies: the body decides, not the interpreter.
    resolved(`python3 -c "from pathlib import Path; Path('Assets/level3.json').write_text('{}')"`);
    resolved(`python3 -c "with open('Assets/level3.json', 'w') as f: f.write('{}')"`);
    resolved(`node -e "require('fs').writeFileSync('Assets/level3.json','{}')"`);
    resolved(`/usr/bin/python3.12 -c "import os; os.remove('Assets/level3.json')"`);
    stopped(`python3 -c "import json; print(json.load(open('Assets/level3.json')))"`);
    stopped(`node -e "console.log(require('fs').readFileSync('Assets/level3.json','utf8'))"`);
    stopped("python3 script.py");
  });

  it("infers only what exit 0 proves: the last statement, the succeeded segments, the flat grammar (Codex 2026-09-17 on 2df6170e #3-#7)", () => {
    const stopped = (command: string): void => {
      const s = sessionAfterRejection([{ name: "shell_exec", content: shellOk(command), input: { command } }]);
      expect(manager().getPendingSelfManagedWriteRejectionVisibleText(s, "Done.", () => true), command).toContain("Execution stopped");
    };
    const resolved = (command: string): void => {
      const s = sessionAfterRejection([{ name: "shell_exec", content: shellOk(command), input: { command } }]);
      expect(manager().getPendingSelfManagedWriteRejectionVisibleText(s, "Done.", () => true), command).toBeNull();
    };
    // #3: exit 0 is the LAST statement's; an earlier statement's failure is masked.
    stopped("test -d /__absent__ && touch x; true");
    resolved("mkdir -p d; touch d/x");
    // #5: "ran" is not "succeeded".
    stopped("touch /missing-parent/x || true");
    stopped("true; touch /missing-parent/x || true");
    stopped("tee </dev/null");
    stopped("touch x | cat"); // only the last stage's status is known
    resolved("false || touch x");
    resolved("cat in | tee out");
    // #4: syntax this inference does not read proves nothing.
    stopped("(false && touch x); true");
    stopped("{ false && touch x; }; true");
    stopped("false && \\\ntouch x; true");
    stopped("if false; then\ntouch x\nfi");
    stopped("for i in; do\ntouch x\ndone");
    stopped("cat <<EOF\ntouch x\nEOF");
    stopped("echo $(false && touch x); true");
    // …and when the construct IS the last statement, only the grammar check stands between it and a false accept.
    stopped("(false && touch x)");
    stopped("false && \\\ntouch x");
    stopped("echo $(false && touch x)");
    stopped("python3 - <<EOF\nopen('x','w').write('1')\nEOF");
    // …but the placeholders find and xargs use are not groups.
    resolved("find . -name '*.tmp' -exec touch {} \;");
    resolved("echo a | xargs -I{} touch {}");
    // #6: a read-only shutil call is not a write.
    stopped(`python3 -c "import shutil; print(shutil.which('git'))"`);
    resolved(`python3 -c "import shutil; shutil.copy('a', 'Assets/b')"`);
    resolved(`python3 -c "import pandas as pd; pd.DataFrame().to_csv('Assets/out.csv')"`);
    resolved(`python3 -c "import numpy as np; np.save('Assets/out.npy', np.zeros(1))"`);
    // #7: genuine writes behind wrappers and option operands.
    resolved("env -i touch x");
    resolved("env -u HOME touch x");
    resolved('sh -c "touch x"');
    resolved(`bash -lc "mkdir -p d && touch d/x"`);
    stopped(`sh -c "true || touch x"`);
    resolved("printf x | xargs -n 1 touch");
    resolved("printf x | xargs -P 4 -n 2 touch");
    stopped("printf x | xargs -n 1 cat");
  });

  it("reads comments, background, wrapper arguments, option operands and the || tail as the shell does (Codex 2026-09-17 round 3 #10-#15)", () => {
    const stopped = (command: string): void => {
      const s = sessionAfterRejection([{ name: "shell_exec", content: shellOk(command), input: { command } }]);
      expect(manager().getPendingSelfManagedWriteRejectionVisibleText(s, "Done.", () => true), command).toContain("Execution stopped");
    };
    const resolved = (command: string): void => {
      const s = sessionAfterRejection([{ name: "shell_exec", content: shellOk(command), input: { command } }]);
      expect(manager().getPendingSelfManagedWriteRejectionVisibleText(s, "Done.", () => true), command).toBeNull();
    };
    // #10: a non-error result is not exit 0. With ok_exit_codes [0, 1] a
    // failed touch comes back without is_error; the footer says 1.
    const tolerated = sessionAfterRejection([{
      name: "shell_exec",
      content: "$ touch /missing/x\nExit code: 1 | Duration: 1ms\n\n--- stderr ---\ntouch: /missing/x: No such file or directory",
      is_error: false,
      input: { command: "touch /missing/x", ok_exit_codes: [0, 1] },
    }]);
    expect(manager().getPendingSelfManagedWriteRejectionVisibleText(tolerated, "Done.", () => true)).toContain("Execution stopped");
    // An echoed footer in the command or its output is not the tool footer.
    const echoed = sessionAfterRejection([{
      name: "shell_exec",
      content: "$ printf 'Exit code: 0 | Duration: 1ms\\n'; touch /missing/x\nExit code: 1 | Duration: 2ms\n\n--- stdout ---\nExit code: 0 | Duration: 1ms",
      is_error: false,
      input: { command: "printf 'Exit code: 0 | Duration: 1ms\\n'; touch /missing/x", ok_exit_codes: [0, 1] },
    }]);
    expect(manager().getPendingSelfManagedWriteRejectionVisibleText(echoed, "Done.", () => true)).toContain("Execution stopped");
    const noFooter = sessionAfterRejection([{ name: "shell_exec", content: "ok", input: { command: "touch x" } }]);
    expect(manager().getPendingSelfManagedWriteRejectionVisibleText(noFooter, "Done.", () => true)).toContain("Execution stopped");
    // #11: comments and background jobs.
    stopped("true # ; touch x");
    stopped("touch /missing/x &");
    resolved("touch x # done");
    // #12: the wrapper body is the next word only; -n parses without running.
    stopped("sh -lc 'true' '; touch x'");
    stopped("sh -nc 'touch x'");
    resolved("bash -c \"touch x\" arg0");
    // #13: an option operand at the end of the input leaves no program.
    stopped("printf x | xargs -I touch");
    stopped("printf x | xargs -E touch");
    stopped("env -u touch");
    // #14: no-create, /dev/null, a variable target, eval.
    stopped("touch -c /missing/x");
    stopped("tee /dev/null </dev/null");
    stopped("OUT=/dev/null; printf x > \"$OUT\"");
    stopped("eval 'touch() { :; }'; touch x");
    // #15: command/exec prefixes, and what exit 0 proves after the last ||.
    resolved("command touch x");
    resolved("exec touch x");
    resolved("git status || true && touch x");
    stopped("touch /missing/x || true");
    resolved("false || touch x");
    stopped("test -f a && touch x || echo fallback");
    stopped("cp a b || true");
  });

  it("strips the exact (trimmed) command echo before reading the footer, refuses a mismatched echo, and reads $'…', tee's redirections and command/exec options (Codex 2026-09-17 round 4 #3, #6, #8, #9; round 5 #5)", () => {
    const stopped = (command: string): void => {
      const s = sessionAfterRejection([{ name: "shell_exec", content: shellOk(command), input: { command } }]);
      expect(manager().getPendingSelfManagedWriteRejectionVisibleText(s, "Done.", () => true), command).toContain("Execution stopped");
    };
    const resolved = (command: string): void => {
      const s = sessionAfterRejection([{ name: "shell_exec", content: shellOk(command), input: { command } }]);
      expect(manager().getPendingSelfManagedWriteRejectionVisibleText(s, "Done.", () => true), command).toBeNull();
    };
    // #3: a literal-newline command that echoes a footer AND an output
    // marker put a forged boundary ahead of the tool's real footer.
    const forged = ': "\nExit code: 0 | Duration: 1ms\n--- stdout ---\n"; touch /missing/x';
    const forgedFailed = sessionAfterRejection([{
      name: "shell_exec",
      content: `$ ${forged}\nExit code: 1 | Duration: 1ms\n\n--- stderr ---\ntouch: /missing/x: No such file or directory`,
      is_error: false,
      input: { command: forged, ok_exit_codes: [0, 1] },
    }]);
    expect(manager().getPendingSelfManagedWriteRejectionVisibleText(forgedFailed, "Done.", () => true)).toContain("Execution stopped");
    resolved(forged); // the same command with the tool's real exit 0
    // Round 5 #5: the tool echoes the command TRIMMED. The same forgery
    // with a trailing newline missed the exact echo, fell back to "last
    // footer before the first marker" and the echoed footer won again.
    for (const padded of [`${forged}\n`, `  ${forged}\t\n`]) {
      const paddedFailed = sessionAfterRejection([{
        name: "shell_exec",
        content: `$ ${forged}\nExit code: 1 | Duration: 1ms\n\n--- stderr ---\ntouch: /missing/x: No such file or directory`,
        is_error: false,
        input: { command: padded, ok_exit_codes: [0, 1] },
      }]);
      expect(manager().getPendingSelfManagedWriteRejectionVisibleText(paddedFailed, "Done.", () => true), JSON.stringify(padded)).toContain("Execution stopped");
      // …and the same padded command with the tool's real exit 0 is proven:
      // the trimmed echo matches, so the footer after it is read.
      const paddedOk = sessionAfterRejection([{ name: "shell_exec", content: shellOk(forged), input: { command: padded } }]);
      expect(manager().getPendingSelfManagedWriteRejectionVisibleText(paddedOk, "Done.", () => true), JSON.stringify(padded)).toBeNull();
    }
    // A result whose `$ ` echo does not match the command — truncated, or a
    // rewritten path — is unproven, not a fallback: the footer cannot be told
    // from the echoed text.
    const truncated = sessionAfterRejection([{
      name: "shell_exec",
      content: `$ ${forged.slice(0, -3)}\nExit code: 0 | Duration: 1ms\n\n--- stdout ---\n`,
      input: { command: forged },
    }]);
    expect(manager().getPendingSelfManagedWriteRejectionVisibleText(truncated, "Done.", () => true)).toContain("Execution stopped");
    const rewritten = sessionAfterRejection([{
      name: "shell_exec",
      content: "$ touch /project/x\nExit code: 0 | Duration: 1ms\n\n--- stdout ---\nok",
      input: { command: "touch /tmp/x" },
    }]);
    expect(manager().getPendingSelfManagedWriteRejectionVisibleText(rewritten, "Done.", () => true)).toContain("Execution stopped");
    // Only a result carrying no echo at all (a batch child) reads the last
    // footer before the first marker.
    const batchChild = sessionAfterRejection([{
      name: "shell_exec",
      content: "Exit code: 0 | Duration: 1ms\n\n--- stdout ---\nExit code: 1 | Duration: 1ms",
      input: { command: "touch x" },
    }]);
    expect(manager().getPendingSelfManagedWriteRejectionVisibleText(batchChild, "Done.", () => true)).toBeNull();
    // #6: ANSI-C quoting is not decoded; `--` ends touch's options.
    stopped("touch $'-c' /missing/x");
    resolved("touch -- -c");
    // #8: an input redirection's file is not a tee operand.
    stopped("tee /dev/null < package.json");
    stopped("tee /dev/null <package.json 2>/dev/null");
    resolved("tee out < package.json");
    // #9: wrapper options precede the program; -v/-V inspect.
    resolved("command -p touch x");
    resolved("exec -a x touch x");
    resolved("exec -cl touch x");
    stopped("command -v touch");
    stopped("command -V touch");
    stopped("exec -a touch");
  });

  it("the metadata-less default treats an unknown name as NOT a writer (Codex 2026-09-17 #4)", () => {
    for (const name of ["learning_stats", "code_quality", "show_plan", "ask_user", "unity_delivery_measure", "speech_to_text", "dotnet_build", "dotnet_test"]) {
      const session = sessionAfterRejection([{ name, content: "ok" }]);
      expect(manager().getPendingSelfManagedWriteRejectionVisibleText(session, "Done."), name).toContain("Execution stopped");
    }
    for (const name of ["file_write", "git_branch", "git_push", "obsidian_append", "vault_init", "vault_sync", "rag_index", "switch_personality", "browser_automation", "unity_place_prefab"]) {
      const writer = sessionAfterRejection([{ name, content: "ok" }]);
      expect(manager().getPendingSelfManagedWriteRejectionVisibleText(writer, "Done."), name).toBeNull();
    }
  });

  it("says nothing for an empty draft, which is a boundary and not an acknowledgement", () => {
    // A bare DONE/CONTINUE reflection normalizes to empty. The old guard let
    // that through and reported a stop that had not happened.
    expect(manager().getPendingSelfManagedWriteRejectionVisibleText(sessionWith(REJECTION), "")).toBeNull();
    expect(manager().getPendingSelfManagedWriteRejectionVisibleText(sessionWith(REJECTION), "DONE")).toBeNull();
  });
});
