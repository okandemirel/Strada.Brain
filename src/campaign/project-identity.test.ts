/**
 * Measured 2026-10-14 on the live proof run: companyName was Unity's
 * DefaultCompany, no application identifier was set for any platform, and the
 * document asked for a handheld game — a build nobody could install. The
 * orientation in the same file was read only by the scorecard, after delivery.
 */
import { describe, expect, it } from "vitest";
import {
  PROJECT_SETTINGS_PATH,
  identityAnswersSpec,
  readProjectIdentity,
  specOrientation,
} from "./project-identity.js";

const settings = (fields: string): string =>
  ["%YAML 1.1", "%TAG !u! tag:unity3d.com,2011:", "--- !u!129 &1", "PlayerSettings:", "  m_ObjectHideFlags: 0", fields].join("\n");

describe("readProjectIdentity", () => {
  it("reads the fields a store submission needs", () => {
    const identity = readProjectIdentity("/p", () =>
      settings(
        [
          "  companyName: Harbor Works",
          "  productName: Harbor Light",
          "  defaultScreenOrientation: 1",
          "  applicationIdentifier:",
          "    Android: com.harborworks.harborlight",
          "    iPhone: com.harborworks.harborlight",
        ].join("\n"),
      ),
    );
    expect(identity).toMatchObject({
      read: true,
      companyName: "Harbor Works",
      productName: "Harbor Light",
      orientation: "portrait",
      bundleIds: { Android: "com.harborworks.harborlight", iPhone: "com.harborworks.harborlight" },
    });
  });

  it("reads Unity's own default company as nobody having set one", () => {
    const identity = readProjectIdentity("/p", () =>
      settings(["  companyName: DefaultCompany", "  applicationIdentifier: {}"].join("\n")),
    );
    expect(identity.companyName).toBeUndefined();
    expect(identity.bundleIds).toEqual({});
  });

  it("says it could not read rather than reporting empty fields", () => {
    const identity = readProjectIdentity("/p", () => {
      throw new Error("ENOENT");
    });
    expect(identity.read).toBe(false);
    expect(identity.why).toContain(PROJECT_SETTINGS_PATH);
  });

  it("names no orientation for a code Unity does not define", () => {
    expect(readProjectIdentity("/p", () => settings("  defaultScreenOrientation: 9")).orientation).toBeUndefined();
    expect(readProjectIdentity("/p", () => settings("  companyName: X")).orientation).toBeUndefined();
    expect(readProjectIdentity("/p", () => settings("  defaultScreenOrientation: 4")).orientation).toBe("auto");
  });
});

describe("specOrientation", () => {
  it("reads an unambiguous statement", () => {
    expect(specOrientation("The game is portrait only.")).toBe("portrait");
    expect(specOrientation("Landscape, 16:9.")).toBe("landscape");
  });

  it("reads nothing from a document that names both, or neither", () => {
    expect(specOrientation("Portrait on phones, landscape on tablets.")).toBeUndefined();
    expect(specOrientation("A raft drifts down a river.")).toBeUndefined();
    expect(specOrientation(undefined)).toBeUndefined();
  });
});

describe("identityAnswersSpec", () => {
  const read = (over: Record<string, unknown> = {}) =>
    ({ read: true, bundleIds: {}, ...over }) as Parameters<typeof identityAnswersSpec>[0];

  it("refuses a handheld delivery with no company name and no identifier", () => {
    const verdict = identityAnswersSpec(read({ orientation: "portrait" }), "Portrait only.", true);
    expect(verdict.refusal).toContain("handheld");
    expect(verdict.refusal).toContain("companyName");
    expect(verdict.refusal).toContain("applicationIdentifier");
    expect(verdict.refusal).toContain(PROJECT_SETTINGS_PATH);
  });

  it("discloses the same gap without refusing when no handheld platform is asked for", () => {
    const verdict = identityAnswersSpec(read({ orientation: "landscape" }), "Windows, landscape.", false);
    expect(verdict.refusal).toBeUndefined();
    expect(verdict.lines.join("\n")).toContain("no handheld platform");
  });

  it("refuses an orientation the document states and the project contradicts", () => {
    const verdict = identityAnswersSpec(
      read({ companyName: "Harbor Works", bundleIds: { Android: "com.x.y" }, orientation: "landscape" }),
      "Portrait only.",
      true,
    );
    expect(verdict.refusal).toContain("asks for portrait");
    expect(verdict.refusal).toContain("set to landscape");
  });

  it("takes auto-rotation as answering a portrait document", () => {
    const verdict = identityAnswersSpec(
      read({ companyName: "Harbor Works", bundleIds: { Android: "com.x.y" }, orientation: "auto" }),
      "Portrait only.",
      true,
    );
    expect(verdict.refusal).toBeUndefined();
  });

  it("calls an orientation the document never states an assumption, not a defect", () => {
    const verdict = identityAnswersSpec(
      read({ companyName: "Harbor Works", bundleIds: { Android: "com.x.y" }, orientation: "landscape" }),
      "A raft drifts down a river.",
      true,
    );
    expect(verdict.refusal).toBeUndefined();
    expect(verdict.lines.join("\n")).toContain("assumption");
  });

  it("refuses nothing it could not measure", () => {
    const verdict = identityAnswersSpec({ read: false, bundleIds: {}, why: "no file" }, "Portrait only.", true);
    expect(verdict.refusal).toBeUndefined();
    expect(verdict.lines[0]).toContain("NOT measured");
  });
});
