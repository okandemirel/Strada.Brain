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

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { getLoggerSafe } from "../../../utils/logger.js";

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

  private async getToken(): Promise<string> {
    if (this.accessToken && Date.now() < this.accessTokenExpiresAt) {
      return this.accessToken;
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
    // ~3h after linking). Store it back whenever one is returned.
    const rotated = data["refresh_token"];
    if (typeof rotated === "string" && rotated.length >= 10 && rotated !== this.link.refreshToken) {
      this.link.refreshToken = rotated;
      persistUnityLink(this.link);
    }
    const expiresIn = Number(data["expires_in"] ?? 3600);
    this.accessToken = token;
    this.accessTokenExpiresAt = Date.now() + Math.max(60, expiresIn - 60) * 1000;
    return token;
  }
}

/** Load the stored link and build a client, or throw a precise instruction. */
export function createUnityAssetStoreClient(fetchImpl?: FetchLike): UnityAssetStoreClient {
  const link = loadUnityLink();
  if (!link) throw new UnityLinkMissingError();
  return new UnityAssetStoreClient(link, fetchImpl);
}

/** Whether the Unity Link step has been completed on this machine. */
export function isUnityLinked(): boolean {
  return loadUnityLink() !== undefined;
}

/** Persist the (possibly rotated) link back to disk, mode 600. */
export function persistUnityLink(link: UnityAssetStoreLink): void {
  writeFileSync(LINK_FILE, JSON.stringify(link, null, 2), { mode: 0o600 });
}
