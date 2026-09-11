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
import { randomUUID } from "node:crypto";
import { classifyPngBytes, isPlaceholderGradePng, measurePngContent } from "../../autonomy/built-as-specified.js";

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
export class PreviousAsset {
  private readonly hadAsset: boolean;
  private readonly hadMeta: boolean;
  private readonly assetBackup: string;
  private readonly metaBackup: string;
  private done = false;

  constructor(readonly fullPath: string) {
    // A backup name OF ITS OWN. Two generations targeting the same path used
    // the same two filenames: the first to finish deleted them, and the
    // second's restore threw ENOENT with its damaged output left in place and
    // the original surviving nowhere (Codex 2026-09-11 N#9).
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
    this.done = true;
    try {
      if (this.hadAsset) copyFileSync(this.assetBackup, this.fullPath);
      else rmSync(this.fullPath, { force: true });
      if (this.hadMeta) copyFileSync(this.metaBackup, `${this.fullPath}.meta`);
      else rmSync(`${this.fullPath}.meta`, { force: true });
    } catch (err) {
      // A RESTORE THAT FAILED KEEPS ITS BACKUPS. Deleting them in a finally
      // block threw away the only surviving copy of the previous art exactly
      // when putting it back had not worked (Codex 2026-09-11 N#9).
      throw err;
    }
    this.forget();
  }

  /** The new pair is good; the backups go. */
  commit(): void {
    if (this.done) return;
    this.done = true;
    this.forget();
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

/** Files under `Recordings`-style scratch never; this is for the .strada-prev backups a crash may leave behind. */
export function isBackupArtifact(path: string): boolean {
  return /\.strada-prev$/.test(path);
}

export { join };
