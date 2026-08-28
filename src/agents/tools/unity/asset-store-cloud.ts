/**
 * Unity Asset Store — account-level ("My Assets") access from the headless path.
 *
 * The cache-based unity_my_assets only sees packages already DOWNLOADED to
 * disk. The user's full purchased/claimed library lives behind Unity's
 * package-manager ("packman") OAuth2 flow. The recipe was proven in the
 * Enhanced Package Manager project (Soak Games, live-verified 2026-08-12)
 * and re-verified against the live endpoints here on 2026-08-27:
 *
 *   - Store catalog search:  GET kharma.unity3d.com/api/en-US/search/results.json?q=..
 *                            (no auth; verified: "pig" → 1105 results)
 *   - Token:                 POST {identityHost}/v1/oauth2/token
 *                            grant_type=refresh_token, client_id "packman",
 *                            client_secret from the Editor's own UnityConnect
 *                            configuration (captured once at Unity Link time)
 *   - Purchases ("My Assets"): GET {packagesHost}/-/api/purchases?offset&limit
 *                            (401 without Bearer — verified)
 *   - Download info:         GET {packagesHost}/-/api/legacy-package-download-info/{productId}
 *
 * The interactive part (the one-time OAuth consent) is NOT here by design:
 * it happens once through the Editor's own login dialog during the Unity
 * Link setup step, which writes ~/.strada/unity-asset-store.json. This tool
 * only does the fully-headless refresh + queries. A dead/revoked refresh
 * token is reported as "re-run the Unity Link step", never as a silent failure.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync, chmodSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { getLoggerSafe } from "../../../utils/logger.js";
import { acquireProjectWriteLock } from "../../../common/project-write-lock.js";

// =============================================================================
// TYPES
// =============================================================================

export interface UnityAssetStoreLink {
  /** Refresh token from the one-time consent exchange. */
  refreshToken: string;
  /** Unity identity host, e.g. https://api.unity.com */
  identityHost: string;
  /** Packages API host, e.g. https://packages-v2.unity.com */
  packagesHost: string;
  /** The editor's packman client key, captured at link time. */
  clientSecret: string;
  /** Epoch ms of when the link was made (informational). */
  linkedAt: number;
}

export interface StoreCatalogHit {
  id: string;
  title: string;
  publisher?: string;
  category?: string;
}

export interface PurchasedPackage {
  productId: string;
  title: string;
  publisher?: string;
  /** True when the package's files are already in the local download cache. */
  downloadedLocally: boolean;
}

export interface DownloadInfo {
  productId: string;
  url: string;
  filename?: string;
}

export class UnityLinkMissingError extends Error {
  constructor() {
    super(
      "Unity account is not linked. Run the Unity Link step once (it opens the standard " +
        "Unity sign-in dialog) so the headless path can refresh tokens.",
    );
    this.name = "UnityLinkMissingError";
  }
}

export class UnityLinkExpiredError extends Error {
  constructor(detail: string) {
    super(
      "The Unity account link expired or was revoked — re-run the Unity Link step. " +
        `Detail: ${detail}`,
    );
    this.name = "UnityLinkExpiredError";
  }
}

// =============================================================================
// LINK STORE
// =============================================================================

const LINK_DIR = join(homedir(), ".strada");
const LINK_FILE = join(LINK_DIR, "unity-asset-store.json");

export function unityLinkFilePath(): string {
  return LINK_FILE;
}

export function loadUnityLink(): UnityAssetStoreLink | undefined {
  try {
    if (!existsSync(LINK_FILE)) return undefined;
    const raw: unknown = JSON.parse(readFileSync(LINK_FILE, "utf8"));
    const link = raw as Partial<UnityAssetStoreLink>;
    if (
      typeof link.refreshToken !== "string" || link.refreshToken.length < 10 ||
      typeof link.identityHost !== "string" || !link.identityHost.startsWith("https://") ||
      typeof link.packagesHost !== "string" || !link.packagesHost.startsWith("https://") ||
      typeof link.clientSecret !== "string" || link.clientSecret.length === 0
    ) {
      return undefined;
    }
    return link as UnityAssetStoreLink;
  } catch {
    return undefined;
  }
}

// =============================================================================
// CLIENT (fetch-injectable for tests)
// =============================================================================

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

const KHARMA_BASE = "https://kharma.unity3d.com";

export class UnityAssetStoreClient {
  private accessToken: string | undefined;
  private accessTokenExpiresAt = 0;

  constructor(
    private readonly link: UnityAssetStoreLink,
    private readonly fetchImpl: FetchLike = fetch,
    /** Sync rotation with ~/.strada on refresh. Off for injected (test) links,
     *  whose fixture token must never be shadowed by the real machine's file. */
    private readonly syncWithDisk: boolean = fetchImpl === fetch,
  ) {}

