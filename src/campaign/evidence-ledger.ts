/**
 * The tickets a campaign issued and the receipts it got back.
 *
 * The receiver in `producer-evidence.ts` answers "does this record answer the
 * ticket that was issued?" — but until something ISSUES tickets and keeps
 * them, its protections constrain nothing: every delivery proof is still a
 * file a worker could have written (Codex 2026-09-12 AC Job 2, 2026-09-13
 * AF#1, which found no production caller at all).
 *
 * This is the durable half. A ticket is written BEFORE the producer is
 * dispatched, so a run that never comes back is visibly incomplete; the
 * receipt is written after, with the decision the receiver made. Nothing here
 * gates a delivery yet — the producers emit no envelopes, and a gate for
 * evidence nothing can produce refuses every delivery (see
 * [[tightening-a-gate-cuts-both-ways]]). It DISCLOSES.
 */

import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { mkdirSync, readdirSync, statSync } from "node:fs";
import type { EvidenceDecision, EvidenceTicket } from "./producer-evidence.js";
import { recordSha256 } from "./producer-evidence.js";

export interface LedgerRow {
  readonly runId: string;
  readonly campaignId: string;
  readonly generation: number;
  readonly milestoneId: string;
  readonly attemptId: string;
  readonly kind: string;
  readonly medium: string;
  readonly target?: string;
  readonly issuedAt: number;
  /** "pending" until a receipt arrives, then "admitted" or "refused". */
  readonly state: "pending" | "admitted" | "refused";
  readonly receivedAt?: number;
  readonly refusal?: string;
  readonly detail?: string;
  readonly recordSha256?: string;
}

/** A receipt larger than this is not stored whole — its hash and size are. */
export const MAX_STORED_RECEIPT_BYTES = 256 * 1024;

export class EvidenceLedger {
  private readonly db: Database.Database;

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS campaign_evidence_runs (
        run_id TEXT PRIMARY KEY,
        campaign_id TEXT NOT NULL,
        generation INTEGER NOT NULL,
        milestone_id TEXT NOT NULL,
        attempt_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        medium TEXT NOT NULL,
        target TEXT,
        revision TEXT NOT NULL,
        dirty INTEGER NOT NULL,
        artifact_sha256 TEXT,
        requested_sessions TEXT,
        issued_at INTEGER NOT NULL,
        state TEXT NOT NULL,
        received_at INTEGER,
        receipt_bytes TEXT,
        receipt_sha256 TEXT,
        receipt_size INTEGER,
        refusal TEXT,
        detail TEXT
      )
    `);
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_evidence_milestone ON campaign_evidence_runs (campaign_id, milestone_id)");
  }

  /** Written BEFORE the producer runs: a dispatch nobody settled is visible. */
  issue(ticket: EvidenceTicket): void {
    const b = ticket.binding;
    this.db
      .prepare(
        `INSERT OR REPLACE INTO campaign_evidence_runs (
          run_id, campaign_id, generation, milestone_id, attempt_id, kind, medium, target,
          revision, dirty, artifact_sha256, requested_sessions, issued_at, state
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')`,
      )
      .run(
        b.runId,
        b.campaignId,
        b.generation,
        b.milestoneId,
        b.attemptId,
        b.kind,
        b.medium,
        b.target ?? null,
        b.revision,
        b.dirty ? 1 : 0,
        b.artifactSha256 ?? null,
        ticket.requestedSessions === undefined ? null : JSON.stringify(ticket.requestedSessions),
        ticket.issuedAt,
      );
  }

  /**
   * The decision on the bytes that came back.
   *
   * IDEMPOTENT on identical bytes, and a CONFLICT on different ones: a second
   * producer answering the same run id must not overwrite the first answer
   * (Codex 2026-09-12 AC Job 2).
   */
  settle(runId: string, bytes: string | undefined, decision: EvidenceDecision): "recorded" | "unchanged" | "conflict" | "unknown-run" {
    const row = this.db.prepare("SELECT state, receipt_sha256 FROM campaign_evidence_runs WHERE run_id = ?").get(runId) as
      | { state: string; receipt_sha256: string | null }
      | undefined;
    if (row === undefined) return "unknown-run";
    const sha = bytes === undefined ? null : recordSha256(bytes);
    if (row.state !== "pending") {
      if (row.receipt_sha256 === sha) return "unchanged";
      return "conflict";
    }
    this.db
      .prepare(
        `UPDATE campaign_evidence_runs
            SET state = ?, received_at = ?, receipt_bytes = ?, receipt_sha256 = ?, receipt_size = ?, refusal = ?, detail = ?
          WHERE run_id = ?`,
      )
      .run(
        decision.admitted ? "admitted" : "refused",
        Date.now(),
        bytes !== undefined && bytes.length <= MAX_STORED_RECEIPT_BYTES ? bytes : null,
        sha,
        bytes?.length ?? null,
        decision.admitted ? null : decision.refusal,
        decision.admitted ? null : decision.detail.slice(0, 500),
        runId,
      );
    return "recorded";
  }

  /** Every run this milestone dispatched, oldest first. */
  forMilestone(campaignId: string, milestoneId: string): LedgerRow[] {
    const rows = this.db
      .prepare(
        `SELECT run_id, campaign_id, generation, milestone_id, attempt_id, kind, medium, target,
                issued_at, state, received_at, refusal, detail, receipt_sha256
           FROM campaign_evidence_runs
          WHERE campaign_id = ? AND milestone_id = ?
          ORDER BY issued_at ASC`,
      )
      .all(campaignId, milestoneId) as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      runId: String(r["run_id"]),
      campaignId: String(r["campaign_id"]),
      generation: Number(r["generation"]),
      milestoneId: String(r["milestone_id"]),
      attemptId: String(r["attempt_id"]),
      kind: String(r["kind"]),
      medium: String(r["medium"]),
      ...(r["target"] === null || r["target"] === undefined ? {} : { target: String(r["target"]) }),
      issuedAt: Number(r["issued_at"]),
      state: String(r["state"]) as LedgerRow["state"],
      ...(r["received_at"] === null || r["received_at"] === undefined ? {} : { receivedAt: Number(r["received_at"]) }),
      ...(r["refusal"] === null || r["refusal"] === undefined ? {} : { refusal: String(r["refusal"]) }),
      ...(r["detail"] === null || r["detail"] === undefined ? {} : { detail: String(r["detail"]) }),
      ...(r["receipt_sha256"] === null || r["receipt_sha256"] === undefined ? {} : { recordSha256: String(r["receipt_sha256"]) }),
    }));
  }

  close(): void {
    this.db.close();
  }
}

