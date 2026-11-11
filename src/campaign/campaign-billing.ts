/**
 * Who pays for the campaign's own LLM calls (task #71).
 *
 * Planning, acceptance authoring, visual conformance and style analysis are
 * campaign-level work: they belong to no task run, so they bill the process
 * counters and the cost ledger without a run's sink. The campaign's own tasks
 * are submitted with origin "user", which the background executor books as
 * "chat" — the campaign's planning spend lands in the same bucket.
 */

import type { OwnerlessBilling } from "../agents/providers/billed-call.js";

/** The milestone ladder and its planning/coverage calls: campaign-level, no run owns them. */
export const PLANNING_BILLING: OwnerlessBilling = { purpose: "campaign-planning", ownerless: "chat" };

/** The acceptance writer's calls: campaign-level, no run owns them. */
export const ACCEPTANCE_AUTHOR_BILLING: OwnerlessBilling = { purpose: "acceptance-author", ownerless: "chat" };

/** The vision check of a delivered frame against the GDD: campaign-level, no run owns it. */
export const VISUAL_CONFORMANCE_BILLING: OwnerlessBilling = { purpose: "visual-conformance", ownerless: "chat" };

/** The style profile derived from the GDD: campaign-level, no run owns it. */
export const STYLE_ANALYSIS_BILLING: OwnerlessBilling = { purpose: "style-analysis", ownerless: "chat" };