  /** Store-wide catalog search (kharma, no auth needed). */
  async searchStore(query: string, rows = 10): Promise<StoreCatalogHit[]> {
    const url = `${KHARMA_BASE}/api/en-US/search/results.json?q=${encodeURIComponent(query)}&page=1&rows=${Math.min(50, Math.max(1, rows))}`;
    const resp = await this.fetchImpl(url);
    if (!resp.ok) {
      throw new Error(`Asset Store search failed (HTTP ${resp.status})`);
    }
    const data = (await resp.json()) as { results?: Array<Record<string, unknown>> };
    return (data.results ?? []).map((r) => ({
      id: String(r["id"] ?? ""),
      title: String(r["title"] ?? r["name"] ?? ""),
      publisher: typeof r["publisher"] === "string" ? r["publisher"] : undefined,
      category: typeof r["category"] === "string" ? r["category"] : undefined,
    }));
  }

  /** The user's full purchased/claimed library ("My Assets"), paged. */
  async listPurchases(limit = 50, offset = 0): Promise<PurchasedPackage[]> {
    const token = await this.getToken();
    const url = `${this.link.packagesHost}/-/api/purchases?limit=${Math.min(200, Math.max(1, limit))}&offset=${Math.max(0, offset)}`;
    const resp = await this.fetchImpl(url, { headers: { Authorization: `Bearer ${token}` } });
    if (resp.status === 401 || resp.status === 403) {
      throw new UnityLinkExpiredError(`purchases returned HTTP ${resp.status}`);
    }
    if (!resp.ok) {
      throw new Error(`purchases failed (HTTP ${resp.status})`);
    }
    const data = (await resp.json()) as Array<Record<string, unknown>> | { results?: Array<Record<string, unknown>> };
    const rows = Array.isArray(data) ? data : (data.results ?? []);
    return rows.map((r) => ({
      productId: String(r["productId"] ?? r["id"] ?? ""),
      title: String(r["title"] ?? r["displayName"] ?? r["name"] ?? ""),
      publisher: typeof r["publisher"] === "string" ? r["publisher"] : undefined,
      downloadedLocally: false, // merged by the caller against the disk cache
    }));
  }

  /** Signed download info for a purchased package. */
  async getDownloadInfo(productId: string): Promise<DownloadInfo> {
    const token = await this.getToken();
    const url = `${this.link.packagesHost}/-/api/legacy-package-download-info/${encodeURIComponent(productId)}`;
    const resp = await this.fetchImpl(url, { headers: { Authorization: `Bearer ${token}` } });
    if (resp.status === 401 || resp.status === 403) {
      throw new UnityLinkExpiredError(`download-info returned HTTP ${resp.status}`);
    }
    if (!resp.ok) {
      throw new Error(`download-info failed (HTTP ${resp.status}) for ${productId}`);
    }
    const data = (await resp.json()) as Record<string, unknown>;
    // Verified live shape: {"result":{"download":{"url": "...", ...}}} — but
    // tolerate flat and single-nested variants too.
    const nested = data["result"] as Record<string, unknown> | undefined;
    const dl = (nested?.["download"] ?? data["download"]) as Record<string, unknown> | undefined;
    const urlOut = typeof data["url"] === "string" ? data["url"]
      : typeof dl?.["url"] === "string" ? dl["url"] as string
      : undefined;
    if (!urlOut) {
      throw new Error(`download-info for ${productId} carried no url`);
    }
    return {
      productId,
      url: urlOut,
      filename: typeof dl?.["filename_safe_package_name"] === "string"
        ? `${dl["filename_safe_package_name"]}.unitypackage`
        : typeof data["filename"] === "string" ? data["filename"] : undefined,
    };
  }

  // ===========================================================================
  // TOKEN
  // ===========================================================================

  /** Single-flight guard: N concurrent calls share ONE refresh round-trip. */
  private refreshInFlight: Promise<string> | undefined;

  private async getToken(): Promise<string> {
    if (this.accessToken && Date.now() < this.accessTokenExpiresAt) {
      return this.accessToken;
    }
    // Rotation makes a concurrent second refresh fatal: the first response
    // rotates the refresh token server-side, the second POST then carries a
    // dead token and kills the link (the exact HTTP-412-after-3h failure the
    // rotation fix was for). One refresh in flight, everyone awaits it.
    if (!this.refreshInFlight) {
      this.refreshInFlight = this.refreshAccessToken().finally(() => {
        this.refreshInFlight = undefined;
      });
    }
    return this.refreshInFlight;
  }

