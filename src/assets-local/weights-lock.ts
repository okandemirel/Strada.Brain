/**
 * Per-install weights lock — trust-on-first-use pinning of the Hugging Face
 * commit each local model's weights were first downloaded at (CMP-13).
 *
 * The catalog cannot carry a commit for every model (none could be resolved
 * when it was written), so without this every install and every draw asked
 * the hub for "main": an upstream force-push or a compromised repo changed
 * the weights this machine loads, with nothing on disk to notice. Now the
 * first successful download records the commit the hub actually served in
 * `<install root>/models.lock.json`, and every later fetch, draw and
 * readiness check of that model uses exactly that commit. An explicit
 * catalog `weightsRevision` still wins over the lock.
 *
 * A pin is bound to the weights repo it was recorded for: a catalog entry
 * that moves to another repo starts a fresh pin instead of asking the new
 * repo for a commit of the old one.
 *
 * Weights downloaded before this lock existed are pinned offline, from the
 * snapshot already in the cache, the first time a process uses the install
 * (`origin: "disk"`, see adoptDownloadedWeights in local-model-runner.ts).
 */

import { existsSync, readFileSync } from "node:fs";
import { writeFileAtomicSync } from "../common/atomic-file.js";

export const WEIGHTS_LOCK_FILE = "models.lock.json";

/** What a hub snapshot folder is named after: a full commit sha. */
export const COMMIT_SHA_RE = /^[0-9a-f]{40}$/;

export interface WeightsPin {
  /** The HF repo the commit belongs to (the catalog's `weightsRef` at record time). */
  readonly weightsRef: string;
  /** The commit the hub served on the first successful download. */
  readonly revision: string;
  /** ISO time the pin was recorded (informational). */
  readonly recordedAt: string;
  /**
   * Where the commit came from: "download" = the hub served it to a fetch;
   * "disk" = adopted from a snapshot already cached before the lock existed.
   * Absent in files written before the field (all of them downloads).
   */
  readonly origin?: WeightsPinOrigin;
}

export type WeightsPinOrigin = "download" | "disk";

export type WeightsLockRead =
  | { readonly ok: true; readonly pins: Readonly<Record<string, WeightsPin>> }
  | { readonly ok: false; readonly detail: string };

interface WeightsLockFile {
  version: 1;
  models: Record<string, WeightsPin>;
}

function isPin(value: unknown): value is WeightsPin {
  if (typeof value !== "object" || value === null) return false;
  const pin = value as Record<string, unknown>;
  return typeof pin["weightsRef"] === "string"
    && pin["weightsRef"] !== ""
    && typeof pin["revision"] === "string"
    && COMMIT_SHA_RE.test(pin["revision"])
    && typeof pin["recordedAt"] === "string"
    && (pin["origin"] === undefined || pin["origin"] === "download" || pin["origin"] === "disk");
}

/**
 * The recorded pins. A missing file is "nothing pinned yet"; a file that
 * exists but cannot be read or does not hold valid pins is an ERROR, never
 * "nothing pinned" — reading it as empty would send the next fetch to "main"
 * and overwrite the very record that was supposed to prevent that.
 */
export function readWeightsLock(path: string): WeightsLockRead {
  if (!existsSync(path)) return { ok: true, pins: {} };
  const unreadable = (why: string): WeightsLockRead => ({
    ok: false,
    detail: `${path} is unreadable (${why}); fix it, or delete it to pin every model again on its next install`,
  });
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    return unreadable(err instanceof Error ? err.message : String(err));
  }
  if (typeof parsed !== "object" || parsed === null) return unreadable("not a JSON object");
  const file = parsed as Record<string, unknown>;
  if (file["version"] !== 1) return unreadable(`unknown version ${JSON.stringify(file["version"])}`);
  const models = file["models"];
  if (typeof models !== "object" || models === null || Array.isArray(models)) return unreadable("no models map");
  const pins: Record<string, WeightsPin> = {};
  for (const [id, pin] of Object.entries(models)) {
    if (!isPin(pin)) return unreadable(`the entry for "${id}" is not a weights pin`);
    pins[id] = {
      weightsRef: pin.weightsRef,
      revision: pin.revision,
      recordedAt: pin.recordedAt,
      ...(pin.origin !== undefined ? { origin: pin.origin } : {}),
    };
  }
  return { ok: true, pins };
}

/** The pin recorded for this model's CURRENT weights repo, if any. */
export function pinFor(
  pins: Readonly<Record<string, WeightsPin>>,
  modelId: string,
  weightsRef: string,
): WeightsPin | undefined {
  const pin = Object.prototype.hasOwnProperty.call(pins, modelId) ? pins[modelId] : undefined;
  return pin !== undefined && pin.weightsRef === weightsRef ? pin : undefined;
}

/**
 * Record (or replace) one model's pin, keeping every other entry. Written
 * atomically: a crash mid-write leaves the previous lock, never a torn one
 * that the next read would have to refuse.
 *
 * `keepExisting` records only when the model has no entry at all, checked
 * against the file as read for this write (not a caller's older copy), and
 * returns false without writing otherwise.
 */
export function recordWeightsPin(
  path: string,
  modelId: string,
  pin: WeightsPin,
  opts: { keepExisting?: boolean } = {},
): boolean {
  if (!COMMIT_SHA_RE.test(pin.revision)) throw new Error(`refusing to pin ${modelId} to "${pin.revision}": not a commit sha`);
  const current = readWeightsLock(path);
  if (!current.ok) throw new Error(current.detail);
  if (opts.keepExisting === true && Object.prototype.hasOwnProperty.call(current.pins, modelId)) return false;
  const file: WeightsLockFile = { version: 1, models: { ...current.pins, [modelId]: pin } };
  writeFileAtomicSync(path, `${JSON.stringify(file, null, 2)}\n`);
  return true;
}
