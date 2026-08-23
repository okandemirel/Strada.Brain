import type { ProviderCapabilities } from "./provider-core.interface.js";

type Effort = NonNullable<ProviderCapabilities["reasoningEffort"]>;

/**
 * Recovering from an endpoint that refuses the reasoning_effort we asked for.
 *
 * `reasoningEffort` is declared once per provider class, but it is a property of
 * the MODEL. OpencodeProvider declares "low" and documents "minimal" as the
 * better value — measured, correctly, against deepseek-v4-flash. Point the same
 * provider at ox-alpha-free and "minimal" is HTTP 400 on every single request:
 *
 *   [1210] This model always engages in thinking and cannot be disabled;
 *          please use low, high, or max
 *
 * One env var away from a provider that cannot answer at all. A provider-wide
 * constant cannot be right for every model a provider serves, so instead of
 * guessing per model, the endpoint is allowed to correct us: it names the values
 * it accepts, and we take the cheapest one it named.
 */

/**
 * Does this error say the endpoint rejected our reasoning_effort?
 *
 * Deliberately narrow. A 400 has many causes and retrying the wrong one wastes a
 * request and muddies the error the caller finally sees, so this wants either
 * the parameter named outright or the specific "thinking cannot be disabled"
 * refusal that names no parameter at all.
 */
export function isReasoningEffortRejection(message: string): boolean {
  if (!/\b400\b|bad request/iu.test(message)) return false;
  if (/reasoning[_ ]?effort/iu.test(message)) return true;
  return /thinking[^.]*cannot be (?:disabled|turned off)/iu.test(message);
}

/** Cheapest first: the point of lowering effort is latency, so concede as little as possible. */
const EFFORT_PREFERENCE: readonly Effort[] = ["minimal", "low", "medium", "high"];

/**
 * The effort to retry with, or null to send no reasoning_effort at all.
 *
 * When the endpoint lists what it accepts ("please use low, high, or max") we
 * take the cheapest listed value we can actually express — "max" is not in our
 * vocabulary, so "low" wins over "high" and "max" both. When it lists nothing,
 * dropping the field is the only honest move: any value we invent could be the
 * rejected one again.
 */
export function recoverReasoningEffort(message: string, rejected: Effort): Effort | null {
  const listed = acceptedEfforts(message).filter((e) => e !== rejected);
  for (const candidate of EFFORT_PREFERENCE) {
    if (listed.includes(candidate)) return candidate;
  }
  return null;
}

/** The values an endpoint named as acceptable, in the order we can express them. */
function acceptedEfforts(message: string): Effort[] {
  const match = /(?:please\s+use|must\s+be(?:\s+one\s+of)?|supported\s+values?\s*(?:are|:))\s*([^.;\n]+)/iu
    .exec(message);
  if (!match?.[1]) return [];

  // The list is prose ("low, high, or max"), sometimes quoted. Take the words.
  const words = new Set(
    match[1]
      .toLowerCase()
      .split(/[^a-z]+/u)
      .filter(Boolean),
  );
  return EFFORT_PREFERENCE.filter((e) => words.has(e));
}
