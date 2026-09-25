import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Mock execFileNoThrow before importing the module under test
// ---------------------------------------------------------------------------

const mockExecFileNoThrow = vi.fn();

vi.mock("../../../utils/execFileNoThrow.js", () => ({
  execFileNoThrow: (...args: unknown[]) => mockExecFileNoThrow(...args),
}));

// Must import *after* vi.mock so the mock is in place.
const { tools } = await import("./index.js");

const dummyContext = {} as Parameters<(typeof tools)[0]["execute"]>[1];
/** execFileNoThrow's options when the context names no project. */
const NO_CWD = { cwd: undefined };

function findTool(name: string) {
  const tool = tools.find((t) => t.name === name);
  if (!tool) throw new Error(`Tool "${name}" not found`);
  return tool;
}

beforeEach(() => {
  mockExecFileNoThrow.mockReset();
});

// ---------------------------------------------------------------------------
// gh_pr_status
// ---------------------------------------------------------------------------

describe("gh_pr_status", () => {
  const tool = findTool("gh_pr_status");

  it("returns gh pr status output on success", async () => {
    mockExecFileNoThrow.mockResolvedValue({
      exitCode: 0,
      stdout: "Current branch\n  #42 My PR [OPEN]\n",
      stderr: "",
    });

    const result = await tool.execute({}, dummyContext);
    expect(result.content).toContain("#42 My PR");
    expect(mockExecFileNoThrow).toHaveBeenCalledWith("gh", ["pr", "status"], 15_000, undefined, NO_CWD);
  });

  it("passes extra args when provided", async () => {
    mockExecFileNoThrow.mockResolvedValue({ exitCode: 0, stdout: "ok", stderr: "" });

    await tool.execute({ args: "--json state" }, dummyContext);
    expect(mockExecFileNoThrow).toHaveBeenCalledWith("gh", ["pr", "status", "--json=state"], 15_000, undefined, NO_CWD);
  });

  it("returns error message on non-zero exit", async () => {
    mockExecFileNoThrow.mockResolvedValue({ exitCode: 1, stdout: "", stderr: "not a git repo" });

    const result = await tool.execute({}, dummyContext);
    expect(result.content).toContain("failed");
    expect(result.content).toContain("not a git repo");
  });
});

// ---------------------------------------------------------------------------
// gh_issue_list
// ---------------------------------------------------------------------------

describe("gh_issue_list", () => {
  const tool = findTool("gh_issue_list");

  it("returns issue list on success", async () => {
    mockExecFileNoThrow.mockResolvedValue({
      exitCode: 0,
      stdout: "#1\tBug report\tOPEN\n#2\tFeature request\tOPEN\n",
      stderr: "",
    });

    const result = await tool.execute({}, dummyContext);
    expect(result.content).toContain("Bug report");
    expect(mockExecFileNoThrow).toHaveBeenCalledWith("gh", ["issue", "list", "--limit", "10"], 15_000, undefined, NO_CWD);
  });

  it("returns fallback text when no issues exist", async () => {
    mockExecFileNoThrow.mockResolvedValue({ exitCode: 0, stdout: "", stderr: "" });

    const result = await tool.execute({}, dummyContext);
    expect(result.content).toBe("No open issues.");
  });

  it("passes extra args when provided", async () => {
    mockExecFileNoThrow.mockResolvedValue({ exitCode: 0, stdout: "ok", stderr: "" });

    await tool.execute({ args: "--label bug" }, dummyContext);
    expect(mockExecFileNoThrow).toHaveBeenCalledWith(
      "gh",
      ["issue", "list", "--limit", "10", "--label=bug"],
      15_000,
      undefined,
      NO_CWD,
    );
  });

  it("returns error message on non-zero exit", async () => {
    mockExecFileNoThrow.mockResolvedValue({ exitCode: 1, stdout: "", stderr: "auth required" });

    const result = await tool.execute({}, dummyContext);
    expect(result.content).toContain("failed");
    expect(result.content).toContain("auth required");
  });
});

