/**
 * unity_my_assets_cloud — the account-level counterpart of unity_my_assets.
 *
 * unity_my_assets reads the local download cache; this tool answers the
 * bigger question: "what does the user OWN" (their full Unity Asset Store
 * library), plus store-wide catalog search, plus signed download info for
 * packages that are owned but not yet on disk. The output marks each owned
 * package with downloadedLocally so the agent can choose: import from disk
 * (unity_import_asset_package) or download first (then import).
 *
 * Requires the one-time Unity Link (see asset-store-cloud.ts); when the link
 * is missing or expired the tool says so verbatim instead of failing quietly.
 */

import { readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { ITool, ToolContext, ToolExecutionResult } from "../tool.interface.js";
import {
  createUnityAssetStoreClient,
  isUnityLinked,
  UnityLinkExpiredError,
  UnityLinkMissingError,
  type PurchasedPackage,
  type UnityAssetStoreClient,
  type FetchLike,
} from "./asset-store-cloud.js";

const ACTIONS = ["search", "purchases", "download-info"] as const;
type Action = (typeof ACTIONS)[number];

/** The local Asset Store download cache roots (same dirs unity_my_assets reads). */
function cacheRoots(): string[] {
  return [join(homedir(), "Library", "Unity", "Asset Store-5.x")];
}

function listCachedPackageNames(): string[] {
  const names: string[] = [];
  for (const root of cacheRoots()) {
    if (!existsSync(root)) continue;
    const walk = (dir: string, depth: number): void => {
      if (depth > 3) return;
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, entry.name);
        if (entry.isDirectory()) walk(p, depth + 1);
        else if (entry.name.toLowerCase().endsWith(".unitypackage")) {
          names.push(entry.name.replace(/\.unitypackage$/i, ""));
        }
      }
    };
    try {
      walk(root, 0);
    } catch {
      // An unreadable cache dir must not break the cloud query.
    }
  }
  return names;
}

/** Loose title match: "ARCADE FREE Racing Car" ~ "ARCADE - FREE Racing Car". */
function normalizeTitle(t: string): string {
  return t.toLowerCase().replace(/[^a-z0-9]/g, "");
}

export function markDownloaded(
  purchases: readonly PurchasedPackage[],
  cachedNames: readonly string[],
): PurchasedPackage[] {
  const normalizedCache = cachedNames.map(normalizeTitle);
  return purchases.map((p) => ({
    ...p,
    downloadedLocally: normalizedCache.some((c) => {
      const title = normalizeTitle(p.title);
      // Bare bidirectional substring flagged false ON DISK matches (a cached
      // "pig" marked every pig package downloaded) — require equality, or a
      // containment where the shorter side is a distinctive name (>= 6 chars).
      if (title.length === 0 || c.length === 0) return false;
      if (c === title) return true;
      const shorter = Math.min(c.length, title.length);
      return shorter >= 6 && (c.includes(title) || title.includes(c));
    }),
  }));
}

export class MyAssetsCloudTool implements ITool {
  readonly name = "unity_my_assets_cloud";
  readonly description =
    "Query the user's FULL Unity Asset Store library (their Unity account, not only the local " +
    "download cache): action 'purchases' lists everything they own with a downloadedLocally flag; " +
    "'search' searches the public store catalog; 'download-info' returns a signed download URL " +
    "for an owned productId. Requires the one-time Unity Link setup — when missing/expired the " +
    "tool says exactly that. Prefer owned packages over generating assets.";

  readonly inputSchema = {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: ACTIONS,
        description: "'purchases' (my library), 'search' (store catalog), or 'download-info'.",
      },
      query: {
        type: "string",
        description: "search only: catalog query, e.g. 'pig character'.",
      },
      productId: {
        type: "string",
        description: "download-info only: the product/package id from purchases or search.",
      },
      limit: { type: "number", description: "Max rows (default 20, cap 200)." },
      offset: { type: "number", description: "purchases paging offset (default 0)." },
    },
    required: ["action"],
  };

  constructor(
    private readonly clientFactory?: () => UnityAssetStoreClient,
    /** Test seam: replace the REAL download-cache scan. Without it the
     *  purchases test depended on what happened to be in this machine's
     *  Unity cache — green on the dev Mac, red on every CI runner. */
    private readonly cachedNamesImpl?: () => string[],
  ) {}

  async execute(input: Record<string, unknown>, _context: ToolContext): Promise<ToolExecutionResult> {
    const action = String(input["action"] ?? "") as Action;
    if (!(ACTIONS as readonly string[]).includes(action)) {
      return { content: `Error: action must be one of ${ACTIONS.join(", ")}`, isError: true };
    }

    let client: UnityAssetStoreClient;
    try {
      client = this.clientFactory?.() ?? createUnityAssetStoreClient();
    } catch (err) {
      if (err instanceof UnityLinkMissingError) {
        return { content: `Error: ${err.message}`, isError: true };
      }
      throw err;
    }

    const limit = Math.min(200, Math.max(1, Number(input["limit"] ?? 20) || 20));
    const offset = Math.max(0, Number(input["offset"] ?? 0) || 0);

    try {
      switch (action) {
        case "search": {
          const query = String(input["query"] ?? "").trim();
          if (!query) return { content: "Error: search needs a query", isError: true };
          const hits = await client.searchStore(query, limit);
          if (hits.length === 0) return { content: `No store results for "${query}".` };
          return {
            content: hits
              .map((h) => `• ${h.title} (id ${h.id}${h.publisher ? `, ${h.publisher}` : ""})`)
              .join("\n"),
          };
        }
        case "purchases": {
          const purchases = await client.listPurchases(limit, offset);
          if (purchases.length === 0) {
            return { content: offset === 0 ? "The account owns no packages (or the library is private and unread)." : "No more purchases past this offset." };
          }
          const merged = markDownloaded(purchases, (this.cachedNamesImpl ?? listCachedPackageNames)());
          return {
            content: merged
              .map(
                (p) =>
                  `• ${p.title} (productId ${p.productId}${p.publisher ? `, ${p.publisher}` : ""})` +
                  (p.downloadedLocally ? " — ON DISK" : " — not downloaded"),
              )
              .join("\n"),
          };
        }
        case "download-info": {
          const productId = String(input["productId"] ?? "").trim();
          if (!productId) return { content: "Error: download-info needs productId", isError: true };
          const info = await client.getDownloadInfo(productId);
          return {
            content:
              `Signed download for ${productId}: ${info.url}\n` +
              "Download it to disk (curl -L), then unity_import_asset_package with packagePath.",
          };
        }
      }
    } catch (err) {
      if (err instanceof UnityLinkExpiredError) {
        return { content: `Error: ${err.message}`, isError: true };
      }
      return {
        content: `Error: ${err instanceof Error ? err.message : String(err)}`,
        isError: true,
      };
    }
  }
}

export { isUnityLinked };
export type { FetchLike };
