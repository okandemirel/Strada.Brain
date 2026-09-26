/**
 * The local operator credential (COR-13).
 *
 * `strada daemon trigger|reset|budget reset|…` run in a fresh CLI process; the
 * daemon lives in the runtime process. The dashboard API is the channel the two
 * share, but its mutating routes are gated for browsers (bearer token, trusted
 * Origin, the shared-instance owner) and a shell has none of those. So, while
 * the dashboard listens, the runtime writes a per-run random token to a file
 * under the config root — next to the runtime lock, mode 0600 — and accepts it,
 * in one custom header, on the few routes those commands use.
 *
 * Whoever can read that file is the OS user who can already read the config
 * root's `.env` and databases: the local operator. A browser page cannot read
 * it, and cannot send a custom header cross-origin without a CORS preflight the
 * dashboard never approves.
 */

import { randomBytes } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";
import { writeFileAtomic } from "../common/atomic-file.js";
import { installRootKey, installStateDir } from "./runtime-lock.js";
import { removeLockIfUnchanged } from "./setup-env-persistence.js";

/** The only place the dashboard reads the operator token from. Never a query string. */
export const OPERATOR_TOKEN_HEADER = "x-strada-operator-token";

export interface OperatorCredential {
  /** Where the dashboard that wrote this file listens. */
  baseUrl: string;
  /** The runtime process that wrote it, for messages. */
  pid: number;
  token: string;
}

const OperatorCredentialSchema = z.object({
  baseUrl: z.string().refine((value) => {
    try {
      const url = new URL(value);
      return url.protocol === "http:" || url.protocol === "https:";
    } catch {
      return false;
    }
  }),
  pid: z.number().int().positive(),
  token: z.string().min(32).max(256),
});

/** Where one install's credential lives: beside its runtime lock, keyed the same way. */
export function operatorCredentialPath(configRoot: string, installRoot: string): string {
  return join(installStateDir(configRoot), `${installRootKey(installRoot)}.operator.json`);
}

/** A fresh per-run token: 32 random bytes, base64url. */
export function generateOperatorToken(): string {
  return randomBytes(32).toString("base64url");
}

/**
 * Write the credential readable by this OS user only. Returns the exact bytes
 * written, which {@link withdrawOperatorCredential} needs to tell this run's
 * file from a later run's.
 */
export async function publishOperatorCredential(filePath: string, credential: OperatorCredential): Promise<string> {
  const bytes = `${JSON.stringify(credential)}\n`;
  await mkdir(dirname(filePath), { recursive: true, mode: 0o700 });
  await writeFileAtomic(filePath, bytes, { mode: 0o600 });
  return bytes;
}

/**
 * Remove the credential only while it still holds `writtenBytes` — this run's
 * token. A runtime that started after this one replaced the file, and its CLI
 * users must keep it.
 */
export async function withdrawOperatorCredential(filePath: string, writtenBytes: string): Promise<boolean> {
  return removeLockIfUnchanged(filePath, writtenBytes);
}

export type OperatorCredentialRead =
  | { kind: "ok"; credential: OperatorCredential }
  /** No file: nothing published one for this install and config root. */
  | { kind: "missing" }
  /** A file this process could not read (permissions, I/O). */
  | { kind: "unreadable"; code: string }
  /** A file that is not a credential. */
  | { kind: "invalid" };

export async function readOperatorCredential(filePath: string): Promise<OperatorCredentialRead> {
  let raw: string;
  try {
    raw = await readFile(filePath, "utf-8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? "EIO";
    return code === "ENOENT" ? { kind: "missing" } : { kind: "unreadable", code };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { kind: "invalid" };
  }
  const result = OperatorCredentialSchema.safeParse(parsed);
  return result.success ? { kind: "ok", credential: result.data } : { kind: "invalid" };
}
