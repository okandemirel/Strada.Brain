/**
 * Mock AI Provider for Integration Tests
 * 
 * Provides a fully controllable IAIProvider implementation that allows
 * scripted responses and captures all interactions for assertions.
 */

import { vi } from "vitest";
import type {
  IAIProvider,
  IStreamingProvider,
  ConversationMessage,
  ToolDefinition,
  ToolCall,
  ProviderResponse,
  TokenUsage,
  StopReason,
  ProviderCapabilities,
} from "../../agents/providers/provider.interface.js";
import type { JsonObject } from "../../types/index.js";

export interface MockResponse {
  text: string;
  toolCalls: ToolCall[];
  stopReason: StopReason;
  usage: TokenUsage;
}

export interface MockResponseSequence {
  responses: MockResponse[];
  currentIndex: number;
}

export interface ProviderInteraction {
  systemPrompt: string;
  messages: ConversationMessage[];
  tools: ToolDefinition[];
  response: MockResponse;
  timestamp: Date;
}

export interface MockProviderConfig {
  name?: string;
  streaming?: boolean;
  defaultResponse?: Partial<MockResponse>;
}

/**
 * Mock AI Provider that implements IAIProvider and IStreamingProvider.
 * Allows scripted responses and captures all interactions.
 */
export class MockAIProvider implements IAIProvider, IStreamingProvider {
  readonly name: string;
  readonly capabilities: ProviderCapabilities;

  // Response management
  private responseQueue: MockResponse[] = [];
  private defaultResponse: MockResponse;
  private responseHandlers: Map<
    string,
    (input: { messages: ConversationMessage[]; tools: ToolDefinition[] }) => MockResponse | undefined
  > = new Map();

  // Captured interactions
  readonly interactions: ProviderInteraction[] = [];

  // Spy functions
  readonly chatSpy = vi.fn<
    (
      systemPrompt: string,
      messages: ConversationMessage[],
      tools: ToolDefinition[]
    ) => Promise<ProviderResponse>
  >();
  readonly chatStreamSpy = vi.fn<
    (
      systemPrompt: string,
      messages: ConversationMessage[],
      tools: ToolDefinition[],
      onChunk: (chunk: string) => void
    ) => Promise<ProviderResponse>
  >();

  constructor(config: MockProviderConfig = {}) {
    this.name = config.name ?? "mock-provider";
    this.capabilities = {
      maxTokens: 4096,
      streaming: config.streaming ?? true,
      structuredStreaming: false,
      toolCalling: true,
      vision: false,
      systemPrompt: true,
    };

    this.defaultResponse = {
      text: "This is a mock response",
      toolCalls: [],
      stopReason: "end_turn",
      usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
      ...config.defaultResponse,
    };
  }

  // --------------------------------------------------------------------------
  // Response Configuration
  // --------------------------------------------------------------------------

  /**
   * Queue a response to be returned by the next chat() call.
   */
  queueResponse(response: Partial<MockResponse>): void {
    this.responseQueue.push({
      text: "",
      toolCalls: [],
      stopReason: "end_turn",
      usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
      ...response,
    } as MockResponse);
  }

  /**
   * Queue multiple responses in sequence.
   */
  queueResponses(responses: Partial<MockResponse>[]): void {
    for (const response of responses) {
      this.queueResponse(response);
    }
  }

  /**
   * Set a default response for when the queue is empty.
   */
  setDefaultResponse(response: Partial<MockResponse>): void {
    this.defaultResponse = {
      ...this.defaultResponse,
      ...response,
    } as MockResponse;
  }

  /**
   * Register a handler that can generate dynamic responses based on input.
   * The handler receives the messages and tools, and can return a response or undefined.
   * If undefined is returned, the queued response or default is used.
   */
  registerResponseHandler(
    name: string,
    handler: (input: {
      messages: ConversationMessage[];
      tools: ToolDefinition[];
    }) => MockResponse | undefined
  ): void {
    this.responseHandlers.set(name, handler);
  }

  /**
   * Remove a response handler.
   */
  unregisterResponseHandler(name: string): void {
    this.responseHandlers.delete(name);
  }

  /**
   * Configure the provider to simulate a tool call flow.
   * First response will request tool calls, second will be the final response.
   */
  simulateToolCallFlow(
    toolCalls: ToolCall[],
    finalResponseText: string,
    intermediateText = "I'll help you with that..."
  ): void {
    this.queueResponse({
      text: intermediateText,
      toolCalls,
      stopReason: "tool_use",
      usage: { inputTokens: 200, outputTokens: 100, totalTokens: 300 },
    });
    this.queueResponse({
      text: finalResponseText,
      toolCalls: [],
      stopReason: "end_turn",
      usage: { inputTokens: 300, outputTokens: 150, totalTokens: 450 },
    });
  }

