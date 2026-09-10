/**
 * `strada status` operator read-out (2026-09-10).
 *
 * The command used to print ports and PIDs only; the questions an operator
 * actually asks — is the daemon healthy, which providers are benched and
 * until when, what is the campaign doing, did the last auto-update land —
 * needed the log, provider-health.json, the campaigns database and git
 * reflog. This module reads those sources and says what it found, and says
 * "not readable" for a source it could not read rather than skipping it.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { CampaignStorage } from "../campaign/campaign-storage.js";
import { describeAgo, describeSpan, describeWhen, describeUpdateEvent, readUpdateHistory, type UpdateEvent } from "./update-history.js";

export interface ProviderBench {
  name: string;
  status: string;
  consecutiveFailures: number;
  cooldownUntil: number;
  lastError: string;
}

export interface CampaignSnapshot {
  id: string;
  state: string;
  projectRoot: string;
  milestoneIndex: number;
  milestoneCount: number;
  milestoneTitle?: string;
  milestoneStatus?: string;
  updatedAt: number;
  lastError?: string;
  autoReviveAt?: number;
}

export interface StatusReport {
  now: number;
  health: { reachable: boolean; status?: string; uptimeSeconds?: number; detail?: string };
  providers: { readable: boolean; path: string; benched: ProviderBench[]; total: number };
  campaigns: { readable: boolean; path: string; active: CampaignSnapshot[]; awaitingRevive: CampaignSnapshot[]; lastTerminal?: CampaignSnapshot };
  update: { path: string; last?: UpdateEvent };
}

export interface GatherOptions {
  memoryDbPath: string;
  installRoot: string;
  healthUrl?: string;
  now?: number;
  fetchImpl?: typeof fetch;
  /** Injected for tests; defaults to opening the campaigns database. */
  loadCampaigns?: (dbPath: string) => { active: CampaignSnapshot[]; awaitingRevive: CampaignSnapshot[]; lastTerminal?: CampaignSnapshot };
}

export const PROVIDER_HEALTH_FILE = "provider-health.json";
export const CAMPAIGNS_DB_FILE = "campaigns.db";

export async function gatherStatusReport(opts: GatherOptions): Promise<StatusReport> {
  const now = opts.now ?? Date.now();
  const providerPath = join(opts.memoryDbPath, PROVIDER_HEALTH_FILE);
  const campaignsPath = join(opts.memoryDbPath, CAMPAIGNS_DB_FILE);
  return {
    now,
    health: await probeHealth(opts.healthUrl, opts.fetchImpl ?? fetch),
    providers: readProviderBenches(providerPath, now),
    campaigns: readCampaigns(campaignsPath, opts.loadCampaigns ?? loadCampaignsFromDb),
    update: { path: opts.installRoot, last: readUpdateHistory(opts.installRoot).at(-1) },
  };
}

async function probeHealth(url: string | undefined, fetchImpl: typeof fetch): Promise<StatusReport["health"]> {
  if (!url) return { reachable: false, detail: "no web port configured" };
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 2000);
    const res = await fetchImpl(url, { signal: controller.signal });
    clearTimeout(timer);
    if (!res.ok) return { reachable: false, detail: `HTTP ${res.status}` };
    const body = (await res.json()) as { status?: string; uptime?: number };
    return { reachable: true, status: body.status, uptimeSeconds: body.uptime };
  } catch (err) {
    return { reachable: false, detail: (err as Error).message.slice(0, 120) };
  }
}

export function readProviderBenches(path: string, now: number): StatusReport["providers"] {
  if (!existsSync(path)) return { readable: false, path, benched: [], total: 0 };
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as { entries?: Array<[string, Partial<ProviderBench>]> };
    const entries = raw.entries ?? [];
    const benched: ProviderBench[] = [];
    for (const [name, e] of entries) {
      const cooldownUntil = typeof e.cooldownUntil === "number" ? e.cooldownUntil : 0;
      const status = typeof e.status === "string" ? e.status : "unknown";
      // A bench is live only while its cooldown is ahead of now: a stale
      // "down" whose cooldown expired is retried on the next call.
      if (cooldownUntil > now || (status !== "healthy" && cooldownUntil > now)) {
        benched.push({
          name,
          status,
          consecutiveFailures: typeof e.consecutiveFailures === "number" ? e.consecutiveFailures : 0,
          cooldownUntil,
          lastError: typeof e.lastError === "string" ? e.lastError : "",
        });
      }
    }
    benched.sort((a, b) => b.cooldownUntil - a.cooldownUntil);
    return { readable: true, path, benched, total: entries.length };
  } catch {
    return { readable: false, path, benched: [], total: 0 };
  }
}

