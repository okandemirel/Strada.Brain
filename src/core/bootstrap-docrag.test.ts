import { describe, it, expect, vi } from "vitest";
import { indexFrameworkDocs } from "./bootstrap-docrag.js";

const logger = () => ({ info: vi.fn(), warn: vi.fn() });

describe("indexFrameworkDocs (audit 05.F1 / D45)", () => {
  it("initializes the doc store and indexes every package root, in that order", async () => {
    const calls: string[] = [];
    const pipeline = {
      initialize: vi.fn(async () => { calls.push("initialize"); }),
      indexPackage: vi.fn(async (pkg: { name: string }) => { calls.push(`index:${pkg.name}`); }),
    };
    const result = await indexFrameworkDocs(pipeline, [{ name: "com.strada.core" }, { name: "com.strada.modules" }], logger());
    expect(calls).toEqual(["initialize", "index:com.strada.core", "index:com.strada.modules"]);
    expect(result).toEqual({ indexed: ["com.strada.core", "com.strada.modules"], failed: [] });
  });

  it("a package that fails is named and the others are still indexed; a store that cannot initialize indexes nothing (guard)", async () => {
    const pipeline = {
      initialize: vi.fn(async () => {}),
      indexPackage: vi.fn(async (pkg: { name: string }) => { if (pkg.name === "bad") throw new Error("no docs"); }),
    };
    const log = logger();
    const result = await indexFrameworkDocs(pipeline, [{ name: "bad" }, { name: "good" }], log);
    expect(result).toEqual({ indexed: ["good"], failed: ["bad"] });
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining("failed"), expect.objectContaining({ package: "bad" }));

    const broken = { initialize: vi.fn(async () => { throw new Error("locked"); }), indexPackage: vi.fn() };
    const none = await indexFrameworkDocs(broken, [{ name: "x" }], logger());
    expect(none).toEqual({ indexed: [], failed: ["x"] });
    expect(broken.indexPackage).not.toHaveBeenCalled();
  });
});