  /**
   * Configure the provider to simulate an error recovery flow.
   * First: tool call with expected error
   * Second: tool call to fix the error
   * Third: final success response
   */
  simulateErrorRecoveryFlow(
    firstToolCall: ToolCall,
    secondToolCall: ToolCall,
    finalResponseText: string
  ): void {
    this.queueResponse({
      text: "Let me try that...",
      toolCalls: [firstToolCall],
      stopReason: "tool_use",
      usage: { inputTokens: 200, outputTokens: 100, totalTokens: 300 },
    });
    this.queueResponse({
      text: "I see the error, let me fix it...",
      toolCalls: [secondToolCall],
      stopReason: "tool_use",
      usage: { inputTokens: 300, outputTokens: 120, totalTokens: 420 },
    });
    this.queueResponse({
      text: finalResponseText,
      toolCalls: [],
      stopReason: "end_turn",
      usage: { inputTokens: 350, outputTokens: 150, totalTokens: 500 },
    });
  }

  /**
   * Configure the provider to simulate a multi-tool sequence.
   */
  simulateMultiToolSequence(
    sequences: Array<{ toolCalls: ToolCall[]; responseText: string }>,
    finalResponseText: string
  ): void {
    for (const seq of sequences) {
      this.queueResponse({
        text: seq.responseText,
        toolCalls: seq.toolCalls,
        stopReason: "tool_use",
        usage: { inputTokens: 200, outputTokens: 100, totalTokens: 300 },
      });
    }
    this.queueResponse({
      text: finalResponseText,
      toolCalls: [],
      stopReason: "end_turn",
      usage: { inputTokens: 400, outputTokens: 200, totalTokens: 600 },
    });
  }

  // --------------------------------------------------------------------------
  // IAIProvider Implementation
  // --------------------------------------------------------------------------

  async chat(
    systemPrompt: string,
    messages: ConversationMessage[],
    tools: ToolDefinition[]
  ): Promise<ProviderResponse> {
    // Try response handlers first
    for (const handler of this.responseHandlers.values()) {
      const handled = handler({ messages, tools });
      if (handled) {
        this.recordInteraction(systemPrompt, messages, tools, handled);
        await this.chatSpy(systemPrompt, messages, tools);
        return this.toProviderResponse(handled);
      }
    }

    // Use queued response or default
    const response = this.responseQueue.shift() ?? this.defaultResponse;
    this.recordInteraction(systemPrompt, messages, tools, response);
    await this.chatSpy(systemPrompt, messages, tools);
    return this.toProviderResponse(response);
  }

  // --------------------------------------------------------------------------
  // IStreamingProvider Implementation
  // --------------------------------------------------------------------------

  async chatStream(
    systemPrompt: string,
    messages: ConversationMessage[],
    tools: ToolDefinition[],
    onChunk: (chunk: string) => void
  ): Promise<ProviderResponse> {
    // Get the response first
    let response: MockResponse;

    for (const handler of this.responseHandlers.values()) {
      const handled = handler({ messages, tools });
      if (handled) {
        response = handled;
        break;
      }
    }
    response ??= this.responseQueue.shift() ?? this.defaultResponse;

    // Simulate streaming by breaking text into chunks
    if (response.text) {
      const words = response.text.split(" ");
      for (const word of words) {
        onChunk(word + " ");
        // Small delay to simulate streaming (can be mocked)
        await new Promise((resolve) => setTimeout(resolve, 1));
      }
    }

    this.recordInteraction(systemPrompt, messages, tools, response);
    await this.chatStreamSpy(systemPrompt, messages, tools, onChunk);
    return this.toProviderResponse(response);
  }

  // --------------------------------------------------------------------------
  // Utility Methods
  // --------------------------------------------------------------------------

  private recordInteraction(
    systemPrompt: string,
    messages: ConversationMessage[],
    tools: ToolDefinition[],
    response: MockResponse
  ): void {
    this.interactions.push({
      systemPrompt,
      messages: [...messages],
      tools: [...tools],
      response,
      timestamp: new Date(),
    });
  }

  private toProviderResponse(mockResponse: MockResponse): ProviderResponse {
    return {
      text: mockResponse.text,
      toolCalls: mockResponse.toolCalls,
      stopReason: mockResponse.stopReason,
      usage: mockResponse.usage,
    };
  }

  /**
   * Clear all captured interactions and reset response queue.
   */
  clear(): void {
    this.interactions.length = 0;
    this.responseQueue.length = 0;
    this.responseHandlers.clear();
  }

  /**
   * Get the last interaction.
   */
  getLastInteraction(): ProviderInteraction | undefined {
    return this.interactions[this.interactions.length - 1];
  }

