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
import { basename, dirname, isAbsolute, join, relative } from "node:path";
import { mkdirSync, readFileSync, readdirSync, statSync, realpathSync } from "node:fs";
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

/**
 * The digest SCHEME, mixed into every artifact digest.
 *
 * A digest that hashed paths and sizes is not a content digest, and one that
 * covered only the named executable is not a digest of the game beside it —
 * a record written under an older scheme must never look like one written
 * under this one (Codex 2026-09-13 AH#8, AI#9). Strada.MCP uses the same
 * string.
 */
export const ARTIFACT_DIGEST_VERSION = "strada-artifact-v3-layout";

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
        // A dispatch that accepts more than one producer stores what it asked
        // for, in order (Codex 2026-09-13 AI, the compile row).
        Array.isArray(b.medium) ? b.medium.join(",") : b.medium,
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
 * each path, its size and its BYTES, in a fixed order.
 *
 * …AND THE GAME BESIDE THE EXECUTABLE. A Windows or Linux player is an
 * executable plus its `<Name>_Data` folder, its runtime library and its
 * plugins; hashing only the named file left every asset, scene and managed
 * assembly out of the artifact's identity — the whole game could be replaced
 * while the digest stood (Codex 2026-09-13 AI#9). When the named file sits in
 * a Unity player layout, the digest covers that layout.
 */
export function artifactDigest(path: string | undefined): string | undefined {
  if (path === undefined || path === "") return undefined;
  try {
    const hash = createHash("sha256");
    // THE BYTES, not the names and sizes. Hashing paths and sizes made two
    // different files of the same size identical — measured on two real
    // 26 648-byte files, whose digests matched exactly (Codex 2026-09-13
    // AH#8). A player artifact is what a person would run; a same-size
    // replacement is a different game.
    hash.update(`${ARTIFACT_DIGEST_VERSION}\n`);
    // WHICH artifact in that layout, so two executables shipped side by side
    // are not one artifact.
    hash.update(`${basename(path)}\n`);
    // THE FILES THE BUILD SAID IT SHIPPED, when it said: the layout walk picks
    // up whatever is written beside the executable afterwards (AJ#4).
    const manifest = artifactManifest(path);
    if (manifest !== undefined) {
      // The listed files, each by name, size and bytes: dropping one from the
      // list drops its line, so the manifest's own formatting is not part of
      // the artifact's identity (a reformatted manifest is the same game).
      const base = dirname(path);
      for (const rel of [...manifest.files].sort()) {
        const at = join(base, rel);
        const st = statSync(at);
        hash.update(`${rel}:${st.size}\n`);
        hash.update(readFileSync(at));
      }
      return hash.digest("hex");
    }
    const walk = (at: string, rel: string): void => {
      const st = statSync(at);
      if (st.isDirectory()) {
        for (const entry of readdirSync(at).sort()) walk(join(at, entry), `${rel}/${entry}`);
        return;
      }
      hash.update(`${rel}:${st.size}\n`);
      hash.update(readFileSync(at));
    };
    walk(playerLayoutRoot(path), "");
    return hash.digest("hex");
  } catch {
    // An artifact that is not there has no digest, and saying so is the point.
    return undefined;
  }
}

/**
 * THE FILES A BUILD SAID IT SHIPPED.
 *
 * Hashing the whole player layout pulls in whatever is written beside the
 * executable AFTERWARDS — a log the game writes on its first run, another
 * build copied into the same folder — so an artifact nobody touched hashed
 * differently before and after it ran (Codex 2026-09-13 AJ#4). A build that
 * states its own manifest is measured on exactly those files; one that states
 * none is measured on its layout, as before.
 *
 * The manifest sits BESIDE the artifact, never inside it: a stray file inside
 * a macOS .app changes the bundle.
 */
export const ARTIFACT_MANIFEST_SUFFIX = ".strada-artifact.json";
export const ARTIFACT_MANIFEST_VERSION = "strada-manifest-v1";

/**
 * The manifest a build wrote for this artifact, or nothing.
 *
 * A MANIFEST THAT LEAVES THE GAME OUT IS NOT A MANIFEST. `files:
 * ["readme.txt"]` beside Game.exe was accepted and the digest then covered
 * readme.txt and the executable's NAME: the executable could be replaced
 * while the digest stood, and every receipt and accumulated coverage keyed
 * on it followed (Codex 2026-09-16 D78, introduced by af44a358). A manifest
 * is adopted only when it lists the whole game as this process recognises
 * the layout — the executable with every <Name>_Data folder and runtime
 * library beside it, or a bundle in full — and every entry resolves INSIDE
 * the folder the manifest sits in (no symlink out). Anything else falls back
 * to the layout walk, which covers everything; a declared file the tree does
 * not have leaves the artifact with no digest at all.
 */
export function artifactManifest(path: string): { readonly bytes: string; readonly files: readonly string[] } | undefined {
  try {
    const bytes = readFileSync(`${path}${ARTIFACT_MANIFEST_SUFFIX}`, "utf8");
    const parsed: unknown = JSON.parse(bytes);
    if (parsed === null || typeof parsed !== "object") return undefined;
    const doc = parsed as { version?: unknown; files?: unknown };
    if (doc.version !== ARTIFACT_MANIFEST_VERSION) return undefined;
    if (!Array.isArray(doc.files) || doc.files.length === 0) return undefined;
    const files: string[] = [];
    for (const entry of doc.files) {
      // A path that leaves the layout is not a file this build shipped.
      if (typeof entry !== "string" || entry === "" || entry.includes("..") || entry.startsWith("/") || /^[A-Za-z]:[\\/]/.test(entry)) return undefined;
      files.push(entry.replace(/\\/g, "/").replace(/^\.\//, ""));
    }
    if (!manifestCoversTheGame(path, files)) return undefined;
    return { bytes, files };
  } catch {
    return undefined;
  }
}

/**
 * Does the manifest list EVERY file of the game, as this process recognises
 * its layout, and nothing outside the folder it sits in?
 *
 * Naming the executable and "something under Game_Data" was not enough: a
 * manifest listing Game.exe and one level left level1, UnityPlayer.dll and
 * MonoBleedingEdge out of the identity, a .app's readme could stand in for
 * its binary, and a WebGL folder needed nothing but index.html (Codex
 * 2026-09-17 D78 review #1-#3). The rule is a superset check against the
 * runtime set the layout implies; what the build did not ship (a log
 * written beside the player) may be left out, what it shipped may not.
 */
function manifestCoversTheGame(path: string, files: readonly string[]): boolean {
  const base = dirname(path);
  const name = basename(path);
  let isDirectory: boolean;
  try {
    isDirectory = statSync(path).isDirectory();
  } catch {
    return false;
  }
  // Every entry resolves inside the folder the manifest sits in: a symlink to
  // another build is out. A declared file that is NOT THERE adopts the
  // manifest as it stands: the digest fails on it, and "no digest" is the
  // answer for a build that says it shipped a file the tree does not have
  // (review #5) — never a walk that hashes what is left.
  const layoutRoot = realpathSync(base);
  for (const rel of files) {
    let real: string;
    try {
      real = realpathSync(join(base, rel));
    } catch {
      return true;
    }
    const inside = relative(layoutRoot, real);
    if (inside === "" || inside.startsWith("..") || isAbsolute(inside)) return false;
  }
  const listed = new Set(files);
  return requiredRuntimeFiles(path, base, name, isDirectory).every((required) => listed.has(required));
}

/**
 * The files a manifest has to list: a bundle (a .app, a WebGL folder) in
 * full; a player executable with every <Name>_Data folder, runtime library
 * (UnityPlayer, GameAssembly, MonoBleedingEdge) and WebGL Build/TemplateData
 * folder beside it. Relative to the folder the manifest sits in, "/"-joined.
 */
function requiredRuntimeFiles(path: string, base: string, name: string, isDirectory: boolean): string[] {
  const required: string[] = [];
  const walk = (at: string, rel: string): void => {
    for (const entry of readdirSync(at).sort()) {
      const child = join(at, entry);
      if (statSync(child).isDirectory()) walk(child, `${rel}/${entry}`);
      else required.push(`${rel}/${entry}`);
    }
  };
  if (isDirectory) {
    walk(path, name);
    return required;
  }
  required.push(name);
  for (const entry of readdirSync(base).sort()) {
    let directory: boolean;
    try {
      directory = statSync(join(base, entry)).isDirectory();
    } catch {
      continue;
    }
    if (directory) {
      if (entry.endsWith("_Data") || RUNTIME_DIRS.has(entry)) walk(join(base, entry), entry);
    } else if (RUNTIME_FILE_RE.test(entry)) {
      required.push(entry);
    }
  }
  return required;
}

const RUNTIME_DIRS = new Set(["MonoBleedingEdge", "Build", "TemplateData"]);
const RUNTIME_FILE_RE = /\.(?:dll|so|dylib)$|^GameAssembly\./i;

/**
 * The directory a Unity player's parts live in, or the path itself.
 *
 * Only a layout this machine can RECOGNISE is adopted: the named file's own
 * directory must hold a `*_Data` folder, which is what Unity writes beside a
 * Windows or Linux player. Hashing any parent directory would pull unrelated
 * builds and mutable output into the artifact's identity (AI#9).
 */
export function playerLayoutRoot(path: string): string {
  try {
    if (statSync(path).isDirectory()) return path;
    const dir = dirname(path);
    const entries = readdirSync(dir);
    const hasData = entries.some((entry) => entry.endsWith("_Data") && statSync(join(dir, entry)).isDirectory());
    // A WebGL player is index.html beside its Build folder (Codex 2026-09-17 D78 review #3).
    const webgl = basename(path).toLowerCase() === "index.html" && entries.includes("Build") && statSync(join(dir, "Build")).isDirectory();
    return hasData || webgl ? dir : path;
  } catch {
    return path;
  }
}
