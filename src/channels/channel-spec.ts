// ---------------------------------------------------------------------------
// Channel spec — "web", or several channels at once: "web,telegram".
//
// Added 2026-09-09: the daemon hosted exactly one channel per process, so the
// two channels the user reaches for most (the web portal on the desk, Telegram
// on the phone) could never be live together, and a second daemon on the same
// project would fight over tasks.db and the workspace leases. A spec with more
// than one member boots a HubChannel that hosts all of them.
// ---------------------------------------------------------------------------
import { CHANNEL_DEFAULTS, type SupportedChannelType } from "../common/constants.js";

const SEPARATOR_RE = /[,+\s]+/;

/**
 * The member channel types of a spec, in order, deduplicated. Returns an empty
 * list when the spec is empty or names a type that does not exist — the caller
 * decides whether that is a boot error or a fallback.
 */
export function parseChannelSpec(spec: string | undefined | null): SupportedChannelType[] {
  if (typeof spec !== "string") return [];
  const seen = new Set<SupportedChannelType>();
  for (const raw of spec.split(SEPARATOR_RE)) {
    const part = raw.trim().toLowerCase();
    if (!part) continue;
    if (!(CHANNEL_DEFAULTS.SUPPORTED_TYPES as readonly string[]).includes(part)) return [];
    seen.add(part as SupportedChannelType);
  }
  return [...seen];
}

export function isValidChannelSpec(spec: string | undefined | null): boolean {
  return parseChannelSpec(spec).length > 0;
}

/** Canonical form: members joined with commas, e.g. "web,telegram". */
export function formatChannelSpec(members: readonly SupportedChannelType[]): string {
  return members.join(",");
}

export const CHANNEL_LABELS: Record<SupportedChannelType, string> = {
  web: "Web dashboard",
  cli: "Interactive CLI",
  telegram: "Telegram bot",
  discord: "Discord bot",
  slack: "Slack",
  teams: "Microsoft Teams",
};

/** Human label: "Web dashboard + Telegram bot". Unknown specs are echoed verbatim. */
export function describeChannelSpec(spec: string): string {
  const members = parseChannelSpec(spec);
  if (members.length === 0) return spec;
  return members.map((m) => CHANNEL_LABELS[m]).join(" + ");
}
