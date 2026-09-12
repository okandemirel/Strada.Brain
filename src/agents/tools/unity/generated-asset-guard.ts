/**
 * What every generator owes the asset it is about to (re)write.
 *
 * Review 2026-09-07 of the art generators: a failed regeneration deleted the
 * bound asset's .meta (Unity then re-imports under a random guid and every
 * prefab reference breaks), an AUTO fallback overwrote real art with a
 * placeholder, a killed draw left a truncated PNG beside a fresh meta, and a
 * `path` of "Assets/../ProjectSettings" wrote outside Assets/ while the tool
 * reported "Sprite written". These helpers close all four.
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { classifyPngBytes, isPlaceholderGradePng, measurePngContent } from "../../autonomy/built-as-specified.js";
import { getLoggerSafe } from "../../../utils/logger.js";

/** The real path of `p`'s nearest existing ancestor plus the rest — symlinked temp roots (/var → /private/var) compare equal. */
function canonical(p: string): string {
  let existing = resolve(p);
  let rest = "";
  while (!existsSync(existing)) {
    const parent = dirname(existing);
    if (parent === existing) break;
    rest = join(existing.slice(parent.length), rest);
    existing = parent;
  }
  let real = existing;
  try { real = realpathSync.native(existing); } catch { /* keep lexical */ }
  return rest === "" ? real : join(real, rest);
}

/** An error when `fullPath` is not inside `<projectPath>/Assets/` (after `..` resolution), else undefined. */
export function outsideAssetsError(projectPath: string, fullPath: string, requested: string): string | undefined {
  const assets = canonical(join(projectPath, "Assets"));
  const rel = relative(assets, canonical(fullPath));
  if (rel === "" || rel.startsWith("..") || rel.startsWith(sep) || /^[A-Za-z]:/.test(rel)) {
    return `Error: path "${requested}" resolves outside Assets/ (${rel || "the Assets folder itself"}) — Unity would never import it.`;
  }
  return undefined;
}

/**
 * The previous asset + .meta at a target, kept until the new draw is known
 * good. `restore()` puts them back (or removes what a failed call minted);
 * `commit()` forgets them.
 */
/**
 * Which generation last COMMITTED art at a path, as a monotonic tick.
 *
 * Two generations against one path each snapshot the same original; the first
 * commits its new art, the second fails and restores ITS snapshot — over the
 * first one's committed image, which then existed nowhere (Codex 2026-09-11
 * O#17). A restore that would undo someone else's committed work does nothing
 * instead.
 */
interface CommittedArt {
  tick: number;
  digest: string | undefined;
  /** The committed .meta's digest, so a damaged .meta is seen as damage. */
  metaDigest?: string | undefined;
  /**
   * Whether a .meta was there when this was committed — recorded SEPARATELY
   * from its digest. An unreadable digest read as "there was none", so a
   * damaged .meta written afterwards counted as intact (Codex 2026-09-12 T#5).
   */
  metaPresent?: boolean;
  /** Copies a failed retention left behind, kept only so they can be removed. */
  orphanCopies?: string[];
  /** A copy of the committed pair, kept while another generation is still open. */
  assetCopy?: string;
  metaCopy?: string;
  hadMeta?: boolean;
}
const committedAt = new Map<string, CommittedArt>();
/** How many generations against a path have not settled yet. */
const openGenerations = new Map<string, number>();
let generationTick = 0;

function digestOf(path: string): string | undefined {
  try {
    return createHash("sha256").update(readFileSync(path)).digest("hex");
  } catch {
    return undefined;
  }
}

export class PreviousAsset {
  private readonly hadAsset: boolean;
  private readonly hadMeta: boolean;
  private readonly assetBackup: string;
  private readonly metaBackup: string;
  private done = false;
  /** Where this instance sits in the order of generations at this path. */
  private readonly startedAt: number;

  constructor(readonly fullPath: string) {
    // A backup name OF ITS OWN. Two generations targeting the same path used
    // the same two filenames: the first to finish deleted them, and the
    // second's restore threw ENOENT with its damaged output left in place and
    // the original surviving nowhere (Codex 2026-09-11 N#9).
    this.startedAt = ++generationTick;
    openGenerations.set(fullPath, (openGenerations.get(fullPath) ?? 0) + 1);
    const token = randomUUID().slice(0, 8);
    this.assetBackup = `${fullPath}.strada-prev-${token}`;
    this.metaBackup = `${fullPath}.meta.strada-prev-${token}`;
    this.hadAsset = existsSync(fullPath);
    this.hadMeta = existsSync(`${fullPath}.meta`);
    mkdirSync(dirname(fullPath), { recursive: true });
    if (this.hadAsset) copyFileSync(fullPath, this.assetBackup);
    if (this.hadMeta) copyFileSync(`${fullPath}.meta`, this.metaBackup);
    this.existingIsRealArt = this.gradeOfExisting() === "art";
  }

