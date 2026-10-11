import { describe, expect, it } from "vitest";
import { classifyErrorMessage, classifyTaskErrorMessage, describeToolError } from "./error-messages.js";

const NETWORK = "Could not connect to the AI provider. Please check your network connection and whether the service is running.";
const AUTH = "Authentication failed with the AI provider. Please check your API key configuration.";
const BUDGET = "Request budget exceeded. Please try a shorter request or wait before trying again.";
const CONTEXT = "The conversation is too long for the current model. Try starting a new conversation or use a model with a larger context window.";

describe("classifyErrorMessage: a keyword inside the real error is not a provider diagnosis", () => {
  it("keeps an ENOENT on a Networking/ path as the real error", () => {
    const out = classifyErrorMessage(
      new Error("ENOENT: no such file or directory, open 'Assets/Scripts/Networking/PlayerSync.cs'"),
    );
    expect(out).not.toBe(NETWORK);
    expect(out).toContain("ENOENT");
  });

  it("reads a context overflow whose token count contains 401 as a context overflow", () => {
    const out = classifyErrorMessage(
      new Error("This model's maximum context length is 128000 tokens. However, your messages resulted in 140123 tokens."),
    );
    expect(out).toBe(CONTEXT);
  });

  it("keeps a compile error naming AuthenticationManager.cs as the real error", () => {
    const out = classifyErrorMessage(
      new Error("Assets/Scripts/AuthenticationManager.cs(12,5): error CS0246: The type 'Token' could not be found"),
    );
    expect(out).not.toBe(AUTH);
    expect(out).toContain("CS0246");
  });

  it("keeps a TypeError reading 'budget' as the real error", () => {
    const out = classifyErrorMessage(new TypeError("Cannot read properties of undefined (reading 'budget')"));
    expect(out).not.toBe(BUDGET);
    expect(out).toContain("reading 'budget'");
  });

  it("keeps a path segment named Authentication or Network as the real error", () => {
    expect(classifyErrorMessage(new Error("Missing script in Assets/Network/Lobby.prefab"))).not.toBe(NETWORK);
    expect(classifyErrorMessage(new Error("Missing script in Assets/Authentication/Login.prefab"))).not.toBe(AUTH);
  });

  it("still names the provider failures it is for", () => {
    expect(classifyErrorMessage(new TypeError("fetch failed"))).toBe(NETWORK);
    expect(classifyErrorMessage(new Error("connect ECONNREFUSED 127.0.0.1:11434"))).toBe(NETWORK);
    expect(classifyErrorMessage(new Error("getaddrinfo ENOTFOUND api.openai.com"))).toBe(NETWORK);
    expect(classifyErrorMessage(new Error("Network error while contacting the provider"))).toBe(NETWORK);
    expect(classifyErrorMessage(new Error('Claude API error 401: {"type":"authentication_error"}'))).toBe(AUTH);
    expect(classifyErrorMessage(new Error("401 Incorrect API key provided"))).toBe(AUTH);
    expect(classifyErrorMessage(new Error("Request failed: Unauthorized"))).toBe(AUTH);
    expect(classifyErrorMessage(new Error("Invalid API key"))).toBe(AUTH);
    expect(classifyErrorMessage(new Error("Authentication failed"))).toBe(AUTH);
    expect(classifyErrorMessage(new Error("Daily budget exceeded ($5.00/$5.00)"))).toBe(BUDGET);
    expect(classifyErrorMessage(new Error("Delegation x not started: the calling run's budget is exhausted"))).toBe(BUDGET);
    expect(classifyErrorMessage(new Error("Rate limit reached for gpt-4o"))).toContain("Rate limit reached");
    expect(classifyErrorMessage(new Error("This operation was aborted"))).toBe("The request was cancelled.");
    expect(classifyErrorMessage(new Error("All providers failed: claude: fetch failed"))).toContain("All AI providers");
  });
});

describe("classifyTaskErrorMessage: a task's own failure text survives", () => {
  it("does not turn a compile error under Networking/ into 'the AI provider is unreachable'", () => {
    const out = classifyTaskErrorMessage(
      "Compilation failed: Assets/Scripts/Networking/PlayerSync.cs(14,9): error CS0103: The name 'peer' does not exist",
    );
    expect(out).not.toContain("unreachable");
    expect(out).toContain("CS0103");
  });

  it("does not turn a missing NetworkManager prefab into a network outage", () => {
    const out = classifyTaskErrorMessage("the NetworkManager prefab is missing from the boot scene");
    expect(out).not.toContain("unreachable");
    expect(out).toContain("NetworkManager");
  });

  it("does not turn a storage migration error mentioning Budget into a budget stop", () => {
    const out = classifyTaskErrorMessage("Budget source migration not applied. Call migrateBudgetSource() first.");
    expect(out).not.toContain("request budget was exceeded");
  });

  it("returns a restart interruption verbatim", () => {
    const msg = "Task interrupted by system restart. Resume is available after restart.";
    expect(classifyTaskErrorMessage(msg)).toBe(msg);
  });
});

describe("describeToolError: a tool's failure is never an AI-provider category", () => {
  it("gives the model the real message, sanitized", () => {
    expect(describeToolError(new TypeError("fetch failed"))).toBe("fetch failed");
    expect(describeToolError(new Error("ENOENT: no such file or directory, open 'Assets/Scripts/Networking/PlayerSync.cs'")))
      .toContain("Networking/PlayerSync.cs");
    expect(describeToolError(new Error("token is sk-ant-abcdefghijklmnop"))).not.toContain("sk-ant-abcdefghijklmnop");
  });

  it("says something when the thrown value carries no message", () => {
    expect(describeToolError(undefined)).not.toBe("");
    expect(describeToolError(new Error(""))).not.toBe("");
  });
});
