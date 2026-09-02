/**
 * Approved by every verifier, and still not delivered.
 *
 * The conformance gates are asks, and an ask must be able to give up or it turns
 * into a loop. But going quiet was read as satisfied: measured on run 52,
 * [STRADA NOTHING DRAWN] fired three times, fell silent on the fourth, and the
 * run finished with a 123-character success message for a game whose sixty
 * captured frames were identical. The gate's own last words were "say the game
 * does not render rather than reporting it as delivered" — advice with nothing
 * behind it.
 *
 * audited 2026-09-02: this lived inside orchestrator-end-turn-handler.ts and
 * was applied only there. The reflection DONE route — the normal completion
 * route once the agent reflects and says done — is a second terminal handler
 * and delivered without it. Shared here so both routes account the same way.
 *
 * Returns null when there is nothing outstanding, so the ordinary path is
 * untouched.
 */

import type { StradaConformanceGuard } from "./autonomy/strada-conformance.js";

export function notDeliveredReport(
  conformance: StradaConformanceGuard,
  finalText: string,
): { text: string; reason: string } | null {
  const unmet = conformance.unmetDeliveryConditions();
  if (unmet.length === 0) return null;

  const reason = unmet.join("; ");
  return {
    reason,
    text: (
      `${finalText}\n\n` +
      `NOT DELIVERED — ${reason}. ` +
      "This is the run's own measurement, not a review: the work above is real, " +
      "but it does not yet add up to the thing that was asked for."
    ).trim(),
  };
}
