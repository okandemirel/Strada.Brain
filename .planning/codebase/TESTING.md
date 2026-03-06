# Testing Patterns

**Analysis Date:** 2026-03-06

## Test Framework

**Runner:**
- Vitest v2.1+ (ESM-native, Vite-powered)
- Config: `vitest.config.ts`
- Globals enabled (`describe`, `it`, `expect`, `vi` available without import, though many tests explicitly import them)

**Assertion Library:**
- Vitest built-in (`expect`) -- Chai-compatible API

**Run Commands:**
```bash
npm test                  # Run all tests (vitest run)
npm run test:watch        # Watch mode (vitest)
npx vitest run --coverage # Coverage report
```

## Vitest Configuration

**Key Settings** from `vitest.config.ts`:
```typescript
export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    clearMocks: true,          // Auto-clear mocks between tests
    include: ["src/**/*.test.ts"],
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.test.ts", "src/index.ts"],
    },
    testTimeout: 10_000,       // 10 second timeout
    hookTimeout: 10_000,       // 10 second hook timeout
  },
  resolve: {
    alias: {
      "@": resolve(import.meta.dirname, "src"),
    },
  },
});
```

## Test File Organization

**Location:**
- Co-located pattern: test files sit next to source files
  - `src/agents/orchestrator.ts` -> `src/agents/orchestrator.test.ts`
  - `src/security/rate-limiter.ts` -> `src/security/rate-limiter.test.ts`
  - `src/agents/tools/file-read.ts` -> `src/agents/tools/file-read.test.ts`
- Exception: Slack tests use `__tests__` subdirectory: `src/channels/slack/__tests__/app.test.ts`

**Naming:**
- `{module-name}.test.ts` matching source file name

**Structure:**
```
src/
├── agents/
│   ├── orchestrator.ts
│   ├── orchestrator.test.ts         # Co-located unit test
│   ├── agent-state.ts
│   ├── agent-state.test.ts
│   ├── tools/
│   │   ├── file-read.ts
│   │   └── file-read.test.ts
│   └── providers/
│       ├── deepseek.ts
│       └── deepseek.test.ts
├── test-helpers.ts                  # Shared mock factories for unit tests
├── integration.test.ts              # Top-level integration test
└── tests/
    ├── helpers/
    │   ├── mock-channel.ts          # Rich mock channel for integration tests
    │   └── mock-provider.ts         # Rich mock provider for integration tests
    └── integration/
        ├── error-recovery.test.ts
        ├── file-build-flow.test.ts
        ├── multi-channel.test.ts
        ├── rag-search.test.ts
        └── telegram-flow.test.ts
```

**Test Counts:**
- 110 test files total
- ~26,000 lines of test code
- ~1,730 tests passing

## Test Structure

**Suite Organization:**
```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Module mocks at top level (before describe)
vi.mock("../utils/logger.js", () => ({
  getLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

describe("ComponentName", () => {
  let component: ComponentType;
  let mockDependency: ReturnType<typeof createMockDep>;

  beforeEach(() => {
    vi.useFakeTimers();
    mockDependency = createMockDep();
    component = new ComponentType(mockDependency);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("methodName", () => {
    it("should do expected behavior", () => {
      // Arrange / Act / Assert
    });
  });
});
```

**Patterns:**
- Nested `describe` blocks for method grouping
- `beforeEach` creates fresh instances and mocks per test
- `vi.useFakeTimers()` / `vi.useRealTimers()` in beforeEach/afterEach for time-dependent code
- Tests use `should` prefix in descriptions: `"should find matching instincts by error code"`
- Alternative: declarative descriptions: `"allows messages within per-minute limit"`

## Mocking

**Framework:** Vitest built-in (`vi.fn()`, `vi.mock()`, `vi.spyOn()`)

**Module Mocking:**
Always mock the logger module in test files that import modules using it:
```typescript
vi.mock("../utils/logger.js", () => ({
  getLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));
```

Mock knowledge/context modules for orchestrator tests:
```typescript
vi.mock("./agents/context/strata-knowledge.js", () => ({
  STRATA_SYSTEM_PROMPT: "Test system prompt",
  buildProjectContext: vi.fn().mockReturnValue(""),
  buildAnalysisSummary: vi.fn().mockReturnValue(""),
  buildDepsContext: vi.fn().mockReturnValue(""),
}));
```

**Mock Function Patterns:**
```typescript
// Simple mock function
const mockFn = vi.fn();

// Mock with return value
const mockFn = vi.fn().mockReturnValue(true);

// Mock with resolved promise
const mockFn = vi.fn().mockResolvedValue({ text: "response" });

// Mock with sequential responses
mockProvider.chat
  .mockResolvedValueOnce(toolResponse)
  .mockResolvedValueOnce(finalResponse);

// Mock with typed signature
vi.fn<(chatId: string, text: string) => Promise<void>>()
  .mockResolvedValue(undefined);

// Rejected mock
readTool.execute.mockRejectedValueOnce(new Error("disk failure"));
```