/**
 * What the delivery report says about one dispatched run.
 *
 * Informational in this version: the producers emit no envelopes, so every
 * line reads MISSING — and that is the honest state of the evidence, not a
 * reason to refuse a delivery the older checks passed.
 */
export function describeLedgerRow(row: LedgerRow): string {
  const what = `${row.kind} receipt${row.target ? ` [${row.target}]` : ""}`;
  if (row.state === "pending") {
    return `${what}: NOT SETTLED — the run was dispatched (${row.runId.slice(0, 8)}) and no receipt came back; its provenance is unverified.`;
  }
  if (row.state === "refused") {
    return `${what}: REFUSED (${row.refusal ?? "unknown"}): ${row.detail ?? ""}`.trim();
  }
  return `${what}: admitted (run ${row.runId.slice(0, 8)}, record ${(row.recordSha256 ?? "").slice(0, 12)}).`;
}

/**
 * What a player artifact IS, as this machine reads it.
 *
 * A ticket binds a play-through to the bytes that were built: without it the
 * receiver cannot tell a run of this build from a run of the last one (Codex
 * 2026-09-12 AB). A macOS .app is a DIRECTORY, so the digest covers the tree —
 * names, sizes and the bytes of each file, in a fixed order.
 */
export function artifactDigest(path: string | undefined): string | undefined {
  if (path === undefined || path === "") return undefined;
  try {
    const hash = createHash("sha256");
    const walk = (at: string, rel: string): void => {
      const st = statSync(at);
      if (st.isDirectory()) {
        for (const entry of readdirSync(at).sort()) walk(join(at, entry), `${rel}/${entry}`);
        return;
      }
      hash.update(`${rel}:${st.size}\n`);
    };
    walk(path, "");
    return hash.digest("hex");
  } catch {
    // An artifact that is not there has no digest, and saying so is the point.
    return undefined;
  }
}
