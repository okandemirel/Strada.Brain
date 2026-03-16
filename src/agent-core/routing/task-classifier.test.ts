import { describe, it, expect } from "vitest";
import { TaskClassifier } from "./task-classifier.js";

describe("TaskClassifier", () => {
  const classifier = new TaskClassifier();

  /* ---------------------------------------------------------------- */
  /*  Prompt classification — type                                    */
  /* ---------------------------------------------------------------- */

  it("classifies a simple question", () => {
    const result = classifier.classify("What is a monad?");
    expect(result.type).toBe("simple-question");
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
  /*  Prompt classification — complexity                              */
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

  it("detects moderate complexity for medium prompts", () => {
    const result = classifier.classify(
      "Create a React component that displays a sortable table with pagination support, column filtering, and export to CSV functionality",
    );
    expect(result.complexity).toBe("moderate");
  });

  it("detects complex for long prompts (>= 200 chars)", () => {
    const longPrompt =
      "Create a comprehensive authentication system with JWT tokens, refresh token rotation, " +
      "role-based access control, OAuth2 integration for Google and GitHub, two-factor authentication " +
      "via TOTP, account lockout after failed attempts, and audit logging for all auth events.";
    const result = classifier.classify(longPrompt);
    expect(result.complexity).toBe("complex");
  });

  it("detects complex when 'and' appears 3+ times", () => {
    const result = classifier.classify(
      "Update the service and the controller and the repository and the tests",
    );
    expect(result.complexity).toBe("complex");
  });

  it("detects complex for numbered lists", () => {
    const result = classifier.classify(
      "Please do the following: 1) Add validation 2) Update tests 3) Fix the bug in line 42",
    );
    expect(result.complexity).toBe("complex");
  });

  /* ---------------------------------------------------------------- */
  /*  Prompt classification — criticality                             */
  /* ---------------------------------------------------------------- */

  it("assigns low criticality to trivial simple questions", () => {
    const result = classifier.classify("What is DI?");
    expect(result.type).toBe("simple-question");
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