**What to Mock:**
- Logger module (`../utils/logger.js`) -- always mock in unit tests
- Knowledge/context modules (`strata-knowledge.js`) -- mock in orchestrator tests
- External API clients (never make real HTTP calls in tests)
- File system operations (use temp directories instead for tool tests)
- Timers (`vi.useFakeTimers()`) when testing time-dependent behavior

**What NOT to Mock:**
- The class under test itself
- Pure utility functions (`extractKeywords`, `jaccardSimilarity`, `cosineSimilarity`)
- Type validation logic
- Data structures and state transitions

## Fixtures and Factories

**Shared Test Helpers** at `src/test-helpers.ts`:
```typescript
// Mock logger
export function createMockLogger() {
  return {
    info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
  };
}

// Mock channel adapter
export function createMockChannel(): IChannelAdapter {
  return {
    name: "mock",
    connect: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn().mockResolvedValue(undefined),
    onMessage: vi.fn(),
    sendText: vi.fn().mockResolvedValue(undefined),
    sendMarkdown: vi.fn().mockResolvedValue(undefined),
    isHealthy: vi.fn().mockReturnValue(true),
  };
}

// Mock AI provider
export function createMockProvider(response?: Partial<ProviderResponse>): IAIProvider

// Mock tool
export function createMockTool(name: string, result?: Partial<ToolExecutionResult>): ITool

// Default tool context
export function createToolContext(overrides?: Partial<ToolContext>): ToolContext

// Temp directory helper
export async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void>
```

**Integration Test Helpers** at `src/tests/helpers/`:

`mock-channel.ts` -- Rich mock channel with message capture:
```typescript
// Create channel-specific mocks
const channel = createMockTelegramChannel({ autoConfirm: true });

// Simulate incoming message
await channel.simulateIncomingMessage("chat-1", "Hello");

// Assert on captured output
expect(channel.hasMarkdownContaining("result")).toBe(true);
channel.assertConfirmationRequested("Delete this file?");
```

`mock-provider.ts` -- Scriptable AI provider:
```typescript
const provider = createMockProvider();

// Queue scripted responses
provider.queueResponses([
  { text: "Building...", toolCalls: [buildToolCall], stopReason: "tool_use" },
  { text: "Done!", toolCalls: [], stopReason: "end_turn" },
]);

// Or use convenience methods
provider.simulateToolCallFlow(toolCalls, "Final response");
provider.simulateErrorRecoveryFlow(firstTool, fixTool, "Fixed!");

// Assert on captured interactions
provider.assertToolCalled("file_edit");
provider.assertMessageSent("build error");
const allToolCalls = provider.getAllToolCalls();
```

**Test Data Patterns:**
- Create test data inline in the test when small and specific
- Use factory functions (`createMockProvider()`, `createMockChannel()`) for complex objects
- For file system tests, use `mkdtemp()` / `mkdtempSync()` with cleanup in `afterAll`:
```typescript
let tempDir: string;

beforeAll(() => {
  tempDir = mkdtempSync(join(tmpdir(), "file-read-test-"));
  writeFileSync(join(tempDir, "hello.txt"), "Hello\nWorld\n");
});

afterAll(() => {
  rmSync(tempDir, { recursive: true, force: true });
});
```

## Coverage

**Requirements:** No enforced minimum coverage threshold. V8 provider configured.

**View Coverage:**
```bash
npx vitest run --coverage      # Generate coverage report
```

**Coverage Exclusions:**
- `src/**/*.test.ts` -- test files themselves
- `src/index.ts` -- CLI entry point

## Test Types

**Unit Tests** (~95 files):
- Co-located with source files
- Test individual classes/functions in isolation
- Mock all external dependencies
- Use `vi.fn()` for dependency mocking
- Examples: `src/agents/agent-state.test.ts`, `src/security/rate-limiter.test.ts`, `src/learning/matching/pattern-matcher.test.ts`

**Integration Tests** (~15 files):
- Located in `src/tests/integration/` and `src/integration.test.ts`
- Test multi-component flows (orchestrator + tools + channel)
- Use rich mock helpers from `src/tests/helpers/`
- Create real temp directories for file operations
- Test full message flow: user -> provider -> tool -> provider -> channel
- Examples: `src/tests/integration/error-recovery.test.ts`, `src/tests/integration/multi-channel.test.ts`

