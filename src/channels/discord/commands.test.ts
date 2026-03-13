import { describe, it, expect, vi } from "vitest";
import {
  askCommand,
  analyzeCommand,
  generateCommand,
  statusCommand,
  helpCommand,
  searchCommand,
  threadCommand,
  reloadCommand,
  getDefaultSlashCommands,
  getAllSlashCommands,
  findCommand,
} from "./commands.js";

describe("askCommand", () => {
  it("should have correct name and description", () => {
    expect(askCommand.data.name).toBe("ask");
    expect(askCommand.data.description).toContain("Ask Strada Brain");
  });

  it("should have required question option", () => {
    const options = askCommand.data.options;
    const questionOption = options.find((o) => o.name === "question");
    expect(questionOption).toBeDefined();
    expect(questionOption?.required).toBe(true);
  });

  it("should have optional stream option", () => {
    const options = askCommand.data.options;
    const streamOption = options.find((o) => o.name === "stream");
    expect(streamOption).toBeDefined();
    expect(streamOption?.required).toBe(false);
  });
});

describe("analyzeCommand", () => {
  it("should have correct name and description", () => {
    expect(analyzeCommand.data.name).toBe("analyze");
    expect(analyzeCommand.data.description).toContain("Analyze");
  });

  it("should have optional scope option with choices", () => {
    const options = analyzeCommand.data.options;
    const scopeOption = options.find((o) => o.name === "scope");
    expect(scopeOption).toBeDefined();
    expect(scopeOption?.required).toBe(false);
  });
});

describe("generateCommand", () => {
  it("should have correct name and description", () => {
    expect(generateCommand.data.name).toBe("generate");
    expect(generateCommand.data.description).toContain("Generate");
  });

  it("should have required type option", () => {
    const options = generateCommand.data.options;
    const typeOption = options.find((o) => o.name === "type");
    expect(typeOption).toBeDefined();
    expect(typeOption?.required).toBe(true);
  });

  it("should have required name option", () => {
    const options = generateCommand.data.options;
    const nameOption = options.find((o) => o.name === "name");
    expect(nameOption).toBeDefined();
    expect(nameOption?.required).toBe(true);
  });

  it("should have optional description option", () => {
    const options = generateCommand.data.options;
    const descOption = options.find((o) => o.name === "description");
    expect(descOption).toBeDefined();
    expect(descOption?.required).toBe(false);
  });

  it("should have optional namespace option", () => {
    const options = generateCommand.data.options;
    const nsOption = options.find((o) => o.name === "namespace");
    expect(nsOption).toBeDefined();
    expect(nsOption?.required).toBe(false);
  });

  it("should have correct type choices", () => {
    const options = generateCommand.data.options;
    const typeOption = options.find((o) => o.name === "type");
    const choices = typeOption?.choices;
    
    expect(choices).toBeDefined();
    expect(choices?.some((c) => c.value === "module")).toBe(true);
    expect(choices?.some((c) => c.value === "system")).toBe(true);
    expect(choices?.some((c) => c.value === "component")).toBe(true);
    expect(choices?.some((c) => c.value === "mediator")).toBe(true);
  });
});

describe("statusCommand", () => {
  it("should have correct name and description", () => {
    expect(statusCommand.data.name).toBe("status");
    expect(statusCommand.data.description).toContain("status");
  });

  it("should have no options", () => {
    expect(statusCommand.data.options).toHaveLength(0);
  });
});

describe("helpCommand", () => {
  it("should have correct name and description", () => {
    expect(helpCommand.data.name).toBe("help");
    expect(helpCommand.data.description.toLowerCase()).toContain("help");
  });
});

describe("searchCommand", () => {
  it("should have correct name and description", () => {
    expect(searchCommand.data.name).toBe("search");
    expect(searchCommand.data.description).toContain("Search");
  });

  it("should have required query option", () => {
    const options = searchCommand.data.options;
    const queryOption = options.find((o) => o.name === "query");
    expect(queryOption).toBeDefined();
    expect(queryOption?.required).toBe(true);
  });

  it("should have optional type option with choices", () => {
    const options = searchCommand.data.options;
    const typeOption = options.find((o) => o.name === "type");
    expect(typeOption).toBeDefined();
    expect(typeOption?.required).toBe(false);
  });
});

describe("threadCommand", () => {
  it("should have correct name and description", () => {
    expect(threadCommand.data.name).toBe("thread");
    expect(threadCommand.data.description).toContain("thread");
  });

  it("should have required topic option", () => {
    const options = threadCommand.data.options;
    const topicOption = options.find((o) => o.name === "topic");
    expect(topicOption).toBeDefined();
    expect(topicOption?.required).toBe(true);
  });

  it("should have optional initial_message option", () => {
    const options = threadCommand.data.options;
    const msgOption = options.find((o) => o.name === "initial_message");
    expect(msgOption).toBeDefined();
    expect(msgOption?.required).toBe(false);
  });
});

describe("reloadCommand", () => {
  it("should have correct name and description", () => {
    expect(reloadCommand.data.name).toBe("reload");
    expect(reloadCommand.data.description).toContain("Reload");
  });

  it("should require Administrator permission", () => {
    expect(reloadCommand.data.default_member_permissions).toBeDefined();
  });
});

describe("getDefaultSlashCommands", () => {
  it("should return all non-admin commands", () => {
    const commands = getDefaultSlashCommands();
    
    expect(commands).toHaveLength(7);
    expect(commands.some((c) => c.data.name === "ask")).toBe(true);
    expect(commands.some((c) => c.data.name === "analyze")).toBe(true);
    expect(commands.some((c) => c.data.name === "generate")).toBe(true);
    expect(commands.some((c) => c.data.name === "status")).toBe(true);
    expect(commands.some((c) => c.data.name === "help")).toBe(true);
    expect(commands.some((c) => c.data.name === "search")).toBe(true);
    expect(commands.some((c) => c.data.name === "thread")).toBe(true);
  });

  it("should not include admin commands", () => {
    const commands = getDefaultSlashCommands();
    
    expect(commands.some((c) => c.data.name === "reload")).toBe(false);
  });
});

describe("getAllSlashCommands", () => {
  it("should return all commands including admin", () => {
    const commands = getAllSlashCommands();
    
    expect(commands.length).toBeGreaterThan(7);
    expect(commands.some((c) => c.data.name === "reload")).toBe(true);
  });
});

describe("findCommand", () => {
  const commands = getDefaultSlashCommands();

  it("should find existing command", () => {
    const found = findCommand(commands, "ask");
    expect(found).toBeDefined();
    expect(found?.data.name).toBe("ask");
  });

  it("should return undefined for non-existent command", () => {
    const found = findCommand(commands, "nonexistent");
    expect(found).toBeUndefined();
  });
});
