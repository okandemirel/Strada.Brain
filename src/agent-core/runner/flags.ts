/**
 * Agent Core v2 — enumerated legal flag combinations (P-F, ARCHITECTURE §0 fix #10,
 * PLAN §4). The cross product of per-route driver flags × per-concern control-plane
 * sub-flags is NOT free-form: shippable-but-untested configs are reachable in a free
 * matrix. Boot REJECTS any combination not in `LEGAL_FLAG_SETS`. Reversibility ≠
 * correctness-in-combination, so untested combos are unreachable by construction.
 */

/** Per-route driver selection (Phase 0: every route is `"v1"`). */
export type DriverChoice = "v1" | "v2";

export interface FlagSet {
  readonly id: string;
  /** Driver per route. */
  readonly interactive: DriverChoice;
  readonly background: DriverChoice;
  readonly worker: DriverChoice;
  readonly supervisorNode: DriverChoice;
  /** Control-plane per-concern sub-flags (Phase 1; all false in Phase 0). */
  readonly failureLedger: boolean; // 1a
  readonly runClock: boolean; // 1b
  readonly silenceAccumulator: boolean; // 1c
  readonly typedCancelReason: boolean; // 1d
  /** Phase 3. */
  readonly providerRouterScoring: boolean; // 3a (shadow→flip)
  readonly capabilityRegistry: boolean; // 3b
  /** Phase 5. */
  readonly streamVisibleTokens: boolean;
}

/** The ordered list of every comparable flag field (id excluded). Single source for equality. */
const FLAG_FIELDS = [
  "interactive",
  "background",
  "worker",
  "supervisorNode",
  "failureLedger",
  "runClock",
  "silenceAccumulator",
  "typedCancelReason",
  "providerRouterScoring",
  "capabilityRegistry",
  "streamVisibleTokens",
] as const satisfies readonly (keyof Omit<FlagSet, "id">)[];

/** The requested flag combination — a `FlagSet` without the human-readable `id`. */
export type RequestedFlagSet = Omit<FlagSet, "id">;

const ALL_V1_NO_CP = {
  failureLedger: false,
  runClock: false,
  silenceAccumulator: false,
  typedCancelReason: false,
  providerRouterScoring: false,
  capabilityRegistry: false,
  streamVisibleTokens: false,
} as const;

const FULL_CP = {
  failureLedger: true,
  runClock: true,
  silenceAccumulator: true,
  typedCancelReason: true,
} as const;