**E2E Tests:**
- Not present in the test suite
- Security tests exist as separate shell scripts (`pentest/scripts/`)

## Common Patterns

**Async Testing:**
```typescript
it("handles async operation", async () => {
  const result = await service.doSomething();
  expect(result).toBeDefined();
});

// With fake timers (common for orchestrator tests)
it("handles timed operation", async () => {
  vi.useFakeTimers();
  const promise = orchestrator.handleMessage(msg);
  await vi.advanceTimersByTimeAsync(100);
  await promise;
  expect(mockChannel.sendMarkdown).toHaveBeenCalled();
  vi.useRealTimers();
});
```

**Error Testing:**
```typescript
// Expect thrown error
it("throws on invalid transition", () => {
  expect(() => transitionPhase(state, AgentPhase.REFLECTING)).toThrow();
});

// Expect specific error message pattern
it("throws descriptive message", () => {
  expect(() => transitionPhase(state, AgentPhase.COMPLETE)).toThrow(
    /planning.*complete/i,
  );
});

// Test error results (not thrown)
it("returns isError for not found", async () => {
  const result = await tool.execute({ path: "nonexistent.txt" }, ctx);
  expect(result.isError).toBe(true);
  expect(result.content).toContain("file not found");
});
```

**Testing Private Methods:**
Access private methods through casting for provider tests:
```typescript
const parse = (data: unknown) =>
  (provider as unknown as { parseResponse: (d: unknown) => unknown }).parseResponse(data);
const build = (sys: string, msgs: ConversationMessage[]) =>
  (provider as unknown as { buildMessages: (s: string, m: ConversationMessage[]) => unknown[] }).buildMessages(sys, msgs);
```

**State Transition Testing:**
```typescript
it("supports multi-step valid transition chains", () => {
  const s0 = createInitialState("test task");
  const s1 = transitionPhase(s0, AgentPhase.EXECUTING);
  const s2 = transitionPhase(s1, AgentPhase.REFLECTING);
  const s3 = transitionPhase(s2, AgentPhase.REPLANNING);
  const s4 = transitionPhase(s3, AgentPhase.EXECUTING);
  const s5 = transitionPhase(s4, AgentPhase.COMPLETE);
  expect(s5.phase).toBe(AgentPhase.COMPLETE);
});
```

**Immutability Testing:**
```typescript
it("should not mutate the original state", () => {
  const state = createInitialState("test task");
  transitionPhase(state, AgentPhase.EXECUTING);
  expect(state.phase).toBe(AgentPhase.PLANNING);  // unchanged
});
```

**Message Flow Testing (Integration):**
```typescript
it("handles tool call round-trip", async () => {
  // Setup provider with scripted responses
  mockProvider.queueResponses([...]);

  // Simulate user message
  await channel.simulateIncomingMessage("chat-1", "Build the project");

  // Assert tool was called
  mockProvider.assertToolCalled("dotnet_build");

  // Assert final response sent to user
  expect(channel.hasMarkdownContaining("Build successful")).toBe(true);
});
```

**Temporary Directory Pattern:**
```typescript
// Option 1: withTempDir helper (from test-helpers.ts)
await withTempDir(async (dir) => {
  writeFileSync(join(dir, "test.txt"), "content");
  const result = await tool.execute({ path: "test.txt" }, { projectPath: dir });
  expect(result.content).toContain("content");
});

// Option 2: Manual setup/teardown
let tempDir: string;
beforeAll(() => {
  tempDir = mkdtempSync(join(tmpdir(), "test-prefix-"));
});
afterAll(() => {
  rmSync(tempDir, { recursive: true, force: true });
});
```

## Writing New Tests

**For a new tool** (e.g., `src/agents/tools/my-tool.ts`):
1. Create `src/agents/tools/my-tool.test.ts`
2. Mock the logger module
3. Create temp directory in `beforeAll` if the tool does file I/O
4. Instantiate the tool in `beforeEach`
5. Test happy path, error cases, and edge cases
6. Clean up temp directory in `afterAll`

**For a new provider** (e.g., `src/agents/providers/my-provider.ts`):
1. Create `src/agents/providers/my-provider.test.ts`
2. Mock the logger module
3. Test `name` and `capabilities` properties
4. Test `parseResponse` with various API response shapes
5. Test `buildMessages` for message format conversion
6. Never make real API calls -- test response parsing only

**For a new service/module**:
1. Create `src/{module}/{service}.test.ts` co-located with source
2. Mock logger and any external dependencies
3. Use `createMock*()` factories from `src/test-helpers.ts`
4. Group tests by method using nested `describe` blocks
5. Test state transitions, error handling, and edge cases

---

*Testing analysis: 2026-03-06*
