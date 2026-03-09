import { describe, it, expect, vi } from "vitest";
import { parseHeartbeatFile, parseNaturalTime } from "./heartbeat-parser.js";
import type { CronTriggerDef, FileWatchTriggerDef, ChecklistTriggerDef, WebhookTriggerDef } from "./daemon-types.js";

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
  // Backward compatibility -- cron triggers
  // =========================================================================

  it("parses a single cron trigger with heading, cron, and action", () => {
    const content = `## Triggers

### Every morning at 9am
- cron: 0 9 * * *
- action: Check for new Unity compile errors
`;
    const result = parseHeartbeatFile(content);
    expect(result).toHaveLength(1);
    expect(result[0].type).toBe("cron");
    expect(result[0].name).toBe("every-morning-at-9am");
    const cron = result[0] as CronTriggerDef;
    expect(cron.cron).toBe("0 9 * * *");
    expect(cron.action).toBe("Check for new Unity compile errors");
  });

  it("defaults to cron type when no type field but cron field present", () => {
    const content = `### Legacy trigger
- cron: 0 * * * *
- action: Legacy action
`;
    const result = parseHeartbeatFile(content);
    expect(result).toHaveLength(1);
    expect(result[0].type).toBe("cron");
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
  // Explicit cron type
  // =========================================================================

  it("parses explicit type: cron", () => {
    const content = `### Scheduled check
- type: cron
- cron: 0 9 * * *
- action: Run tests
`;
    const result = parseHeartbeatFile(content);
    expect(result).toHaveLength(1);
    expect(result[0].type).toBe("cron");
    const cron = result[0] as CronTriggerDef;
    expect(cron.cron).toBe("0 9 * * *");
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

  it("skips cron triggers with missing cron field", () => {
    const content = `### Missing cron
- type: cron
- action: do something

### Valid trigger
- cron: 0 9 * * *
- action: do another thing
`;
    const result = parseHeartbeatFile(content);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("valid-trigger");
  });

  it("skips cron triggers with missing action field", () => {
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

  it("handles optional timeout field (seconds -> ms)", () => {
    const content = `### With timeout
- cron: 0 9 * * *
- action: long task
- timeout: 120
`;
    const result = parseHeartbeatFile(content);
    expect(result).toHaveLength(1);
    expect(result[0].timeout).toBe(120000);
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
  // Cooldown (TRIG-05)
  // =========================================================================

  it("extracts cooldown field for cron trigger", () => {
    const content = `### With cooldown
- cron: 0 9 * * *
- action: test
- cooldown: 60
`;
    const result = parseHeartbeatFile(content);
    expect(result).toHaveLength(1);
    expect(result[0].cooldown).toBe(60);
  });

  it("extracts cooldown field for file-watch trigger", () => {
    const content = `### Watch with cooldown
- type: file-watch
- path: ./src
- action: check
- cooldown: 120
`;
    const result = parseHeartbeatFile(content);
    expect(result).toHaveLength(1);
    expect(result[0].cooldown).toBe(120);
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

  // =========================================================================
  // File-watch trigger
  // =========================================================================

  it("parses file-watch trigger with full fields", () => {
    const content = `### Watch Unity scripts
- type: file-watch
- path: ./Assets/Scripts
- pattern: *.cs
- debounce: 500
- recursive: true
- ignore: node_modules, .git, *.d.ts
- action: Check for compile errors in changed scripts
`;
    const result = parseHeartbeatFile(content);
    expect(result).toHaveLength(1);
    expect(result[0].type).toBe("file-watch");
    const fw = result[0] as FileWatchTriggerDef;
    expect(fw.path).toBe("./Assets/Scripts");
    expect(fw.pattern).toBe("*.cs");
    expect(fw.debounce).toBe(500);
    expect(fw.recursive).toBe(true);
    expect(fw.ignore).toEqual(["node_modules", ".git", "*.d.ts"]);
    expect(fw.action).toBe("Check for compile errors in changed scripts");
  });

  it("skips file-watch trigger with missing path", () => {
    const content = `### Missing path
- type: file-watch
- action: check

### Valid
- cron: 0 9 * * *
- action: test
`;
    const result = parseHeartbeatFile(content);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("valid");
  });

  it("uses default values for optional file-watch fields", () => {
    const content = `### Minimal watch
- type: file-watch
- path: ./src
- action: check changes
`;
    const result = parseHeartbeatFile(content);
    expect(result).toHaveLength(1);
    const fw = result[0] as FileWatchTriggerDef;
    expect(fw.path).toBe("./src");
    expect(fw.pattern).toBeUndefined();
    expect(fw.debounce).toBeUndefined();
    expect(fw.recursive).toBe(true);
    expect(fw.ignore).toEqual(["node_modules", ".git", "*.d.ts"]);
  });

  it("parses recursive: false for file-watch", () => {
    const content = `### Watch flat
- type: file-watch
- path: ./root
- recursive: false
- action: check
`;
    const result = parseHeartbeatFile(content);
    const fw = result[0] as FileWatchTriggerDef;
    expect(fw.recursive).toBe(false);
  });

  // =========================================================================
  // Checklist trigger
  // =========================================================================

  it("parses checklist trigger with emoji priorities", () => {
    const content = `### Daily checklist
- type: checklist
- action: Review pending items

#### Tasks
- [ ] \u{1F534} Fix login bug (every morning)
- [ ] \u{1F7E2} Update README (weekly on Monday)
- [ ] Review PR queue (every afternoon)
`;
    const result = parseHeartbeatFile(content);
    expect(result).toHaveLength(1);
    expect(result[0].type).toBe("checklist");
    const cl = result[0] as ChecklistTriggerDef;
    expect(cl.items).toHaveLength(3);
    expect(cl.items[0].priority).toBe("high");
    expect(cl.items[0].text).toBe("Fix login bug");
    expect(cl.items[0].checked).toBe(false);
    expect(cl.items[0].schedule).toBeDefined();
    expect(cl.items[1].priority).toBe("low");
    expect(cl.items[1].text).toBe("Update README");
    expect(cl.items[2].priority).toBe("medium");
    expect(cl.items[2].text).toBe("Review PR queue");
  });

  it("parses checked items with [x]", () => {
    const content = `### Tasks
- type: checklist
- action: review

#### Tasks
- [x] \u{1F534} Already done
- [ ] Still todo
`;
    const result = parseHeartbeatFile(content);
    const cl = result[0] as ChecklistTriggerDef;
    expect(cl.items[0].checked).toBe(true);
    expect(cl.items[0].text).toBe("Already done");
    expect(cl.items[1].checked).toBe(false);
  });

  it("parses multi-line checklist descriptions", () => {
    const content = `### Tasks
- type: checklist
- action: review

#### Tasks
- [ ] \u{1F534} Fix login bug (every morning)
  Check authentication flow,
  verify session tokens,
  test edge cases
- [ ] Simple item
`;
    const result = parseHeartbeatFile(content);
    const cl = result[0] as ChecklistTriggerDef;
    expect(cl.items[0].multilineDescription).toBe(
      "Check authentication flow,\nverify session tokens,\ntest edge cases",
    );
    expect(cl.items[1].multilineDescription).toBeUndefined();
  });

  it("parses yellow circle emoji as medium priority", () => {
    const content = `### Tasks
- type: checklist
- action: review

#### Tasks
- [ ] \u{1F7E1} Medium priority item
`;
    const result = parseHeartbeatFile(content);
    const cl = result[0] as ChecklistTriggerDef;
    expect(cl.items[0].priority).toBe("medium");
  });

  it("defaults to medium priority when no emoji", () => {
    const content = `### Tasks
- type: checklist
- action: review

#### Tasks
- [ ] No emoji item
`;
    const result = parseHeartbeatFile(content);
    const cl = result[0] as ChecklistTriggerDef;
    expect(cl.items[0].priority).toBe("medium");
  });

  it("parses checklist items without #### Tasks heading", () => {
    const content = `### Tasks
- type: checklist
- action: review

- [ ] Direct item one
- [ ] Direct item two
`;
    const result = parseHeartbeatFile(content);
    const cl = result[0] as ChecklistTriggerDef;
    expect(cl.items).toHaveLength(2);
  });

  // =========================================================================
  // Webhook trigger
  // =========================================================================

  it("parses webhook trigger (minimal)", () => {
    const content = `### External hook
- type: webhook
- action: Process incoming event
`;
    const result = parseHeartbeatFile(content);
    expect(result).toHaveLength(1);
    expect(result[0].type).toBe("webhook");
    const wh = result[0] as WebhookTriggerDef;
    expect(wh.action).toBe("Process incoming event");
    expect(wh.name).toBe("external-hook");
  });

  // =========================================================================
  // Mixed types in single file
  // =========================================================================

  it("parses mixed trigger types in a single file", () => {
    const content = `## Triggers

### Morning check
- cron: 0 9 * * *
- action: Morning routine

### Watch scripts
- type: file-watch
- path: ./src
- action: Check changes

### Daily tasks
- type: checklist
- action: Review items

#### Tasks
- [ ] Item one

### API hook
- type: webhook
- action: Handle API event
`;
    const result = parseHeartbeatFile(content);
    expect(result).toHaveLength(4);
    expect(result[0].type).toBe("cron");
    expect(result[1].type).toBe("file-watch");
    expect(result[2].type).toBe("checklist");
    expect(result[3].type).toBe("webhook");
  });

  // =========================================================================
  // Invalid / unrecognized types
  // =========================================================================

  it("skips sections with invalid type value", () => {
    const content = `### Unknown type
- type: unknown-type
- action: something

### Valid cron
- cron: 0 9 * * *
- action: test
`;
    const result = parseHeartbeatFile(content);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("valid-cron");
  });

  it("skips sections with neither type nor cron field", () => {
    const content = `### Ambiguous section
- action: something

### Valid
- cron: 0 9 * * *
- action: test
`;
    const result = parseHeartbeatFile(content);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("valid");
  });
});

// =========================================================================
// parseNaturalTime
// =========================================================================

describe("parseNaturalTime", () => {
  const defaultConfig = {
    morningHour: 9,
    afternoonHour: 14,
    eveningHour: 18,
  };

  it("parses 'every morning'", () => {
    expect(parseNaturalTime("every morning", defaultConfig)).toBe("0 9 * * *");
  });

  it("parses 'every afternoon'", () => {
    expect(parseNaturalTime("every afternoon", defaultConfig)).toBe("0 14 * * *");
  });

  it("parses 'every evening'", () => {
    expect(parseNaturalTime("every evening", defaultConfig)).toBe("0 18 * * *");
  });

  it("parses 'daily'", () => {
    expect(parseNaturalTime("daily", defaultConfig)).toBe("0 9 * * *");
  });

  it("parses 'every hour'", () => {
    expect(parseNaturalTime("every hour", defaultConfig)).toBe("0 * * * *");
  });

  it("parses 'every N min' patterns", () => {
    expect(parseNaturalTime("every 5 min", defaultConfig)).toBe("*/5 * * * *");
    expect(parseNaturalTime("every 15 minutes", defaultConfig)).toBe("*/15 * * * *");
  });

  it("parses 'weekly on Monday'", () => {
    expect(parseNaturalTime("weekly on Monday", defaultConfig)).toBe("0 9 * * 1");
  });

  it("parses 'weekly on Friday'", () => {
    expect(parseNaturalTime("weekly on Friday", defaultConfig)).toBe("0 9 * * 5");
  });

  it("is case insensitive", () => {
    expect(parseNaturalTime("Every Morning", defaultConfig)).toBe("0 9 * * *");
    expect(parseNaturalTime("DAILY", defaultConfig)).toBe("0 9 * * *");
    expect(parseNaturalTime("Weekly On Wednesday", defaultConfig)).toBe("0 9 * * 3");
  });

  it("returns undefined for unrecognized phrases", () => {
    expect(parseNaturalTime("sometime later", defaultConfig)).toBeUndefined();
    expect(parseNaturalTime("", defaultConfig)).toBeUndefined();
  });

  it("respects configurable hours", () => {
    const custom = { morningHour: 7, afternoonHour: 13, eveningHour: 20 };
    expect(parseNaturalTime("every morning", custom)).toBe("0 7 * * *");
    expect(parseNaturalTime("every afternoon", custom)).toBe("0 13 * * *");
    expect(parseNaturalTime("every evening", custom)).toBe("0 20 * * *");
    expect(parseNaturalTime("daily", custom)).toBe("0 7 * * *");
  });

  it("parses weekly on all days", () => {
    expect(parseNaturalTime("weekly on Sunday", defaultConfig)).toBe("0 9 * * 0");
    expect(parseNaturalTime("weekly on Tuesday", defaultConfig)).toBe("0 9 * * 2");
    expect(parseNaturalTime("weekly on Wednesday", defaultConfig)).toBe("0 9 * * 3");
    expect(parseNaturalTime("weekly on Thursday", defaultConfig)).toBe("0 9 * * 4");
    expect(parseNaturalTime("weekly on Saturday", defaultConfig)).toBe("0 9 * * 6");
  });
});
