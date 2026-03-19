import type { PhaseOutcomeStatus, PhaseVerdict, VerifierDecision } from "./routing-types.js";

export interface DerivedPhaseVerdict {
  readonly label: PhaseVerdict;
  readonly score: number;
}

export function derivePhaseVerdict(
  status: PhaseOutcomeStatus | undefined,
  verifierDecision?: VerifierDecision,
): DerivedPhaseVerdict | null {
  switch (status) {
    case "approved":
      return {
        label: "clean",
        score: verifierDecision === "approve" ? 1 : 0.9,
      };
    case "continued":
      return {
        label: "retry",
        score: verifierDecision === "continue" ? 0.62 : 0.55,
      };
    case "replanned":
      return {
        label: "failure",
        score: verifierDecision === "replan" ? 0.18 : 0.12,
      };
    case "blocked":
      return { label: "failure", score: 0.08 };
    case "failed":
      return { label: "failure", score: 0 };
    default:
      return null;
  }
}

export function scorePhaseVerdictFallback(
  status: PhaseOutcomeStatus | undefined,
  verifierDecision?: VerifierDecision,
): number {
  return derivePhaseVerdict(status, verifierDecision)?.score ?? 0.55;
}
