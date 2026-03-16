/**
 * Provider Knowledge Module
 *
 * Contains behavioral hints, strengths, limitations, and context window
 * recommendations for each supported AI provider. Used by the Orchestrator
 * to inject provider-specific intelligence into system prompts and to
 * determine dynamic conversation trimming thresholds.
 */

export interface ProviderKnowledge {
  readonly provider: string;
  readonly strengths: string[];
  readonly limitations: string[];
  readonly behavioralHints: string[];
  readonly contextWindow: number;
  readonly maxMessages: number; // recommended max conversation messages before trimming
}

export const PROVIDER_KNOWLEDGE: Record<string, ProviderKnowledge> = {
  claude: {
    provider: "Claude (Anthropic)",
    strengths: [
      "Excellent tool calling",
      "Strong code generation",
      "Nuanced reasoning",
      "1M context window",
    ],
    limitations: ["No web search", "No real-time data"],
    behavioralHints: [
      "Prefer structured tool calls over code blocks",
      "Use prompt caching for long system prompts",
    ],
    contextWindow: 1_000_000,
    maxMessages: 80,
  },
  openai: {
    provider: "OpenAI GPT",
    strengths: [
      "Strong general knowledge",
      "Good function calling",
      "Large context",
    ],
    limitations: ["Tool call format differs from Claude"],
    behavioralHints: [
      "Use JSON mode for structured output when available",
    ],
    contextWindow: 1_050_000,
    maxMessages: 60,
  },
  gemini: {
    provider: "Google Gemini",
    strengths: [
      "1M context window",
      "Fast inference",
      "Multimodal",
      "Grounding with Google Search",
    ],
    limitations: ["thought_signature must be preserved in multi-turn"],
    behavioralHints: [
      "Leverage grounding for factual questions",
      "thinking_level configurable",
    ],
    contextWindow: 1_000_000,
    maxMessages: 80,
  },
  deepseek: {
    provider: "DeepSeek",
    strengths: [
      "Excellent cost/quality ratio",
      "Strong reasoning (R1)",
      "Context caching",
    ],
    limitations: ["8K max output", "Occasional latency spikes"],
    behavioralHints: [
      "Use for cost-effective reasoning tasks",
      "Reasoning content in <reasoning> blocks",
    ],
    contextWindow: 128_000,
    maxMessages: 40,
  },
  qwen: {
    provider: "Qwen (Alibaba)",
    strengths: [
      "Web search integration",
      "Strong multilingual",
      "1M context",
    ],
    limitations: ["DashScope API differences"],
    behavioralHints: [
      "Enable web search for current information queries",
      "Good for multilingual tasks",
    ],
    contextWindow: 1_000_000,
    maxMessages: 60,
  },
  kimi: {
    provider: "Kimi (Moonshot)",
    strengths: [
      "Specialized for coding",
      "262K context",
      "Reasoning support",
    ],
    limitations: [
      "Requires User-Agent header",
      "Smaller model selection",
    ],
    behavioralHints: [
      "Best for code-heavy tasks",
      "reasoning_content in responses",
    ],
    contextWindow: 262_000,
    maxMessages: 50,
  },
  minimax: {
    provider: "MiniMax",
    strengths: [
      "1M context",
      "Reasoning details extraction",
      "Good pricing",
    ],
    limitations: ["Smaller ecosystem", "Bot group limitation"],
    behavioralHints: [
      "Use reasoning details for complex analysis",
    ],
    contextWindow: 1_000_000,
    maxMessages: 60,
  },
  groq: {
    provider: "Groq",
    strengths: [
      "Extremely fast inference (500+ t/s)",
      "Open model support",
    ],
    limitations: ["Limited model selection", "Rate limits"],
    behavioralHints: [
      "Best for latency-sensitive tasks",
      "Use for quick delegation",
    ],
    contextWindow: 128_000,
    maxMessages: 40,
  },
  mistral: {
    provider: "Mistral",
    strengths: [
      "Strong coding",
      "safe_prompt content moderation",
      "Good European alternative",
    ],
    limitations: ["Smaller context than competitors"],
    behavioralHints: [
      "Use safe_prompt for content moderation control",
    ],
    contextWindow: 262_000,
    maxMessages: 50,
  },
  together: {
    provider: "Together AI",
    strengths: [
      "Open model hosting",
      "1M context (Llama 4)",
      "Good pricing",
    ],
    limitations: ["Model availability varies"],
    behavioralHints: [
      "Good for open model experimentation",
    ],
    contextWindow: 1_000_000,
    maxMessages: 60,
  },
  fireworks: {
    provider: "Fireworks AI",
    strengths: [
      "Fast inference",
      "Open model hosting",
      "Competitive pricing",
    ],
    limitations: ["Similar to Together in model selection"],
    behavioralHints: [
      "Good for fast open model inference",
    ],
    contextWindow: 1_000_000,
    maxMessages: 60,
  },
  ollama: {
    provider: "Ollama (Local)",
    strengths: [
      "Free",
      "Privacy",
      "No API dependency",
      "Custom models",
    ],
    limitations: [
      "Limited context (8K default)",
      "Slower than cloud",
      "Quality depends on model",
    ],
    behavioralHints: [
      "Keep responses concise",
      "Avoid complex multi-step reasoning",
      "Simple tool calls preferred",
    ],
    contextWindow: 8_000,
    maxMessages: 15,
  },
};

/**
 * Format a context window size (in tokens) as a human-readable string.
 * Example: 1_000_000 -> "1000K"
 */
export function formatContextWindow(tokens: number): string {
  return `${(tokens / 1000).toFixed(0)}K`;
}

/**
 * Build a provider intelligence section for the system prompt.
 * Returns a string to inject into the system prompt.
 */
export function buildProviderIntelligence(
  providerName: string,
  modelId?: string,
): string {
  const knowledge = PROVIDER_KNOWLEDGE[providerName];
  if (!knowledge) return "";

  const lines: string[] = [
    `\n## Current Provider Intelligence`,
    `Provider: ${knowledge.provider}`,
    `Model: ${modelId ?? "default"}`,
    `Context Window: ${formatContextWindow(knowledge.contextWindow)} tokens`,
    `Strengths: ${knowledge.strengths.join(", ")}`,
  ];

  if (knowledge.limitations.length > 0) {
    lines.push(`Limitations: ${knowledge.limitations.join(", ")}`);
  }

  if (knowledge.behavioralHints.length > 0) {
    lines.push(`Hints: ${knowledge.behavioralHints.join(". ")}`);
  }

  return lines.join("\n");
}

/**
 * Get recommended max messages for conversation trimming based on provider.
 */
export function getRecommendedMaxMessages(providerName: string): number {
  return PROVIDER_KNOWLEDGE[providerName]?.maxMessages ?? 40;
}
