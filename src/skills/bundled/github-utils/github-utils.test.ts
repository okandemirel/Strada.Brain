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
    expect(mockExecFileNoThrow).toHaveBeenCalledWith("gh", ["pr", "status"], 15_000);
  });

  it("passes extra args when provided", async () => {
    mockExecFileNoThrow.mockResolvedValue({ exitCode: 0, stdout: "ok", stderr: "" });

    await tool.execute({ args: "--json state" }, dummyContext);
    expect(mockExecFileNoThrow).toHaveBeenCalledWith("gh", ["pr", "status", "--json", "state"], 15_000);
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
    expect(mockExecFileNoThrow).toHaveBeenCalledWith("gh", ["issue", "list", "--limit", "10"], 15_000);
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
      ["issue", "list", "--limit", "10", "--label", "bug"],
      15_000,
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
    expect(mockExecFileNoThrow).toHaveBeenCalledWith("gh", ["repo", "view"], 15_000);
  });

  it("passes extra args when provided", async () => {
    mockExecFileNoThrow.mockResolvedValue({ exitCode: 0, stdout: "ok", stderr: "" });

    await tool.execute({ args: "--json name" }, dummyContext);
    expect(mockExecFileNoThrow).toHaveBeenCalledWith("gh", ["repo", "view", "--json", "name"], 15_000);
  });

  it("returns error message on non-zero exit", async () => {
    mockExecFileNoThrow.mockResolvedValue({ exitCode: 128, stdout: "", stderr: "fatal: not a git repo" });

    const result = await tool.execute({}, dummyContext);
    expect(result.content).toContain("failed");
    expect(result.content).toContain("exit 128");
  });
});
