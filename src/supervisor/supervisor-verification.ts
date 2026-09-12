import type { IAIProvider } from "../agents/providers/provider.interface.js";
import { stripLeakedReasoning } from "../agents/leaked-reasoning.js";
import { streamOrChatText } from "../agents/providers/provider.interface.js";
import { canonicalizeProviderName } from "../agents/providers/provider-identity.js";
import { ProviderHealthRegistry } from "../agents/providers/provider-health.js";
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

  // A thinking model that leaks its block. Measured 2026-09-07 (campaign
  // mcov1, attempt 2): five verifier replies in one task began "<reasoning>
  // Here's a thinking process:" and ended mid-sentence at the token cap.
  // Each was pasted, 240 chars of it, as a "VERIFIER FLAG" on a node that
  // nobody had reviewed. A terminated block is stripped so a verdict after it
  // still parses; an unterminated one is named for what it is.
  const { text: withoutReasoning, reasoningOnly } = stripLeakedReasoning(trimmed);
  if (reasoningOnly) {
    return {
      verdict: "flag_issues",
      issues: [
        `Verifier produced no verdict: its reply was an unterminated reasoning block (${trimmed.length} chars) ` +
          `cut off before any JSON — the token cap or a thinking model leaking its block (${verifierProvider}). ` +
          "This node was not reviewed.",
      ],
      verifierProvider,
    };
  }

  const jsonMatch = withoutReasoning.match(/\{[\s\S]*\}/);
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

  // No free-text approve arm. "I cannot approve this without a build" contains
  // the word "approve" and no "reject" — the old substring test read that as
  // an approval. A verifier that did not answer in the requested JSON did not
  // render a verdict; its prose is a flag, never a pass.
  return {
    verdict: "flag_issues",
    issues: [`Verifier returned prose, not a verdict: ${withoutReasoning.slice(0, 240)}`],
    verifierProvider,
  };
}


/**
 * How much of the worker's output the verifier sees. Was 1 800 characters —
 * measured 2026-09-10: a node's structured result (a JSON block with a
 * `tests` object) was cut mid-object by THIS slice, and the verifier rejected
 * the node three times as "Worker output is truncated/incomplete: the `tests`
 * object is not closed". The truncation was the verifier's own. The cap is
 * now generous, and when it does cut, the prompt says so and forbids judging
 * the cut as the worker's incompleteness.
 */
export const VERIFICATION_OUTPUT_CHARS = 12_000;

export function buildVerificationPrompt(node: NodeResult): string {
  const files = node.artifacts
    .slice(0, 8)
    .map((artifact) => `- ${artifact.action}: ${artifact.path}`);
  const toolErrors = node.toolResults
    .filter((result) => result.isError)
    .slice(0, 4)
    .map((result) => `- ${result.content.slice(0, 400)}`);
  const cut = node.output.length > VERIFICATION_OUTPUT_CHARS;
  const shownOutput = cut
    ? `${node.output.slice(0, VERIFICATION_OUTPUT_CHARS)}\n[… cut by the system at ${VERIFICATION_OUTPUT_CHARS} of ${node.output.length} characters — judge what is shown; an unclosed block here is this cut, NOT the worker's incompleteness]`
    : node.output;

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
    shownOutput,
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
    getPrimaryProviderByName?(name: string, model?: string): IAIProvider | null;
    /** May work be routed to this provider at all? (strict PROVIDER_CHAIN) */
    allowsProvider?(name: string): boolean;
  },
  originalProviderName: string,
  identityKey?: string,
): { providerName: string; model: string; provider: IAIProvider } | null {
  const originalProvider = canonicalizeProviderName(originalProviderName) ?? originalProviderName;
  // THE REVIEWER IS WORK TOO. This pool appended everything with a
  // credential, so the ordinary verifier ran on a provider the operator's
  // strict chain excludes (Codex 2026-09-12 P#1).
  const candidates = [
    ...(providerManager.listExecutionCandidates?.(identityKey) ?? []),
    ...providerManager.listAvailable(),
  ].filter((candidate) => providerManager.allowsProvider?.(candidate.name) !== false);
  const seen = new Set<string>();

  for (const candidate of candidates) {
    const canonicalName = canonicalizeProviderName(candidate.name) ?? candidate.name;
    if (!canonicalName || canonicalName === originalProvider || seen.has(canonicalName)) {
      continue;
    }
    seen.add(canonicalName);
    // Credential-listed is not usable: a quota-dead provider passes
    // listAvailable() and used to be picked here — then materialized as a
    // resilient CHAIN that silently answered on the worker's own provider
    // while the verdict was stamped with the dead one's name. A false
    // cross-provider audit trail over what was actually self-review.
    if (!ProviderHealthRegistry.getInstance().isAvailable(canonicalName)) {
      continue;
    }
    // BARE provider, never a chain: cross-provider verification that can fall
    // over to a sibling is not cross-provider verification.
    const provider =
      providerManager.getPrimaryProviderByName?.(canonicalName, candidate.defaultModel) ??
      providerManager.getProviderByName(canonicalName, candidate.defaultModel);
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
  getPrimaryProviderByName?(name: string, model?: string): IAIProvider | null;
}): (node: NodeResult, context: SupervisorContext) => Promise<VerificationVerdict> {
  return async (node: NodeResult, context: SupervisorContext): Promise<VerificationVerdict> => {
    let reviewer = chooseVerificationProvider(providerManager, node.provider, context.chatId);
    let independent = true;
    if (!reviewer) {
      // No OTHER healthy provider: review with the worker's own, in a fresh
      // context, and say so. A skip verified nothing; a same-provider read
      // still catches the obvious, and the verdict carries the caveat.
      const own = canonicalizeProviderName(node.provider) ?? node.provider;
      if (own && ProviderHealthRegistry.getInstance().isAvailable(own)) {
        const provider = providerManager.getPrimaryProviderByName?.(own) ?? providerManager.getProviderByName(own);
        if (provider) {
          reviewer = { providerName: `${own} (same provider — no independent verifier was healthy)`, model: "", provider };
          independent = false;
        }
      }
    }
    if (!reviewer) {
      return {
        verdict: "flag_issues" as const,
        issues: [
          "verification_skipped: no HEALTHY cross-provider verifier (every other provider is in cooldown or unconfigured) — this node was NOT independently verified",
        ],
        verifierProvider: canonicalizeProviderName(node.provider) ?? node.provider,
      };
    }

    try {
      // STREAM the cross-provider verification review (mirrors the goal-decomposer fix).
      // The reviewer is drawn from the execution candidates, which can include a slow
      // REASONING model (e.g. deepseek-v4-pro). A blocking provider.chat() never reports
      // activity, so the FallbackChain's first-response timer degenerates into a whole-call
      // deadline and aborts with "sent no response within Nms" before a long, silent think
      // completes. chatStream fires markActivity on the first SSE chunk → the timer clears →
      // the review is allowed to COMPLETE. Parsing is byte-identical (we parse response.text).
      const response = await streamOrChatText(
        reviewer.provider,
        "You are a verification agent. Review another worker's result for obvious issues and reply with strict JSON only.",
        buildVerificationPrompt(node),
      );
      const parsed = parseSupervisorVerificationVerdict(response.text, reviewer.providerName);
      return independent ? parsed : { ...parsed, independent: false };
    } catch (error) {
      return {
        verdict: "flag_issues",
        issues: [error instanceof Error ? error.message : String(error)],
        verifierProvider: reviewer.providerName,
        ...(independent ? {} : { independent: false }),
      };
    }
  };
}
