import { describe, it, expect, afterEach } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { UnityAssetStoreClient, type FetchLike, type UnityAssetStoreLink } from "./asset-store-cloud.js";
import { MyAssetsCloudTool } from "./my-assets-cloud-tool.js";
import type { ToolContext } from "../tool.interface.js";

/**
 * Audited 2026-09-06: `download-info` returned a signed URL and told the agent
 * "curl -L it, then unity_import_asset_package with packagePath" — a
 * three-step manual chain that never once ran across a whole campaign. The
 * only real-art source was one shell command away and stayed there.
 */
const LINK: UnityAssetStoreLink = {
  refreshToken: "rt-1234567890",
  identityHost: "https://id.test",
  packagesHost: "https://pkg.test",
  clientSecret: "secret",
  linkedAt: Date.now(),
};
const PKG = Buffer.from("not-really-a-tarball-but-bytes-enough");

function fetchFor(opts: { body?: Buffer; downloadStatus?: number; seen?: Array<{ url: string; auth?: string }> }): FetchLike {
  return async (url: string, init?: RequestInit) => {
    const auth = (init?.headers as Record<string, string> | undefined)?.["Authorization"];
    opts.seen?.push({ url, auth });
    if (url.startsWith("https://id.test/")) {
      return new Response(JSON.stringify({ access_token: "at-xyz", expires_in: 3600 }), { status: 200 });
    }
    if (url.includes("legacy-package-download-info")) {
      return new Response(JSON.stringify({
        result: { download: {
          url: "https://cdn.test/signed/pigs.unitypackage?sig=1",
          filename_safe_package_name: "Plump Pigs Pack",
          filename_safe_publisher_name: "Soak Games",
          filename_safe_category_name: "3D Characters",
        } },
      }), { status: 200 });
    }
    if (url.startsWith("https://cdn.test/")) {
      return new Response(opts.body ?? PKG, { status: opts.downloadStatus ?? 200 });
    }
    return new Response("nope", { status: 404 });
  };
}

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const root = (): string => { const d = mkdtempSync(join(tmpdir(), "asset-cache-")); dirs.push(d); return d; };
const ctx = { projectPath: "/p", workingDirectory: "/p", readOnly: false } as ToolContext;

describe("unity_my_assets_cloud download", () => {
  it("writes the package into Unity's cache layout and hands back the path", async () => {
    const cache = root();
    const seen: Array<{ url: string; auth?: string }> = [];
    const tool = new MyAssetsCloudTool(
      () => new UnityAssetStoreClient(LINK, fetchFor({ seen })),
      () => [],
      () => cache,
    );
    const result = await tool.execute({ action: "download", productId: "12345" }, ctx);
    expect(result.isError).toBeFalsy();

    const expected = join(cache, "Soak Games", "3D Characters", "Plump Pigs Pack.unitypackage");
    expect(existsSync(expected)).toBe(true);
    expect(readFileSync(expected).equals(PKG)).toBe(true);
    expect(String(result.content)).toContain(expected);
    expect(String(result.content)).toContain("unity_import_asset_package");
    // No partial file left behind.
    expect(existsSync(`${expected}.part-${process.pid}`)).toBe(false);
  });

  it("never sends the bearer token to the CDN", async () => {
    const seen: Array<{ url: string; auth?: string }> = [];
    const client = new UnityAssetStoreClient(LINK, fetchFor({ seen }));
    await client.downloadPackage("12345", root());
    const cdn = seen.find((s) => s.url.startsWith("https://cdn.test/"))!;
    expect(cdn.auth).toBeUndefined();
    const info = seen.find((s) => s.url.includes("download-info"))!;
    expect(info.auth).toBe("Bearer at-xyz");
  });

  it("refuses an empty body and writes nothing", async () => {
    const cache = root();
    const client = new UnityAssetStoreClient(LINK, fetchFor({ body: Buffer.alloc(0) }));
    await expect(client.downloadPackage("12345", cache)).rejects.toThrow(/empty body/);
    expect(existsSync(join(cache, "Soak Games"))).toBe(false);
  });

  it("reports a failed download with its status", async () => {
    const client = new UnityAssetStoreClient(LINK, fetchFor({ downloadStatus: 503 }));
    await expect(client.downloadPackage("12345", root())).rejects.toThrow(/HTTP 503/);
  });
});