  /**
   * Get interactions that contained tool calls.
   */
  getToolCallInteractions(): ProviderInteraction[] {
    return this.interactions.filter((i) => i.response.toolCalls.length > 0);
  }

  /**
   * Get interactions that resulted in errors (can be inferred from context).
   */
  getErrorInteractions(): ProviderInteraction[] {
    return this.interactions.filter(
      (i) =>
        i.messages.some(
          (m) => m.role === "user" && 
            Array.isArray(m.content) &&
            m.content.some((block: { type?: string; is_error?: boolean }) => block.type === "tool_result" && block.is_error)
        )
    );
  }

  /**
   * Assert that a specific tool was called.
   */
  assertToolCalled(toolName: string): void {
    const called = this.interactions.some((i) =>
      i.response.toolCalls.some((tc) => tc.name === toolName)
    );
    if (!called) {
      throw new Error(
        `Expected tool "${toolName}" to be called, but it wasn't. Called tools: ${
          this.interactions
            .flatMap((i) => i.response.toolCalls.map((tc) => tc.name))
            .join(", ") || "none"
        }`
      );
    }
  }

  /**
   * Assert that a specific message content was sent to the LLM.
   */
  assertMessageSent(contentPattern: string | RegExp): void {
    const found = this.interactions.some((i) =>
      i.messages.some((m) => {
        if (m.role === "user" && typeof m.content === "string") {
          if (typeof contentPattern === "string") {
            return m.content.includes(contentPattern);
          }
          return contentPattern.test(m.content);
        }
        return false;
      })
    );
    if (!found) {
      throw new Error(
        `Expected message matching "${contentPattern}" to be sent to LLM, but it wasn't`
      );
    }
  }

  /**
   * Get all tool calls made during interactions.
   */
  getAllToolCalls(): ToolCall[] {
    return this.interactions.flatMap((i) => i.response.toolCalls);
  }

  /**
   * Wait for a specific number of interactions.
   */
  async waitForInteractions(count: number, timeoutMs = 5000): Promise<void> {
    const start = Date.now();
    while (this.interactions.length < count) {
      if (Date.now() - start > timeoutMs) {
        throw new Error(
          `Timeout waiting for ${count} interactions. Got ${this.interactions.length}`
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
}

/**
 * Create a mock provider with common configurations.
 */
export function createMockProvider(config?: MockProviderConfig): MockAIProvider {
  return new MockAIProvider(config);
}

/**
 * Create a mock provider that simulates streaming responses.
 */
export function createStreamingMockProvider(
  config?: Omit<MockProviderConfig, "streaming">
): MockAIProvider {
  return new MockAIProvider({
    ...config,
    streaming: true,
  });
}

/**
 * Create a mock provider with pre-configured responses for common scenarios.
 */
export function createScenarioMockProvider(
  scenario: "file-read" | "code-search" | "build-success" | "build-error" | "echo"
): MockAIProvider {
  const provider = new MockAIProvider();

  switch (scenario) {
    case "file-read":
      provider.simulateToolCallFlow(
        [
          {
            id: "tool-1",
            name: "file_read",
            input: { path: "Assets/Scripts/PlayerController.cs" },
          },
        ],
        "I found the PlayerController.cs file. It contains the player movement logic."
      );
      break;

    case "code-search":
      provider.simulateToolCallFlow(
        [
          {
            id: "tool-1",
            name: "code_search",
            input: { query: "damage calculation" },
          },
        ],
        "Found 3 results for damage calculation in the Combat module."
      );
      break;

    case "build-success":
      provider.simulateToolCallFlow(
        [
          {
            id: "tool-1",
            name: "dotnet_build",
            input: {},
          },
        ],
        "Build succeeded with no errors or warnings."
      );
      break;

    case "build-error":
      provider.simulateToolCallFlow(
        [
          {
            id: "tool-1",
            name: "dotnet_build",
            input: {},
          },
        ],
        "The build failed with compilation errors."
      );
      break;

    case "echo":
      provider.setDefaultResponse({
        text: "Echo response",
        toolCalls: [],
        stopReason: "end_turn",
      });
      break;
  }

  return provider;
}

/**
 * Helper to create a ToolCall object.
 */
export function createMockToolCall(
  id: string,
  name: string,
  input: Record<string, unknown>
): ToolCall {
  return { id, name, input: input as JsonObject };
}

/**
 * Helper to create a sequence of mock responses for complex flows.
 */
export function createMockResponseSequence(responses: Partial<MockResponse>[]): MockResponseSequence {
  return {
    responses: responses.map((r) => ({
      text: "",
      toolCalls: [],
      stopReason: "end_turn" as StopReason,
      usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
      ...r,
    })) as MockResponse[],
    currentIndex: 0,
  };
}