  private async refreshAccessToken(): Promise<string> {
    // Cross-process guard for the read-rotate-write of the link file: a second
    // Strada process refreshing in parallel would race the same rotation.
    const lock = this.syncWithDisk
      ? await acquireProjectWriteLock(LINK_DIR, { timeoutMs: 30_000 })
      : null;
    try {
      if (this.accessToken && Date.now() < this.accessTokenExpiresAt) {
        return this.accessToken; // another process refreshed while we waited
      }
      // Adopt an on-disk rotation done by another process while we waited.
      if (this.syncWithDisk) {
        const onDisk = loadUnityLink();
        if (onDisk && onDisk.refreshToken !== this.link.refreshToken) {
          this.link.refreshToken = onDisk.refreshToken;
        }
      }
      const body =
        "grant_type=refresh_token" +
        `&refresh_token=${encodeURIComponent(this.link.refreshToken)}` +
        "&client_id=packman" +
        `&client_secret=${encodeURIComponent(this.link.clientSecret)}`;
      const resp = await this.fetchImpl(`${this.link.identityHost}/v1/oauth2/token`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body,
      });
      if (resp.status === 400 || resp.status === 401 || resp.status === 403) {
        throw new UnityLinkExpiredError(`token refresh returned HTTP ${resp.status}`);
      }
      if (!resp.ok) {
        throw new Error(`token refresh failed (HTTP ${resp.status})`);
      }
      const data = (await resp.json()) as Record<string, unknown>;
      const token = data["access_token"];
      if (typeof token !== "string" || token.length === 0) {
        getLoggerSafe().warn("Unity token refresh returned no access_token", {
          keys: Object.keys(data).join(","),
        });
        throw new Error("token refresh returned no access_token");
      }
      // Refresh tokens ROTATE: every refresh response can carry a NEW
      // refresh_token, and the old one dies server-side. Not persisting the
      // rotation kills the link on the SECOND refresh (measured live: HTTP 412
      // ~3h after linking). Persist FIRST (atomically), then adopt in memory —
      // a failed persist must not leave disk holding a dead token silently.
      const rotated = data["refresh_token"];
      if (typeof rotated === "string" && rotated.length >= 10 && rotated !== this.link.refreshToken) {
        if (this.syncWithDisk) {
          try {
            persistUnityLink({ ...this.link, refreshToken: rotated });
          } catch (err) {
            getLoggerSafe().warn(
              "Rotated Unity refresh token could not be persisted — the link DIES with this process; re-link will be needed",
              { error: err instanceof Error ? err.message : String(err) },
            );
          }
        }
        this.link.refreshToken = rotated;
      }
      const expiresIn = Number(data["expires_in"] ?? 3600);
      this.accessToken = token;
      this.accessTokenExpiresAt = Date.now() + Math.max(60, expiresIn - 60) * 1000;
      return token;
    } finally {
      lock?.release();
    }
  }
}

/**
 * Process-wide client cache. A fresh client per tool call meant a full
 * refresh-token POST (and a rotation!) on EVERY call — the single-flight
 * guard only helps within one instance. Cache invalidates when the link file
 * changes on disk (a re-link). Tests injecting fetchImpl bypass the cache.
 */
let cachedClient: { client: UnityAssetStoreClient; linkMtimeMs: number } | undefined;

/** Load the stored link and build a client, or throw a precise instruction. */
export function createUnityAssetStoreClient(fetchImpl?: FetchLike): UnityAssetStoreClient {
  if (fetchImpl) {
    const link = loadUnityLink();
    if (!link) throw new UnityLinkMissingError();
    return new UnityAssetStoreClient(link, fetchImpl);
  }
  let mtimeMs = 0;
  try {
    mtimeMs = statSync(LINK_FILE).mtimeMs;
  } catch {
    // Missing file falls through to loadUnityLink's undefined below.
  }
  if (cachedClient && cachedClient.linkMtimeMs === mtimeMs) {
    return cachedClient.client;
  }
  const link = loadUnityLink();
  if (!link) throw new UnityLinkMissingError();
  const client = new UnityAssetStoreClient(link);
  cachedClient = { client, linkMtimeMs: mtimeMs };
  return client;
}

/** Whether the Unity Link step has been completed on this machine. */
export function isUnityLinked(): boolean {
  return loadUnityLink() !== undefined;
}

/** Persist the (possibly rotated) link back to disk, mode 600, ATOMICALLY.
 *  A bare write could truncate the only copy of the refresh token on a crash
 *  or full disk; tmp+rename cannot. chmod fixes a pre-existing file too. */
export function persistUnityLink(link: UnityAssetStoreLink): void {
  mkdirSync(LINK_DIR, { recursive: true });
  const tmp = `${LINK_FILE}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(link, null, 2), { mode: 0o600 });
  renameSync(tmp, LINK_FILE);
  try {
    chmodSync(LINK_FILE, 0o600);
  } catch {
    // Permission fixing is best-effort; the rename already landed the content.
  }
}
