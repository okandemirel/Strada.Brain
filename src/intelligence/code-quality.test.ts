import { describe, it, expect } from "vitest";
import { analyzeFile, formatQualityReport, type ProjectQualityReport } from "./code-quality.js";

vi.mock("../utils/logger.js", () => ({
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
