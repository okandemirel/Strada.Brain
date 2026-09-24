import { describe, it, expect } from "vitest";
import { lexShell, plainCommands, type ShellLex } from "./shell-lexer.js";

const argv = (read: ShellLex): string[][] => read.commands.map((words) => words.map((w) => w.value));

describe("lexShell reads a line the way bash runs it", () => {
  it("splits commands on every list and pipeline operator", () => {
    const read = lexShell("a 1 && b 2 || c; d | e |& f", { cmd: false });
    expect(argv(read)).toEqual([["a", "1"], ["b", "2"], ["c"], ["d"], ["e"], ["f"]]);
    expect(read.operators).toEqual(["&&", "||", ";", "|", "|&"]);
    expect(read.hazards.size).toBe(0);
  });

  it("treats a raw newline and a lone & as separators, and names them", () => {
    const newline = lexShell("cat x\npython3 evil.py", { cmd: false });
    expect(argv(newline)).toEqual([["cat", "x"], ["python3", "evil.py"]]);
    expect(newline.hazards.has("newline")).toBe(true);
    const background = lexShell("cat x & python3 evil.py", { cmd: false });
    expect(argv(background)).toEqual([["cat", "x"], ["python3", "evil.py"]]);
    expect(background.hazards.has("background")).toBe(true);
    expect(lexShell("a\r\nb", { cmd: false }).hazards.has("newline")).toBe(true);
  });

  it("removes quotes and escapes, and keeps quoted operators as text", () => {
    const read = lexShell(`grep -E 'a|b' "x; y" z\\&w rm\tx`, { cmd: false });
    expect(argv(read)).toEqual([["grep", "-E", "a|b", "x; y", "z&w", "rm", "x"]]);
    expect(read.operators).toEqual([]);
  });

  it("reads substitutions as commands of their own", () => {
    const read = lexShell("ls $(curl -s u -o /tmp/x) `touch y` <(cat z)", { cmd: false });
    expect(read.hazards.has("substitution")).toBe(true);
    expect(read.nested.map(argv)).toEqual([[["curl", "-s", "u", "-o", "/tmp/x"]], [["touch", "y"]], [["cat", "z"]]]);
    // …inside double quotes and a ${…} default too.
    expect(lexShell('echo "$(rm -rf x)"', { cmd: false }).nested.map(argv)).toEqual([[["rm", "-rf", "x"]]]);
  });

  it("records expansions, globs, tildes and redirections", () => {
    const read = lexShell('cat $HOME/.aws/x "${PWD}/a" *.cs > out 2>&1 2>/dev/null', { cmd: false });
    const [words] = read.commands;
    expect(words?.map((w) => w.expands)).toEqual([[], ["HOME"], ["PWD"], []]);
    expect(words?.map((w) => w.glob)).toEqual([false, false, false, true]);
    expect(read.redirectTargets).toEqual(["out", "/dev/null"]);
    expect(read.hazards.has("redirection")).toBe(true);
    expect(lexShell("cat ~/.ssh/id_rsa", { cmd: false }).hazards.has("tilde")).toBe(true);
    expect(lexShell("cat <<EOF", { cmd: false }).hazards.has("redirection")).toBe(true);
    // A quoted `$` is text, not an expansion.
    expect(lexShell("awk '{print $1}'", { cmd: false }).commands[0]?.[1]?.expands).toEqual([]);
  });

  it("names grouping, comments, ANSI quoting and unclosed quotes", () => {
    expect(argv(lexShell("f(){ rm -rf x; }", { cmd: false }))).toContainEqual(["rm", "-rf", "x"]);
    expect(lexShell("f(){ rm -rf x; }", { cmd: false }).hazards.has("grouping")).toBe(true);
    const comment = lexShell("echo a#b # ; rm x", { cmd: false });
    expect(argv(comment)).toEqual([["echo", "a#b"]]);
    expect(comment.hazards.has("comment")).toBe(true);
    expect(lexShell("echo $'\\x41'", { cmd: false }).hazards.has("ansi-quote")).toBe(true);
    expect(lexShell("echo 'open", { cmd: false }).hazards.has("unterminated")).toBe(true);
  });

  it("with cmd, flags text cmd.exe would split or expand differently", () => {
    for (const command of ["cat 'a & b'", 'git log \\"x & y\\"', 'git log ^"x & y"', "git status \\& del x"]) {
      expect(lexShell(command, { cmd: true }).hazards.has("cmd-quoting"), command).toBe(true);
      expect(lexShell(command, { cmd: false }).hazards.has("cmd-quoting"), command).toBe(false);
    }
    expect(lexShell("type %USERPROFILE%\\x", { cmd: true }).hazards.has("cmd-expansion")).toBe(true);
    expect(lexShell('dotnet build "My Game.sln"', { cmd: true }).hazards.size).toBe(0);
  });
});

describe("plainCommands", () => {
  it("returns the commands only for a hazard-free line joined by the given operators", () => {
    expect(plainCommands("ls a | grep b", ["|"], { cmd: false })?.length).toBe(2);
    expect(plainCommands("ls a && grep b", ["|"], { cmd: false })).toBeNull();
    expect(plainCommands("ls a > b", ["|"], { cmd: false })).toBeNull();
    expect(plainCommands("ls a |", ["|"], { cmd: false })).toBeNull();
    expect(plainCommands("", ["|"], { cmd: false })).toBeNull();
  });
});