// ---------------------------------------------------------------------------
// gh_repo_view
// ---------------------------------------------------------------------------

describe("gh_repo_view", () => {
  const tool = findTool("gh_repo_view");

  it("returns repo info on success", async () => {
    mockExecFileNoThrow.mockResolvedValue({
      exitCode: 0,
      stdout: "owner/repo\nA great repository\n",
      stderr: "",
    });

    const result = await tool.execute({}, dummyContext);
    expect(result.content).toContain("owner/repo");
    expect(mockExecFileNoThrow).toHaveBeenCalledWith("gh", ["repo", "view"], 15_000, undefined, NO_CWD);
  });

  it("passes extra args when provided", async () => {
    mockExecFileNoThrow.mockResolvedValue({ exitCode: 0, stdout: "ok", stderr: "" });

    await tool.execute({ args: "--json name" }, dummyContext);
    expect(mockExecFileNoThrow).toHaveBeenCalledWith("gh", ["repo", "view", "--json=name"], 15_000, undefined, NO_CWD);
  });

  it("returns error message on non-zero exit", async () => {
    mockExecFileNoThrow.mockResolvedValue({ exitCode: 128, stdout: "", stderr: "fatal: not a git repo" });

    const result = await tool.execute({}, dummyContext);
    expect(result.content).toContain("failed");
    expect(result.content).toContain("exit 128");
  });
});

// ---------------------------------------------------------------------------
// SEC-18: the project's repository, and only the flags each tool needs.
// ---------------------------------------------------------------------------

describe("gh tools stay on the project's repository (SEC-18)", () => {
  const projectContext = { projectPath: "/work/game" } as Parameters<(typeof tools)[0]["execute"]>[1];

  it("runs gh in the project directory", async () => {
    mockExecFileNoThrow.mockResolvedValue({ exitCode: 0, stdout: "ok", stderr: "" });
    for (const tool of tools) await tool.execute({}, projectContext);
    expect(mockExecFileNoThrow).toHaveBeenCalledTimes(3);
    for (const call of mockExecFileNoThrow.mock.calls) {
      expect(call[4]).toEqual({ cwd: "/work/game" });
    }
  });

  it.each([
    ["gh_repo_view", "-R other-org/private-repo"],
    ["gh_repo_view", "--repo=other-org/private-repo"],
    ["gh_repo_view", "other-org/private-repo"],
    ["gh_repo_view", "--web"],
    ["gh_issue_list", "--repo other-org/private-repo"],
    ["gh_issue_list", "-w"],
    ["gh_pr_status", "-R other-org/private-repo"],
    ["gh_issue_list", "--label"],
    ["gh_issue_list", "--search \"unterminated"],
    ["gh_pr_status", "--conflict-status=yes"],
  ])("%s refuses args %j without running gh", async (name, args) => {
    const result = await findTool(name).execute({ args }, projectContext);
    expect(result.isError).toBe(true);
    expect(mockExecFileNoThrow).not.toHaveBeenCalled();
  });

  it.each([
    ["gh_issue_list", "-L 5 --state closed", ["--limit=5", "--state=closed"]],
    ["gh_issue_list", "--search \"is:open label:bug\"", ["--search=is:open label:bug"]],
    ["gh_issue_list", "--label=-R", ["--label=-R"]],
    ["gh_issue_list", "--label='needs review'", ["--label=needs review"]],
    ["gh_pr_status", "-c --json state", ["--conflict-status", "--json=state"]],
    ["gh_repo_view", "-b main --jq .name", ["--branch=main", "--jq=.name"]],
  ])("%s passes allowed args %j as %j", async (name, args, expected) => {
    mockExecFileNoThrow.mockResolvedValue({ exitCode: 0, stdout: "ok", stderr: "" });
    await findTool(name).execute({ args }, projectContext);
    const argv = mockExecFileNoThrow.mock.calls[0]![1] as string[];
    expect(argv.slice(-expected.length)).toEqual(expected);
  });
});
