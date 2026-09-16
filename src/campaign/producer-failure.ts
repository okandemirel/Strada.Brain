/**
 * A PRODUCER FAILURE THAT STILL CARRIES ITS EVIDENCE.
 *
 * When a play-through is killed at its deadline the producer measures exactly
 * that — `completed: false, timedOut: true` — and returns it beside the
 * failure. The adapter threw the failure and dropped the receipt, so the
 * ledger recorded EVIDENCE_MISSING ("no receipt came back") for a run that had
 * explained itself precisely (Codex 2026-09-13 AI#11).
 *
 * The failure still propagates: nothing here makes a failed run look like a
 * good one. Only the evidence is kept.
 */
export class ProducerFailure extends Error {
  /** The producer's receipt, verbatim, when it sent one with its failure. */
  readonly receipt?: string;

  constructor(message: string, receipt?: string) {
    super(message);
    this.name = "ProducerFailure";
    if (receipt !== undefined) this.receipt = receipt;
  }
}

/**
 * The receipt a failure carried, or nothing — never a receipt invented here.
 *
 * Read off the FIELD, not the class: two copies of this module (the vendored
 * producer, another realm) make `instanceof` false while the receipt is still
 * there, and an `instanceof` branch beside this one proved nothing the field
 * check did not already prove.
 */
export function receiptOfFailure(err: unknown): string | undefined {
  if (err !== null && typeof err === "object" && "receipt" in err) {
    const raw = (err as { receipt?: unknown }).receipt;
    return typeof raw === "string" && raw.trim() !== "" ? raw : undefined;
  }
  return undefined;
}
