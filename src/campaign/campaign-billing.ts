/**
 * Who pays for the campaign's own LLM calls (task #71), and for which
 * campaign (task #73).
 *
 * Planning, acceptance authoring, visual conformance and style analysis are
 * campaign-level work: they belong to no task run, so they bill the process
 * counters and the cost ledger without a run's sink. The campaign's own tasks
 * are submitted with origin "user", which the background executor books as
 * "chat" — the campaign's planning spend lands in the same bucket.
 *
 * The row also names the campaign, so the delivery package's "what did this
 * campaign cost" (sumBudgetForCampaign) counts it. The campaign is a scope,
 * not a parameter: the planner is one shared instance whose calls run several
 * methods deep, and neither campaign-manager.ts nor campaign-planner.ts may
 * grow (file-size contract). CampaignManager wraps each campaign-level call in
 * {@link forCampaign}; the call site bills {@link campaignBilling}.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import type { OwnerlessBilling } from "../agents/providers/billed-call.js";
import { getLoggerSafe } from "../utils/logger.js";

/** The milestone ladder and its planning/coverage calls: campaign-level, no run owns them. */
export const PLANNING_BILLING: OwnerlessBilling = { purpose: "campaign-planning", ownerless: "chat" };

/** The acceptance writer's calls: campaign-level, no run owns them. */
export const ACCEPTANCE_AUTHOR_BILLING: OwnerlessBilling = { purpose: "acceptance-author", ownerless: "chat" };

/** The vision check of a delivered frame against the GDD: campaign-level, no run owns it. */
export const VISUAL_CONFORMANCE_BILLING: OwnerlessBilling = { purpose: "visual-conformance", ownerless: "chat" };

/** The style profile derived from the GDD: campaign-level, no run owns it. */
export const STYLE_ANALYSIS_BILLING: OwnerlessBilling = { purpose: "style-analysis", ownerless: "chat" };

const campaignInScope = new AsyncLocalStorage<string>();

/** Run `work` for campaign `campaignId`: every campaign-level call it makes is booked to that campaign. */
export function forCampaign<T>(campaignId: string, work: () => T): T {
  return campaignInScope.run(campaignId, work);
}

/**
 * The billing a campaign-level call is booked under: `base`, naming the
 * campaign in scope. A call outside any campaign still bills (tokens are
 * tokens), but no campaign's cost can see it, so that is logged.
 */
export function campaignBilling(base: OwnerlessBilling): OwnerlessBilling {
  const campaignId = campaignInScope.getStore();
  if (campaignId === undefined) {
    getLoggerSafe().warn("Campaign-level call made outside a campaign — its cost is booked to no campaign", { purpose: base.purpose });
    return base;
  }
  return { ...base, campaignId };
}
