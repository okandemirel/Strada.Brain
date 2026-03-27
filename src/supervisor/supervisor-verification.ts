import type { IAIProvider } from "../agents/providers/provider.interface.js";
import { canonicalizeProviderName } from "../agents/providers/provider-identity.js";
import type {
  NodeResult,
  SupervisorContext,
  VerificationVerdict,
} from "./supervisor-types.js";

function extractIssues(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const issues = value
    .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
    .filter((entry) => entry.length > 0)
    .slice(0, 5);
  return issues.length > 0 ? issues : undefined;
}

export function parseSupervisorVerificationVerdict(
  responseText: string | undefined,
  verifierProvider: string,
): VerificationVerdict {
  const trimmed = responseText?.trim() ?? "";
  if (!trimmed) {
    return {
      verdict: "flag_issues",
      issues: ["Verifier returned an empty review."],
      verifierProvider,
    };
  }

  const jsonMatch = trimmed.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[0]) as {
        verdict?: string;
        issues?: unknown;
        approved?: boolean;
        reasoning?: string;
      };
      if (parsed.verdict === "approve" || parsed.verdict === "flag_issues" || parsed.verdict === "reject") {
        return {
          verdict: parsed.verdict,
          issues: extractIssues(parsed.issues),
          verifierProvider,
        };
      }
      if (typeof parsed.approved === "boolean") {
        return {
          verdict: parsed.approved ? "approve" : "reject",
          issues:
            typeof parsed.reasoning === "string" && parsed.reasoning.trim().length > 0
              ? [parsed.reasoning.trim()]
              : undefined,
          verifierProvider,
        };
      }
    } catch {
      // Fall through to best-effort parsing.
    }
  }

  if (/\bapprove(?:d)?\b/i.test(trimmed) && !/\breject(?:ed)?\b/i.test(trimmed)) {
    return { verdict: "approve", verifierProvider };
  }

  return {
    verdict: "flag_issues",
    issues: [trimmed.slice(0, 240)],
    verifierProvider,
  };
}

function buildVerificationPrompt(node: NodeResult): string {
  const files = node.artifacts
    .slice(0, 8)
    .map((artifact) => `- ${artifact.action}: ${artifact.path}`);
  const toolErrors = node.toolResults
    .filter((result) => result.isError)
    .slice(0, 4)
    .map((result) => `- ${result.content.slice(0, 160)}`);

  return [
    "Review this supervisor worker result for obvious correctness, completeness, and safety issues.",
    "Approve if the result looks internally consistent and ready to merge upward.",
    "Reject only for clear defects or contradictions.",
    'Respond with strict JSON: {"verdict":"approve"} or {"verdict":"flag_issues","issues":["..."]} or {"verdict":"reject","issues":["..."]}.',
    "",
    `Node: ${node.nodeId}`,
    `Original provider: ${node.provider}`,
    `Original model: ${node.model}`,
    "",
    "Worker output:",
    node.output.slice(0, 1800),
    "",
    files.length > 0 ? `Touched files:\n${files.join("\n")}` : "Touched files: none reported",
    toolErrors.length > 0 ? `Tool errors:\n${toolErrors.join("\n")}` : "",
  ].filter(Boolean).join("\n");
}

function chooseVerificationProvider(
  providerManager: {
    listExecutionCandidates?(identityKey?: string): Array<{ name: string; defaultModel: string }>;
    listAvailable(): Array<{ name: string; defaultModel: string }>;
    getProviderByName(name: string, model?: string): IAIProvider | null;
  },
  originalProviderName: string,
  identityKey?: string,
): { providerName: string; model: string; provider: IAIProvider } | null {
  const originalProvider = canonicalizeProviderName(originalProviderName) ?? originalProviderName;
  const candidates = [
    ...(providerManager.listExecutionCandidates?.(identityKey) ?? []),
    ...providerManager.listAvailable(),
  ];
  const seen = new Set<string>();

  for (const candidate of candidates) {
    const canonicalName = canonicalizeProviderName(candidate.name) ?? candidate.name;
    if (!canonicalName || canonicalName === originalProvider || seen.has(canonicalName)) {
      continue;
    }
    seen.add(canonicalName);
    const provider = providerManager.getProviderByName(canonicalName, candidate.defaultModel);
    if (provider) {
      return {
        providerName: canonicalName,
        model: candidate.defaultModel,
        provider,
      };
    }
  }

  return null;
}

export function createSupervisorNodeVerifier(providerManager: {
  listExecutionCandidates?(identityKey?: string): Array<{ name: string; defaultModel: string }>;
  listAvailable(): Array<{ name: string; defaultModel: string }>;
  getProviderByName(name: string, model?: string): IAIProvider | null;
}): (node: NodeResult, context: SupervisorContext) => Promise<VerificationVerdict> {
  return async (node: NodeResult, context: SupervisorContext): Promise<VerificationVerdict> => {
    const reviewer = chooseVerificationProvider(providerManager, node.provider, context.chatId);
    if (!reviewer) {
      return {
        verdict: "approve",
        verifierProvider: canonicalizeProviderName(node.provider) ?? node.provider,
      };
    }

    try {
      const response = await reviewer.provider.chat(
        "You are a verification agent. Review another worker's result for obvious issues and reply with strict JSON only.",
        [{ role: "user", content: buildVerificationPrompt(node) }],
        [],
      );
      return parseSupervisorVerificationVerdict(response.text, reviewer.providerName);
    } catch (error) {
      return {
        verdict: "flag_issues",
        issues: [error instanceof Error ? error.message : String(error)],
        verifierProvider: reviewer.providerName,
      };
    }
  };
}
