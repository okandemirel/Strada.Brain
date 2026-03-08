import { describe, it, expect, vi, beforeEach } from "vitest";
import { parseHeartbeatFile } from "./heartbeat-parser.js";

// Mock the logger to prevent "Logger not initialized" errors
vi.mock("../utils/logger.js", () => ({
  getLogger: () => ({
    warn: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
  }),
}));

describe("parseHeartbeatFile", () => {
  // =========================================================================
  // Basic parsing
  // =========================================================================

  it("parses a single trigger with heading, cron, and action", () => {
    const content = `## Triggers

### Every morning at 9am
- cron: 0 9 * * *
- action: Check for new Unity compile errors
`;
    const result = parseHeartbeatFile(content);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("every-morning-at-9am");
    expect(result[0].cron).toBe("0 9 * * *");
    expect(result[0].action).toBe("Check for new Unity compile errors");
  });

  it("parses multiple triggers from one file", () => {
    const content = `## Triggers

### Every morning at 9am
- cron: 0 9 * * *
- action: Check for new Unity compile errors

### Every hour
- cron: 0 * * * *
- action: Summarize recent git commits
`;
    const result = parseHeartbeatFile(content);
    expect(result).toHaveLength(2);
    expect(result[0].name).toBe("every-morning-at-9am");
    expect(result[1].name).toBe("every-hour");
  });

  // =========================================================================
  // Slugification
  // =========================================================================

  it("slugifies heading correctly (lowercase, hyphens, no leading/trailing hyphens)", () => {
    const content = `### ---Hello World 123---
- cron: 0 9 * * *
- action: test
`;
    const result = parseHeartbeatFile(content);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("hello-world-123");
  });

  // =========================================================================
  // Lenient parsing -- missing fields
  // =========================================================================

  it("skips triggers with missing cron field", () => {
    const content = `### Missing cron
- action: do something

### Valid trigger
- cron: 0 9 * * *
- action: do another thing
`;
    const result = parseHeartbeatFile(content);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("valid-trigger");
  });

  it("skips triggers with missing action field", () => {
    const content = `### Missing action
- cron: 0 9 * * *

### Valid trigger
- cron: 0 9 * * *
- action: do something
`;
    const result = parseHeartbeatFile(content);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("valid-trigger");
  });

  // =========================================================================
  // Optional fields
  // =========================================================================

  it("handles optional timeout field", () => {
    const content = `### With timeout
- cron: 0 9 * * *
- action: long task
- timeout: 120
`;
    const result = parseHeartbeatFile(content);
    expect(result).toHaveLength(1);
    expect(result[0].timeout).toBe(120000); // 120 seconds in ms
  });

  it("handles optional enabled field", () => {
    const content = `### Disabled trigger
- cron: 0 9 * * *
- action: skipped
- enabled: false
`;
    const result = parseHeartbeatFile(content);
    expect(result).toHaveLength(1);
    expect(result[0].enabled).toBe(false);
  });

  it("handles optional type field (default cron, future-proof for Phase 15)", () => {
    const content = `### With explicit type
- cron: 0 9 * * *
- action: test
- type: file-watch
`;
    const result = parseHeartbeatFile(content);
    expect(result).toHaveLength(1);
    // Type is stored but not yet used
  });

  // =========================================================================
  // Empty / non-matching content
  // =========================================================================

  it("returns empty array for empty content", () => {
    expect(parseHeartbeatFile("")).toHaveLength(0);
  });

  it("returns empty array for content with no h3 headings", () => {
    const content = `## Triggers

Just some text without any h3 triggers.
`;
    expect(parseHeartbeatFile(content)).toHaveLength(0);
  });

  // =========================================================================
  // Content before first heading
  // =========================================================================

  it("ignores content before first ### heading", () => {
    const content = `# My HEARTBEAT.md

Some description text here.

## Triggers

Some more text.

### Actual trigger
- cron: 0 9 * * *
- action: do work
`;
    const result = parseHeartbeatFile(content);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("actual-trigger");
  });

  // =========================================================================
  // Enabled defaults to true
  // =========================================================================

  it("defaults enabled to true when not specified", () => {
    const content = `### No enabled field
- cron: 0 9 * * *
- action: test
`;
    const result = parseHeartbeatFile(content);
    expect(result).toHaveLength(1);
    expect(result[0].enabled).toBe(true);
  });

  // =========================================================================
  // Invalid cron expression
  // =========================================================================

  it("skips triggers with invalid cron expressions", () => {
    const content = `### Bad cron
- cron: not-a-cron
- action: will be skipped

### Good trigger
- cron: 0 9 * * *
- action: will be kept
`;
    const result = parseHeartbeatFile(content);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("good-trigger");
  });
});
