import { describe, it, expect } from "vitest";
import { TaskClassifier } from "./task-classifier.js";

describe("TaskClassifier", () => {
  const classifier = new TaskClassifier();

  /* ---------------------------------------------------------------- */
  /*  Prompt classification — type                                    */
  /* ---------------------------------------------------------------- */

  it("classifies trivially short prompts as conversational (< 20 chars)", () => {
    expect(classifier.classify("merhaba").type).toBe("conversational");
    expect(classifier.classify("hello").type).toBe("conversational");
    expect(classifier.classify("Hi there").type).toBe("conversational");
  });

  it("classifies short code tasks normally (>= 20 chars)", () => {
    // These are real tasks, not conversational — should NOT be classified as conversational
    expect(classifier.classify("fix the bug in main.cs").type).not.toBe("conversational");
    expect(classifier.classify("What is a monad in FP?").type).toBe("simple-question");
  });

  it("classifies medium questions as simple-question (20-60 chars with ?)", () => {
    expect(classifier.classify("What is the purpose of this authentication module?").type).toBe("simple-question");
  });

  it("classifies code generation", () => {
    const result = classifier.classify(
      "Create a new service class for handling user authentication with JWT tokens",
    );
    expect(result.type).toBe("code-generation");
  });

  it("classifies planning", () => {
    const result = classifier.classify(
      "Plan the architecture for a microservices system with event sourcing and CQRS patterns and shared database and message queue and retry logic",
    );
    expect(result.type).toBe("planning");
    expect(result.complexity).toBe("complex");
  });

  it("classifies debugging with CS error codes", () => {
    const result = classifier.classify(
      "I'm getting CS0246 when building the solution, the type or namespace could not be found",
    );
    expect(result.type).toBe("debugging");
  });

  it("classifies refactoring", () => {
    const result = classifier.classify(
      "Refactor the user service to use dependency injection instead of static methods",
    );
    expect(result.type).toBe("refactoring");
  });

  it("classifies code review", () => {
    const result = classifier.classify(
      "Review this pull request for potential security issues and code quality improvements in the auth module",
    );
    expect(result.type).toBe("code-review");
  });

  it("classifies analysis", () => {
    const result = classifier.classify(
      "Analyze the performance characteristics of this database query and explain the execution plan",
    );
    expect(result.type).toBe("analysis");
  });

  it("defaults to code-generation for ambiguous prompts", () => {
    const result = classifier.classify(
      "Make the dashboard look better with some animations",
    );
    expect(result.type).toBe("code-generation");
  });

  /* ---------------------------------------------------------------- */
  /*  Non-English prompts → code-generation (most permissive)         */
  /* ---------------------------------------------------------------- */

  it("classifies short non-English prompts as code-generation (>= 20 chars)", () => {
    // 32 chars — above conversational threshold, falls through to code-generation
    expect(classifier.classify("Yeni bir servis ekle ve güncelle").type).toBe("code-generation");
  });

  it("classifies longer non-English prompts as code-generation (>= 40 chars)", () => {
    // German (50 chars)
    expect(classifier.classify("Erstelle einen neuen Service mit Authentifizierung").type).toBe("code-generation");
    // Japanese (>= 40 chars)
    expect(classifier.classify("新しいサービスクラスを作成してください、テストも更新してデプロイしてください、ドキュメントも書いてく").type).toBe("code-generation");
    // Chinese (>= 40 chars)
    expect(classifier.classify("创建一个新的用户认证服务并编写全面的单元测试然后更新项目文档和部署配置确保安全性通过验证").type).toBe("code-generation");
    // French (>= 40 chars)
    expect(classifier.classify("Créer un nouveau service d'authentification avec JWT").type).toBe("code-generation");
  });

  it("classifies very short non-English questions as conversational (< 20 chars)", () => {
    expect(classifier.classify("TypeScript nedir?").type).toBe("conversational");
    expect(classifier.classify("これは何ですか？").type).toBe("conversational");
    expect(classifier.classify("Was ist das?").type).toBe("conversational");
    expect(classifier.classify("¿Qué es esto?").type).toBe("conversational");
  });

  it("classifies longer non-English questions as simple-question (20-60 chars with ?)", () => {
    expect(classifier.classify("TypeScript nedir ve nereye kullanılır?").type).toBe("simple-question");
    expect(classifier.classify("このプロジェクトの構造はどうなっていますか？").type).toBe("simple-question");
  });

  it("classifies Turkish multi-action prompt as code-generation with full tool access", () => {
    const result = classifier.classify(
      "proje ne alemde eksiklere bakalım, 100 Level generate eden birden fazla editorümüz var gereksiz yer",
    );
    // Non-English → code-generation (most permissive, all tools available)
    expect(result.type).toBe("code-generation");
    // Long enough (> 80 chars) → moderate or complex
    expect(["moderate", "complex"]).toContain(result.complexity);
  });

  /* ---------------------------------------------------------------- */
  /*  Prompt classification — complexity (language-agnostic)           */
  /* ---------------------------------------------------------------- */

  it("detects trivial complexity for very short prompts", () => {
    const result = classifier.classify("Hi");
    expect(result.complexity).toBe("trivial");
  });

  it("detects simple complexity for short prompts", () => {
    const result = classifier.classify(
      "Add a loading spinner to the login page",
    );
    expect(result.complexity).toBe("simple");
  });

  it("complexity is length-based: >= 120 chars = complex (best-effort signal, not a gate)", () => {
    // English (140+ chars)
    expect(classifier.classify(
      "Create a comprehensive authentication system with JWT tokens, refresh token rotation, and role-based access control for the new platform.",
    ).complexity).toBe("complex");
    // Turkish (140+ chars)
    expect(classifier.classify(
      "Proje ne alemde eksiklere bakalım ve tamamen kusursuz hale getirelim mi? Benim hatırladığım bir konu vardı, birden fazla editorümüz var.",
    ).complexity).toBe("complex");
    // German (120+ chars)
    expect(classifier.classify(
      "Erstelle ein neues Authentifizierungssystem mit JWT-Tokens und aktualisiere alle Tests und deploye es in die Staging-Umgebung.",
    ).complexity).toBe("complex");
  });

  it("CJK prompts get moderate complexity due to shorter char count — LLM handles actual decomposition", () => {
    // Japanese (62 chars) — CJK packs more meaning per char, but length-based
    // classification rates this as moderate. This is acceptable because
    // shouldDecompose (>= 30 chars) still sends it to the LLM for decomposition.
    expect(classifier.classify(
      "新しい認証システムを作成し、テストを更新し、ステージング環境にデプロイしてください。それからドキュメントも更新してください。",
    ).complexity).toBe("moderate");
  });

  it("detects moderate for medium-length prompts (60-120 chars)", () => {
    const result = classifier.classify(
      "Create a React component that displays a sortable table with pagination support",
    );
    expect(result.complexity).toBe("moderate");
  });

  /* ---------------------------------------------------------------- */
  /*  Prompt classification — criticality                             */
  /* ---------------------------------------------------------------- */

  it("assigns low criticality to conversational messages", () => {
    const result = classifier.classify("What is DI?");
    expect(result.type).toBe("conversational");
    expect(result.complexity).toBe("trivial");
    expect(result.criticality).toBe("low");
  });

  it("assigns medium criticality by default", () => {
    const result = classifier.classify(
      "Add a new endpoint for user profile updates with proper validation",
    );
    expect(result.criticality).toBe("medium");
  });

  /* ---------------------------------------------------------------- */
  /*  Tool call classification                                        */
  /* ---------------------------------------------------------------- */

  it("classifies destructive tool calls as critical", () => {
    const result = classifier.classifyToolCall("file_delete", {
      path: "/src/old.ts",
    });
    expect(result.type).toBe("destructive-operation");
    expect(result.criticality).toBe("critical");
  });

  it("classifies shell_exec as critical", () => {
    const result = classifier.classifyToolCall("shell_exec", {
      command: "rm -rf dist",
    });
    expect(result.type).toBe("destructive-operation");
    expect(result.criticality).toBe("critical");
  });

  it("classifies git_push as critical", () => {
    const result = classifier.classifyToolCall("git_push");
    expect(result.type).toBe("destructive-operation");
    expect(result.criticality).toBe("critical");
  });

  it("classifies write tools as medium criticality", () => {
    const result = classifier.classifyToolCall("file_write", {
      path: "/src/new.ts",
      content: "export {}",
    });
    expect(result.type).toBe("code-generation");
    expect(result.criticality).toBe("medium");
  });

  it("classifies file_edit as medium criticality", () => {
    const result = classifier.classifyToolCall("file_edit");
    expect(result.type).toBe("code-generation");
    expect(result.criticality).toBe("medium");
  });

  it("classifies read tools as low criticality", () => {
    const result = classifier.classifyToolCall("file_read", {
      path: "/src/index.ts",
    });
    expect(result.type).toBe("analysis");
    expect(result.criticality).toBe("low");
  });

  it("classifies dotnet_build as low criticality", () => {
    const result = classifier.classifyToolCall("dotnet_build");
    expect(result.type).toBe("analysis");
    expect(result.criticality).toBe("low");
  });

  it("classifies dotnet_test as low criticality", () => {
    const result = classifier.classifyToolCall("dotnet_test");
    expect(result.type).toBe("analysis");
    expect(result.criticality).toBe("low");
  });

  it("defaults unknown tools to medium criticality code-generation", () => {
    const result = classifier.classifyToolCall("custom_tool");
    expect(result.type).toBe("code-generation");
    expect(result.criticality).toBe("medium");
  });
});
