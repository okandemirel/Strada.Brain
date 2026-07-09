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

const FULL_CP = {
  failureLedger: true,
  runClock: true,
  silenceAccumulator: true,
  typedCancelReason: true,
} as const;

export const LEGAL_FLAG_SETS: readonly FlagSet[] = [
  // Cutover Step 5 deleted the v1 engine: every legal set runs the V2 spine on every route
  // with the FULL control plane (V2 consumes it). The remaining ladder differs only in the
  // Phase-3/5 extras. The v1-containing sets (all-v1, the per-concern 1a-1d steps,
  // v1-driver+full-control-plane, and the partial v2-worker rollout steps) were removed with
  // the engine; their ids resolve via DEPRECATED_FLAG_SET_IDS below instead of reject-at-boot.
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

  // ── Phase 3 — scoring + capability. ──
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


/**
 * The PRODUCTION default — what bootstrap selects when AGENT_CORE_FLAG_SET is unset. THE FLIP
 * (cutover Step 4): the V2 engine drives EVERY route (interactive/background/worker/supervisor-node)
 * on the FULL control plane. All flip-blockers shipped + gated (Phase 1 robustness 4a3cf94/7af4ba2/
 * ce32c11, Phase 2 faithfulness 34198f6/3db5f3a/04a018c, soak fixes bbc6e2b/bbd2baf, provider chain
 * 08541aa/de22366/ee5c063). INSTANT REVERT with no redeploy: AGENT_CORE_FLAG_SET=all-v1 (bare v1
 * baseline) or v1-driver+full-control-plane — REMOVED by cutover Step 5 with the v1 engine;
 * both ids now resolve to this production default via DEPRECATED_FLAG_SET_IDS (an ops
 * deployment still exporting a revert value must not crash-loop at boot).
 * Must be a LEGAL_FLAG_SETS id (reject-at-boot enforces it).
 */
export const PRODUCTION_DEFAULT_FLAG_SET_ID = "v2-all-routes+full-control-plane";

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

/**
 * The rollout-era ids cutover Step 5 deleted along with the v1 engine. A deployment (env file,
 * systemd unit, runbook) may still export one as its documented "instant revert" value —
 * rejecting it at boot would CRASH-LOOP the daemon on an upgrade, so these resolve to the
 * production default instead (the ops-safe deprecation; the boot log's "source" field still
 * shows the env var supplied it). Unknown ids outside this list keep the reject-at-boot typo
 * guard.
 */
const DEPRECATED_FLAG_SET_IDS: ReadonlySet<string> = new Set([
  "all-v1",
  "v1-driver+failure-ledger-only",
  "v1-driver+failure-ledger+run-clock",
  "v1-driver+failure-ledger+run-clock+silence-accumulator",
  "v1-driver+full-control-plane",
  "v2-worker-only+full-control-plane",
  "v2-worker+background+full-control-plane",
]);

/**
 * Resolve the active flag set by its `id` — the ops knob (`AGENT_CORE_FLAG_SET` env var) that
 * selects the stage WITHOUT a code change. An undefined/empty id resolves to the production
 * default. A DEPRECATED (deleted rollout-era) id also resolves to the production default —
 * never a boot crash on a stale revert value. An UNKNOWN id throws (reject-at-boot), listing
 * the legal ids — a typo can never silently fall back to the wrong stage. The result is one of
 * `LEGAL_FLAG_SETS` by construction, inheriting the closed-matrix guarantee.
 */
export function resolveFlagSetById(id: string | undefined): FlagSet {
  const trimmed = (id ?? "").trim();
  const wanted =
    !trimmed || DEPRECATED_FLAG_SET_IDS.has(trimmed) ? PRODUCTION_DEFAULT_FLAG_SET_ID : trimmed;
  const match = LEGAL_FLAG_SETS.find((candidate) => candidate.id === wanted);
  if (!match) {
    throw new Error(
      `Unknown agent-core flag set id "${wanted}" (set via AGENT_CORE_FLAG_SET). ` +
        `Legal set ids: ${LEGAL_FLAG_SETS.map((s) => s.id).join(", ")}.`,
    );
  }
  return match;
}