function readCampaigns(path: string, load: NonNullable<GatherOptions["loadCampaigns"]>): StatusReport["campaigns"] {
  if (!existsSync(path)) return { readable: false, path, active: [], awaitingRevive: [] };
  try {
    return { readable: true, path, ...load(path) };
  } catch {
    return { readable: false, path, active: [], awaitingRevive: [] };
  }
}

function loadCampaignsFromDb(dbPath: string): { active: CampaignSnapshot[]; awaitingRevive: CampaignSnapshot[]; lastTerminal?: CampaignSnapshot } {
  const storage = new CampaignStorage(dbPath);
  try {
    const active = storage.listActive().map(snapshotOf);
    const awaitingRevive = storage.listAwaitingAutoRevive().map(snapshotOf);
    const lastTerminal = storage.listRecentTerminal(1).map(snapshotOf)[0];
    return { active, awaitingRevive, lastTerminal };
  } finally {
    storage.close();
  }
}

export function snapshotOf(c: {
  id: string; state: string; projectRoot: string; currentMilestone: number;
  milestones: Array<{ title: string; status: string }>; updatedAt: number; lastError?: string; autoReviveAt?: number;
}): CampaignSnapshot {
  const m = c.milestones[c.currentMilestone];
  return {
    id: c.id,
    state: c.state,
    projectRoot: c.projectRoot,
    milestoneIndex: c.currentMilestone,
    milestoneCount: c.milestones.length,
    milestoneTitle: m?.title,
    milestoneStatus: m?.status,
    updatedAt: c.updatedAt,
    lastError: c.lastError,
    autoReviveAt: c.autoReviveAt,
  };
}

export function renderStatusReport(r: StatusReport): string[] {
  const lines: string[] = [];
  const now = r.now;

  if (r.health.reachable) {
    lines.push(`Health: ${r.health.status ?? "unknown"}${typeof r.health.uptimeSeconds === "number" ? ` (up ${describeSpan(r.health.uptimeSeconds * 1000)})` : ""}`);
  } else {
    lines.push(`Health: unreachable${r.health.detail ? ` — ${r.health.detail}` : ""}`);
  }

  if (!r.providers.readable) {
    lines.push(`Providers: ${r.providers.path} not readable — no bench record`);
  } else if (r.providers.benched.length === 0) {
    lines.push(`Providers: no bench in effect (${r.providers.total} tracked)`);
  } else {
    lines.push(`Providers benched (${r.providers.benched.length} of ${r.providers.total}):`);
    for (const b of r.providers.benched) {
      const err = b.lastError ? ` — ${b.lastError.replace(/\s+/g, " ").slice(0, 100)}` : "";
      lines.push(`- ${b.name}: ${b.status}, ${b.consecutiveFailures} failure${b.consecutiveFailures === 1 ? "" : "s"}, retry ${describeWhen(b.cooldownUntil, now)}${err}`);
    }
  }

  if (!r.campaigns.readable) {
    lines.push(`Campaign: ${r.campaigns.path} not readable`);
  } else {
    if (r.campaigns.active.length === 0) lines.push("Campaign: none active");
    for (const c of r.campaigns.active) lines.push(`Campaign ${c.id}: ${describeCampaign(c, now)}`);
    for (const c of r.campaigns.awaitingRevive) {
      lines.push(`Campaign ${c.id}: failed, auto-revive ${describeWhen(c.autoReviveAt ?? now, now)}${c.lastError ? ` — ${c.lastError.slice(0, 120)}` : ""}`);
    }
    if (r.campaigns.active.length === 0 && r.campaigns.awaitingRevive.length === 0 && r.campaigns.lastTerminal) {
      const c = r.campaigns.lastTerminal;
      lines.push(`Last campaign ${c.id}: ${c.state} ${describeAgo(now - c.updatedAt)}${c.lastError ? ` — ${c.lastError.slice(0, 120)}` : ""}`);
    }
  }

  lines.push(describeUpdateEvent(r.update.last, now));
  return lines;
}

function describeCampaign(c: CampaignSnapshot, now: number): string {
  const where = c.milestoneCount > 0
    ? `milestone ${Math.min(c.milestoneIndex + 1, c.milestoneCount)}/${c.milestoneCount}${c.milestoneTitle ? ` "${c.milestoneTitle}"` : ""}${c.milestoneStatus ? ` (${c.milestoneStatus})` : ""}`
    : "no milestones yet";
  return `${c.state}, ${where}, updated ${describeAgo(now - c.updatedAt)}`;
}
