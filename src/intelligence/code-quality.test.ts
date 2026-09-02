import { describe, it, expect } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  analyzeFile,
  analyzeProject,
  formatQualityReport,
  FileNotAnalyzedError,
  type ProjectQualityReport,
} from "./code-quality.js";

vi.mock("../utils/logger.js", () => ({
  getLoggerSafe: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  getLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

describe("analyzeFile", () => {
  it("returns 100 score for clean simple class", () => {
    const code = `
namespace Game.Core
{
    public class SimpleService : ISimpleService
    {
        private readonly ILogger _logger;

        public SimpleService(ILogger logger)
        {
            _logger = logger;
        }

        public void Execute()
        {
            _logger.Info("Executing");
        }
    }
}`;
    const report = analyzeFile(code, "SimpleService.cs");
    expect(report.score).toBeGreaterThanOrEqual(90);
    expect(report.issues.filter((i) => i.severity === "error")).toHaveLength(0);
  });

  it("detects god class with too many methods", () => {
    let methods = "";
    for (let i = 0; i < 25; i++) {
      methods += `    public void Method${i}() { }\n`;
    }
    const code = `public class GodClass {\n${methods}}`;

    const report = analyzeFile(code, "GodClass.cs");
    const godIssue = report.issues.find((i) => i.rule === "god-class-methods");
    expect(godIssue).toBeDefined();
    expect(godIssue!.severity).toBe("warning");
  });

  it("detects god class with too many fields", () => {
    let fields = "";
    for (let i = 0; i < 20; i++) {
      fields += `    private int _field${i};\n`;
    }
    const code = `public class BloatedClass {\n${fields}}`;

    const report = analyzeFile(code, "BloatedClass.cs");
    const issue = report.issues.find((i) => i.rule === "god-class-fields");
    expect(issue).toBeDefined();
  });

  it("detects too many constructor dependencies", () => {
    const code = `
public class Overloaded {
    public Overloaded(IServiceA a, IServiceB b, IServiceC c, IServiceD d, IServiceE e, IServiceF f, IServiceG g) { }
}`;
    const report = analyzeFile(code, "Overloaded.cs");
    const issue = report.issues.find((i) => i.rule === "too-many-dependencies");
    expect(issue).toBeDefined();
    expect(issue!.severity).toBe("warning");
  });

  it("detects empty catch block", () => {
    const code = `
public class A {
    public void Do() {
        try { } catch { }
    }
}`;
    const report = analyzeFile(code, "A.cs");
    const issue = report.issues.find((i) => i.rule === "empty-catch");
    expect(issue).toBeDefined();
    expect(issue!.severity).toBe("warning");
  });

  it("detects ECS component with reference type field", () => {
    const code = `
public struct BadComponent : IComponent {
    public string Name;
    public float Value;
}`;
    const report = analyzeFile(code, "BadComponent.cs");
    const issue = report.issues.find((i) => i.rule === "component-reference-type");
    expect(issue).toBeDefined();
    expect(issue!.severity).toBe("error");
    expect(issue!.category).toBe("strada-specific");
  });

  it("detects system without EntityQuery", () => {
    const code = `
public class EmptySystem : SystemBase {
    public override void OnUpdate(float dt) {
    }
}`;
    const report = analyzeFile(code, "EmptySystem.cs");
    const issue = report.issues.find((i) => i.rule === "system-no-query");
    expect(issue).toBeDefined();
  });

  it("does not flag system that uses EntityQuery", () => {
    const code = `
public class GoodSystem : SystemBase {
    private EntityQuery _query;
    public override void OnCreate() {
        _query = World.CreateQuery().With<Health>().Build();
    }
    public override void OnUpdate(float dt) { }
}`;
    const report = analyzeFile(code, "GoodSystem.cs");
    const issue = report.issues.find((i) => i.rule === "system-no-query");
    expect(issue).toBeUndefined();
  });

  it("detects service without interface", () => {
    const code = `
public class PlayerService {
    public void DoStuff() { }
}`;
    const report = analyzeFile(code, "PlayerService.cs");
    const issue = report.issues.find((i) => i.rule === "service-no-interface");
    expect(issue).toBeDefined();
  });

  it("does not flag service with interface", () => {
    const code = `
public class PlayerService : IPlayerService {
    public void DoStuff() { }
}`;
    const report = analyzeFile(code, "PlayerService.cs");
    const issue = report.issues.find((i) => i.rule === "service-no-interface");
    expect(issue).toBeUndefined();
  });

  it("detects private field without underscore prefix", () => {
    const code = `
public class A {
    private int count;
}`;
    const report = analyzeFile(code, "A.cs");
    const issue = report.issues.find((i) => i.rule === "private-field-prefix");
    expect(issue).toBeDefined();
  });

  it("does not flag private field with underscore", () => {
    const code = `
public class A {
    private int _count;
}`;
    const report = analyzeFile(code, "A.cs");
    const issue = report.issues.find((i) => i.rule === "private-field-prefix");
    expect(issue).toBeUndefined();
  });

  it("detects multiple classes in one file", () => {
    const code = `
public class First { }
public class Second { }
`;
    const report = analyzeFile(code, "Multi.cs");
    const issue = report.issues.find((i) => i.rule === "multiple-classes-per-file");
    expect(issue).toBeDefined();
  });

  it("computes metrics accurately", () => {
    const code = `
public class MetricTest {
    private int _a;
    private string _b;
    public void M1() { }
    public void M2(int x, int y) { }
    public MetricTest(IService svc) { }
}`;
    const report = analyzeFile(code, "MetricTest.cs");
    expect(report.metrics.classCount).toBe(1);
    expect(report.metrics.methodCount).toBe(2);
    expect(report.metrics.fieldCount).toBe(2);
    expect(report.metrics.dependencyCount).toBe(1);
  });
});

describe("oversized files are reported as not analyzed, never as clean (audited 2026-09-02)", () => {
  // >1MB of a realistic generated shape: one god class, many long methods,
  // no numeric literals (so the raw-text rules stay quiet) — the exact shape
  // that used to come back "Score: 100/100, Issues: 0, Classes: 0".
  const oversized = (() => {
    let methods = "";
    for (let i = 0; i < 40; i++) {
      methods += `    public void Method${i}(string a, string b, string c, string d, string e, string f, string g)\n    {\n`;
      for (let j = 0; j < 70; j++) methods += `        Log(a + b + c + d + e + f + g);\n`;
      methods += "    }\n";
    }
    let code = `public class GeneratedGodService\n{\n${methods}}\n`;
    while (code.length <= 1024 * 1024) code += "// generated filler line that carries no numeric literal\n";
    return code;
  })();

  it("analyzeFile refuses to score a file the parser did not read", () => {
    expect(oversized.length).toBeGreaterThan(1024 * 1024);
    expect(() => analyzeFile(oversized, "Big.cs")).toThrow(FileNotAnalyzedError);
    try {
      analyzeFile(oversized, "Big.cs");
    } catch (err) {
      expect(err).toBeInstanceOf(FileNotAnalyzedError);
      expect((err as FileNotAnalyzedError).filePath).toBe("Big.cs");
      expect((err as FileNotAnalyzedError).message).toMatch(/1MB|1048576/);
      expect((err as FileNotAnalyzedError).message).toContain("not analyzed");
    }
  });

  it("analyzeProject names the skipped files and does not invent a 100 score for zero analyzed files", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cq-oversized-"));
    try {
      await writeFile(join(dir, "Big.cs"), oversized);
      const report = await analyzeProject(dir);
      expect(report.summary.totalFiles).toBe(0);
      expect(report.summary.skippedFiles).toHaveLength(1);
      expect(report.summary.skippedFiles[0]!.filePath).toBe("Big.cs");
      expect(report.summary.skippedFiles[0]!.reason).toMatch(/1MB|1048576/);
      expect(report.overallScore).toBeNull();

      const text = formatQualityReport(report);
      expect(text).not.toContain("100/100");
      expect(text).toContain("not measured");
      expect(text).toContain("Files Skipped (not analyzed): 1");
      expect(text).toContain("Big.cs");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("analyzeProject still scores the survivors but never lets Files Analyzed stand alone", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cq-mixed-"));
    try {
      await writeFile(join(dir, "Big.cs"), oversized);
      await writeFile(join(dir, "Small.cs"), "public class Small { public void Run() { } }");
      const report = await analyzeProject(dir);
      expect(report.summary.totalFiles).toBe(1);
      expect(report.summary.skippedFiles.map((s) => s.filePath)).toEqual(["Big.cs"]);
      expect(typeof report.overallScore).toBe("number");
      const text = formatQualityReport(report);
      expect(text).toContain("Files Analyzed: 1");
      expect(text).toContain("Files Skipped (not analyzed): 1");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("formatQualityReport", () => {
  it("formats a summary correctly", () => {
    const report: ProjectQualityReport = {
      overallScore: 85,
      fileReports: [],
      summary: {
        totalFiles: 10,
        totalIssues: 5,
        errorCount: 1,
        warningCount: 2,
        infoCount: 2,
        categoryBreakdown: { "anti-pattern": 3, "strada-specific": 2 },
        worstFiles: [{ filePath: "Bad.cs", score: 50 }],
        skippedFiles: [],
      },
      topIssues: [
        {
          severity: "error",
          category: "strada-specific",
          rule: "component-reference-type",
          message: "Component has ref field",
          filePath: "Bad.cs",
          line: 5,
          suggestion: "Use value types",
        },
      ],
    };

    const output = formatQualityReport(report);
    expect(output).toContain("85/100");
    expect(output).toContain("10");
    expect(output).toContain("1 errors");
    expect(output).toContain("Bad.cs");
    expect(output).toContain("Component has ref field");
    expect(output).toContain("Use value types");
  });
});