export const LEGAL_FLAG_SETS: readonly FlagSet[] = [
  // ── Phase 0 — the ONLY reachable set today: all v1, no control plane. ──
  {
    id: "all-v1",
    interactive: "v1",
    background: "v1",
    worker: "v1",
    supervisorNode: "v1",
    ...ALL_V1_NO_CP,
  },

  // ── Phase 1a — failureLedger in ISOLATION (the other 3 control-plane concerns still OFF). ──
  //    Per-concern incremental rollout must be explicitly enumerated in the closed matrix
  //    (P-F). With runClock/silenceAccumulator/typedCancelReason still false, the ledger's
  //    VerdictInput is inert for those concerns and reduces to the v1 failure surface.
  {
    id: "v1-driver+failure-ledger-only",
    interactive: "v1",
    background: "v1",
    worker: "v1",
    supervisorNode: "v1",
    failureLedger: true,
    runClock: false,
    silenceAccumulator: false,
    typedCancelReason: false,
    providerRouterScoring: false,
    capabilityRegistry: false,
    streamVisibleTokens: false,
  },

  // ── Phase 1b — failureLedger + runClock (the next incremental rung; silence/typed-cancel
  //    still OFF). RunClock's provider-stall / hard-timeout / silence-accumulator signals feed
  //    the ledger's VerdictInput, so the two ship as a pair: runClock alone has no consumer for
  //    its typed signals (rules 2/6 unreachable without the ledger). silenceAccumulator (1c) and
  //    typedCancelReason (1d) layer on next. ──
  {
    id: "v1-driver+failure-ledger+run-clock",
    interactive: "v1",
    background: "v1",
    worker: "v1",
    supervisorNode: "v1",
    failureLedger: true,
    runClock: true,
    silenceAccumulator: false,
    typedCancelReason: false,
    providerRouterScoring: false,
    capabilityRegistry: false,
    streamVisibleTokens: false,
  },

  // ── Phase 1 — v1 driver + full control plane (the consolidation target). ──
  {
    id: "v1-driver+full-control-plane",
    interactive: "v1",
    background: "v1",
    worker: "v1",
    supervisorNode: "v1",
    ...FULL_CP,
    providerRouterScoring: false,
    capabilityRegistry: false,
    streamVisibleTokens: false,
  },

  // ── Phase 2 — V2 per-route rollout order: worker → background → interactive.
  //    Each step requires FULL control plane (V2 consumes it). ──
  {
    id: "v2-worker-only+full-control-plane",
    interactive: "v1",
    background: "v1",
    worker: "v2",
    supervisorNode: "v2",
    ...FULL_CP,
    providerRouterScoring: false,
    capabilityRegistry: false,
    streamVisibleTokens: false,
  },
  {
    id: "v2-worker+background+full-control-plane",
    interactive: "v1",
    background: "v2",
    worker: "v2",
    supervisorNode: "v2",
    ...FULL_CP,
    providerRouterScoring: false,
    capabilityRegistry: false,
    streamVisibleTokens: false,
  },
  {
    id: "v2-all-routes+full-control-plane",
    interactive: "v2",
    background: "v2",
    worker: "v2",
    supervisorNode: "v2",
    ...FULL_CP,
    providerRouterScoring: false,
    capabilityRegistry: false,
    streamVisibleTokens: false,
  },

  // ── Phase 3 — V2 everywhere + scoring + capability. ──
  {
    id: "v2-all+scoring+capability",
    interactive: "v2",
    background: "v2",
    worker: "v2",
    supervisorNode: "v2",
    ...FULL_CP,
    providerRouterScoring: true,
    capabilityRegistry: true,
    streamVisibleTokens: false,
  },

  // ── Phase 5 — add live token streaming on top of the Phase-3 set. ──
  {
    id: "v2-all+scoring+capability+streaming",
    interactive: "v2",
    background: "v2",
    worker: "v2",
    supervisorNode: "v2",
    ...FULL_CP,
    providerRouterScoring: true,
    capabilityRegistry: true,
    streamVisibleTokens: true,
  },
];

/** Phase 0 default; flipping the active set is a config change, not a redeploy. */
export const DEFAULT_FLAG_SET_ID = "all-v1";

/** The Phase-0 default combination as a `RequestedFlagSet` (the `all-v1` fields, no `id`). */
export const DEFAULT_FLAG_SET: RequestedFlagSet = {
  interactive: "v1",
  background: "v1",
  worker: "v1",
  supervisorNode: "v1",
  ...ALL_V1_NO_CP,
};

/** Structural equality over the flag fields (`id` excluded). */
function flagsEqual(a: RequestedFlagSet, b: RequestedFlagSet): boolean {
  return FLAG_FIELDS.every((field) => a[field] === b[field]);
}

/**
 * Resolve + VALIDATE the active flag set at boot. Throws (reject-at-boot) if the requested
 * combination is not in `LEGAL_FLAG_SETS`. The thrown error lists the legal set ids. This is
 * the closed-matrix guarantee (P-F): a V2 route with no control plane, a partial control-plane
 * bundle, or streaming without the full Phase-3 stack are all absent from the list → rejected.
 */
export function resolveLegalFlagSet(requested: RequestedFlagSet): FlagSet {
  const match = LEGAL_FLAG_SETS.find((candidate) => flagsEqual(candidate, requested));
  if (!match) {
    throw new Error(
      "Illegal agent-core flag combination (not in LEGAL_FLAG_SETS). " +
        `Requested: ${JSON.stringify(requested)}. ` +
        `Legal set ids: ${LEGAL_FLAG_SETS.map((s) => s.id).join(", ")}.`,
    );
  }
  return match;
}
