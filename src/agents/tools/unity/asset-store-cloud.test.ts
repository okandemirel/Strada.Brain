import { describe, it, expect, vi, beforeEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  UnityAssetStoreClient,
  UnityLinkExpiredError,
  type UnityAssetStoreLink,
  type FetchLike,
} from "./asset-store-cloud.js";
import { MyAssetsCloudTool, markDownloaded } from "./my-assets-cloud-tool.js";
import type { ToolContext } from "../tool.interface.js";

const LINK: UnityAssetStoreLink = {
  refreshToken: "rt-1234567890",
  identityHost: "https://id.test",
  packagesHost: "https://pkg.test",
  clientSecret: "secret",
  linkedAt: Date.now(),
};

/** A fetch stub that answers token + purchases + search + download-info. */
function makeFetch(handlers: Partial<Record<string, (url: string, init?: RequestInit) => unknown>>): FetchLike {
  return async (url: string, init?: RequestInit) => {
    for (const [key, handler] of Object.entries(handlers)) {
      if (url.startsWith(key)) {
        const body = handler(url, init);
        return new Response(JSON.stringify(body), { status: 200 });
      }
    }
    return new Response("not found", { status: 404 });
  };
}

const TOKEN_OK = { access_token: "at-xyz", expires_in: 3600 };

describe("UnityAssetStoreClient", () => {
  it("refreshes the token once and reuses it across calls", async () => {
    let tokenCalls = 0;
    const f = makeFetch({
      "https://id.test/v1/oauth2/token": () => {
        tokenCalls += 1;
        return TOKEN_OK;
      },
      "https://pkg.test/-/api/purchases": () => [
        { productId: "1", title: "Pig Pack", publisher: "Acme" },
      ],
    });
    const client = new UnityAssetStoreClient(LINK, f);

    const a = await client.listPurchases();
    const b = await client.listPurchases();
    expect(a[0]!.title).toBe("Pig Pack");
    expect(b).toHaveLength(1);
    expect(tokenCalls).toBe(1);
  });

  it("sends the packman refresh grant with the stored secret", async () => {
    let seenBody = "";
    const f: FetchLike = async (url, init) => {
      if (url.includes("oauth2/token")) {
        seenBody = String(init?.body ?? "");
        return new Response(JSON.stringify(TOKEN_OK), { status: 200 });
      }
      return new Response("[]", { status: 200 });
    };
    const client = new UnityAssetStoreClient(LINK, f);
    await client.listPurchases();
    expect(seenBody).toContain("grant_type=refresh_token");
    expect(seenBody).toContain("refresh_token=rt-1234567890");
    expect(seenBody).toContain("client_id=packman");
    expect(seenBody).toContain("client_secret=secret");
  });

  it("maps a 401 on purchases to UnityLinkExpiredError", async () => {
    const f: FetchLike = async (url) => {
      if (url.includes("oauth2/token")) {
        return new Response(JSON.stringify(TOKEN_OK), { status: 200 });
      }
      return new Response("unauthorized", { status: 401 });
    };
    const client = new UnityAssetStoreClient(LINK, f);
    await expect(client.listPurchases()).rejects.toBeInstanceOf(UnityLinkExpiredError);
  });

  it("searches the kharma catalog with the q parameter", async () => {
    let seenUrl = "";
    const f: FetchLike = async (url) => {
      seenUrl = url;
      return new Response(
        JSON.stringify({ total: 2, results: [{ id: 27821, title: "Pig" }, { id: 176353, title: "Pig Family" }] }),
        { status: 200 },
      );
    };
    const client = new UnityAssetStoreClient(LINK, f);
    const hits = await client.searchStore("pig character", 5);
    expect(hits).toHaveLength(2);
    expect(seenUrl).toContain("q=pig%20character");
    expect(seenUrl).toContain("rows=5");
    expect(seenUrl.startsWith("https://kharma.unity3d.com/")).toBe(true);
  });

  it("reads the signed url out of download-info", async () => {
    const f = makeFetch({
      "https://id.test/v1/oauth2/token": () => TOKEN_OK,
      "https://pkg.test/-/api/legacy-package-download-info/27821": () => ({
        url: "https://signed.example/pkg.unitypackage?sig=abc",
        filename: "pig.unitypackage",
      }),
    });
    const client = new UnityAssetStoreClient(LINK, f);
    const info = await client.getDownloadInfo("27821");
    expect(info.url).toContain("signed.example");
    expect(info.filename).toBe("pig.unitypackage");
  });
});

describe("markDownloaded", () => {
  it("flags owned packages present in the local cache, tolerating punctuation drift", () => {
    const merged = markDownloaded(
      [
        { productId: "1", title: "ARCADE FREE Racing Car", downloadedLocally: false },
        { productId: "2", title: "Some Pig Pack", downloadedLocally: false },
      ],
      ["ARCADE - FREE Racing Car", "20 Logo Templates"],
    );
    expect(merged[0]!.downloadedLocally).toBe(true);
    expect(merged[1]!.downloadedLocally).toBe(false);
  });
});

describe("MyAssetsCloudTool", () => {
  const ctx = { projectPath: "/p", workingDirectory: "/p", readOnly: false } as ToolContext;

  function toolWith(client: UnityAssetStoreClient): MyAssetsCloudTool {
    return new MyAssetsCloudTool(() => client);
  }

  it("search action lists catalog hits", async () => {
    const f = makeFetch({
      "https://kharma.unity3d.com/api/en-US/search/results.json": () => ({
        results: [{ id: 27821, title: "Pig", publisher: "Acme" }],
      }),
    });
    const tool = toolWith(new UnityAssetStoreClient(LINK, f));
    const result = await tool.execute({ action: "search", query: "pig" }, ctx);
    expect(result.isError).toBeFalsy();
    expect(String(result.content)).toContain("Pig");
    expect(String(result.content)).toContain("27821");
  });

  it("purchases action merges with the local cache flag", async () => {
    const f = makeFetch({
      "https://id.test/v1/oauth2/token": () => TOKEN_OK,
      "https://pkg.test/-/api/purchases": () => [
        { productId: "1", title: "ARCADE FREE Racing Car" },
        { productId: "2", title: "Unrelated Thing" },
      ],
    });
    const tool = toolWith(new UnityAssetStoreClient(LINK, f));
    const result = await tool.execute({ action: "purchases" }, ctx);
    expect(result.isError).toBeFalsy();
    const text = String(result.content);
    // The racing car IS in this machine's cache; the unrelated thing is not.
    expect(text).toContain("ARCADE FREE Racing Car");
    expect(text).toContain("ON DISK");
    expect(text).toContain("not downloaded");
  });

  it("rejects bad actions and missing params cleanly", async () => {
    const tool = toolWith(new UnityAssetStoreClient(LINK, makeFetch({})));
    expect((await tool.execute({ action: "nope" }, ctx)).isError).toBe(true);
    expect((await tool.execute({ action: "search" }, ctx)).isError).toBe(true);
    expect((await tool.execute({ action: "download-info" }, ctx)).isError).toBe(true);
  });
});