  /**
   * Whether real (non-placeholder) art already sat at the target.
   *
   * Measured at CONSTRUCTION, while the file is still there: callers ask
   * after `restore()`, which forgets the backups, and a lazy read then found
   * nothing. And the BYTES are classified, not the backup's filename — the
   * backup ends in `.strada-prev`, the classifier required a `.png` name, and
   * so every placeholder under a backup name came back "real art" (Codex
   * 2026-09-11 N#5).
   */
  readonly existingIsRealArt: boolean;

  private gradeOfExisting(): "placeholder" | "art" | "invalid" {
    if (!this.hadAsset || !/\.png$/i.test(this.fullPath)) return "invalid";
    try {
      return classifyPngBytes(readFileSync(this.assetBackup));
    } catch {
      return "invalid";
    }
  }

  /**
   * Is the file at the target byte-for-byte what was already there?
   *
   * A runner that exits 0 without writing leaves the previous image in place,
   * and the tool then reported "Sprite written" over art it had not drawn
   * (Codex 2026-09-11 N#11). False when there was nothing there before.
   */
  unchangedSinceBackup(): boolean {
    if (!this.hadAsset) return false;
    try {
      return readFileSync(this.fullPath).equals(readFileSync(this.assetBackup));
    } catch {
      return false;
    }
  }

  /** Put the previous pair back; remove a newly minted pair when there was none. */
  restore(): void {
    if (this.done) return;
    // SOMEONE ELSE'S COMMITTED ART IS NOT OURS TO UNDO. While their bytes are
    // still on disk, leaving them is enough. When our own damaged draw has
    // already overwritten them, our snapshot is NOT the better of the two —
    // it predates their work, and restoring it erased art that had been
    // committed (Codex 2026-09-12 P#19). Their retained copy is what goes
    // back; only with no copy left is our snapshot the best available.
    const newer = committedAt.get(this.fullPath);
    if (newer !== undefined && newer.tick > this.startedAt) {
      // THE PAIR, not the image alone: a draw that damaged only the .meta left
      // the asset's digest matching, and the damaged importer stayed (Codex
      // 2026-09-12 Q#6).
      const assetIntact = newer.digest !== undefined && digestOf(this.fullPath) === newer.digest;
      // ABSENCE IS A STATE, NOT A MISSING ANSWER. With no .meta at commit
      // time, the intact state is that there is still none (T#5).
      const metaIntact = newer.metaPresent === true
        ? newer.metaDigest !== undefined && digestOf(`${this.fullPath}.meta`) === newer.metaDigest
        : !existsSync(`${this.fullPath}.meta`);
      if (assetIntact && metaIntact) {
        this.settle();
        return;
      }
      if (newer.assetCopy !== undefined && existsSync(newer.assetCopy)) {
        if (!assetIntact) copyFileSync(newer.assetCopy, this.fullPath);
        if (newer.hadMeta === true && newer.metaCopy !== undefined && existsSync(newer.metaCopy)) {
          copyFileSync(newer.metaCopy, `${this.fullPath}.meta`);
        } else if (newer.hadMeta !== true) {
          // ABSENCE IS PART OF THE PAIR. The committed state had no .meta, and
          // a damaged one written afterwards was left in place because only
          // presence was ever restored (Codex 2026-09-12 S#9).
          rmSync(`${this.fullPath}.meta`, { force: true });
        }
        this.settle();
        return;
      }
      // No retained copy: our snapshot predates their commit, so writing it
      // would erase committed art. Only when our own backup IS their bytes is
      // putting it back the same thing as restoring theirs.
      if (digestOf(this.assetBackup) !== newer.digest) {
        getLoggerSafe().warn("A generation failed over art another generation had committed, and no copy of it survives", {
          path: this.fullPath,
        });
        this.settle();
        return;
      }
    }
    try {
      if (this.hadAsset) copyFileSync(this.assetBackup, this.fullPath);
      else rmSync(this.fullPath, { force: true });
      if (this.hadMeta) copyFileSync(this.metaBackup, `${this.fullPath}.meta`);
      else rmSync(`${this.fullPath}.meta`, { force: true });
      // ONLY NOW. `done` used to be set before the copies, so a restore that
      // failed could not be repeated after the filesystem was fixed (O#17).
      this.done = true;
    } catch (err) {
      // A RESTORE THAT FAILED KEEPS ITS BACKUPS. Deleting them in a finally
      // block threw away the only surviving copy of the previous art exactly
      // when putting it back had not worked (Codex 2026-09-11 N#9).
      throw err;
    }
    this.settle();
  }

  /** The new pair is good; the backups go. */
  commit(): void {
    if (this.done) return;
    this.done = true;
    const record: CommittedArt = {
      tick: ++generationTick,
      digest: digestOf(this.fullPath),
      metaDigest: digestOf(`${this.fullPath}.meta`),
      metaPresent: existsSync(`${this.fullPath}.meta`),
    };
    const superseded = committedAt.get(this.fullPath);
    // While another generation is still open against this path, the committed
    // pair itself is kept: that generation may fail and need to put back what
    // WE committed rather than what either of us snapshotted.
    if ((openGenerations.get(this.fullPath) ?? 0) > 1) {
      const token = randomUUID().slice(0, 8);
      const assetCopy = `${this.fullPath}.strada-committed-${token}`;
      const metaCopy = `${this.fullPath}.meta.strada-committed-${token}`;
      // THE PAIR OR NOTHING. Retaining the asset and failing on its .meta left
      // a half-copy that a later rollback restored, damaged metadata and all
      // (Codex 2026-09-12 S#9).
      try {
        copyFileSync(this.fullPath, assetCopy);
        if (existsSync(`${this.fullPath}.meta`)) {
          copyFileSync(`${this.fullPath}.meta`, metaCopy);
          record.metaCopy = metaCopy;
          record.hadMeta = true;
        }
        record.assetCopy = assetCopy;
      } catch {
        // Unreadable target: keep nothing rather than half a pair. The digest
        // guard still protects intact bytes.
        record.assetCopy = undefined;
        record.metaCopy = undefined;
        record.hadMeta = undefined;
        for (const partial of [assetCopy, metaCopy]) {
          try { rmSync(partial, { force: true }); } catch { /* best effort */ }
        }
        // The PREVIOUS commit's copies are now referenced by nothing — this
        // record replaces it and carries no copies of its own. They are not a
        // restore source (they predate what is on disk), but they must still
        // be removed when the path settles (Codex 2026-09-12 T#6).
        record.orphanCopies = [superseded?.assetCopy, superseded?.metaCopy, ...(superseded?.orphanCopies ?? [])]
          .filter((x): x is string => x !== undefined);
      }
    }
    committedAt.set(this.fullPath, record);
    // ONLY NOW are the previous commit's copies superseded: deleting them
    // before this pair was secured left nothing to roll back to (S#9).
    if (record.assetCopy !== undefined || (openGenerations.get(this.fullPath) ?? 0) <= 1) {
      for (const copy of [superseded?.assetCopy, superseded?.metaCopy]) {
        if (copy !== undefined) { try { rmSync(copy, { force: true }); } catch { /* best effort */ } }
      }
    }
    this.settle();
  }

  /** This generation is over: drop its backups, and the retained art if it was the last. */
  private settle(): void {
    this.done = true;
    this.forget();
    const open = (openGenerations.get(this.fullPath) ?? 1) - 1;
    if (open > 0) {
      openGenerations.set(this.fullPath, open);
      return;
    }
    openGenerations.delete(this.fullPath);
    const record = committedAt.get(this.fullPath);
    if (record === undefined) return;
    for (const copy of [record.assetCopy, record.metaCopy, ...(record.orphanCopies ?? [])]) {
      if (copy !== undefined) { try { rmSync(copy, { force: true }); } catch { /* best effort */ } }
    }
    committedAt.set(this.fullPath, {
      tick: record.tick,
      digest: record.digest,
      metaDigest: record.metaDigest,
      metaPresent: record.metaPresent,
    });
  }

  private forget(): void {
    try { rmSync(this.assetBackup, { force: true }); } catch { /* best effort */ }
    try { rmSync(this.metaBackup, { force: true }); } catch { /* best effort */ }
  }
}

/** Opaque pixels this share or below is a field of specks, not a sprite. */
export const MIN_OPAQUE_SHARE = 0.05;

/**
 * Why a freshly drawn sprite file is not usable, or undefined when it is: a
 * flat shape by the delivery gate's own rule, a cut-out that is nearly all
 * transparent (the 2026-09-07 15:02 alpha-speck case, which the pixel
 * classifier alone accepts because specks have many colours), or a file the
 * PNG reader cannot decode (a draw killed mid-save).
 */
export function unusableSpriteReason(fullPath: string): string | undefined {
  let bytes: Buffer;
  try {
    bytes = readFileSync(fullPath);
  } catch {
    return "the file could not be read";
  }
  const content = measurePngContent(bytes);
  if (content === null) return "the file is not a decodable PNG (a draw interrupted mid-save, or an exotic encoding)";
  if (content.opaqueShare < MIN_OPAQUE_SHARE) {
    return `only ${(content.opaqueShare * 100).toFixed(1)}% of the pixels are opaque — the cut-out removed the subject`;
  }
  if (isPlaceholderGradePng(fullPath)) {
    return `the pixels are a flat shape (${content.colours} colours, edges only on outlines) — a blank or filtered draw`;
  }
  return undefined;
}

export { join };
