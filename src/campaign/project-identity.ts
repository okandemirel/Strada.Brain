/**
 * WHO THE DELIVERED GAME SAYS IT IS, and whether that answers the document.
 *
 * Measured 2026-10-14 on the live proof run: the project's company name was
 * Unity's own DefaultCompany, no application identifier was set for any
 * platform, and the document asked for a handheld game. A build with no
 * identity cannot be installed on a device or submitted to a store, and
 * nothing in the delivery gate had ever looked — the orientation the same file
 * holds was read only by the scorecard, after delivery.
 *
 * This module MEASURES (readProjectIdentity) and JUDGES AGAINST THE DOCUMENT
 * (identityAnswersSpec) separately: what the file says is a fact, what the
 * document asks for is a reading of prose, and a refusal must be able to name
 * which of the two it came from.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

/** Where Unity keeps the fields below, relative to the project. */
export const PROJECT_SETTINGS_PATH = "ProjectSettings/ProjectSettings.asset";

/** How Unity writes "nobody set this". */
const UNITY_DEFAULT_COMPANY = "DefaultCompany";

export type ScreenOrientation = "portrait" | "landscape" | "auto";

export interface ProjectIdentity {
  /** False when ProjectSettings.asset could not be read; `why` says so. */
  readonly read: boolean;
  readonly why?: string;
  /** Absent when the field is missing, empty or still Unity's default. */
  readonly companyName?: string;
  readonly productName?: string;
  /** Application identifier per platform key, as the file spells both. */
  readonly bundleIds: Readonly<Record<string, string>>;
  /** The orientation the project is set to, when the code is one Unity defines. */
  readonly orientation?: ScreenOrientation;
}

/** `defaultScreenOrientation`'s codes, as Unity's UIOrientation enum defines them. */
function orientationOf(code: number | undefined): ScreenOrientation | undefined {
  if (code === 0 || code === 1) return "portrait";
  if (code === 2 || code === 3) return "landscape";
  if (code === 4) return "auto";
  return undefined;
}

/**
 * The identity fields of ProjectSettings.asset. YAML is read by line here on
 * purpose: the file is a Unity-serialized asset whose tags (`!u!129`) no
 * general YAML reader accepts, and these four fields are flat scalars.
 */
export function readProjectIdentity(
  projectRoot: string,
  readText: (path: string) => string = (p) => readFileSync(p, "utf8"),
): ProjectIdentity {
  let text: string;
  try {
    text = readText(join(projectRoot, PROJECT_SETTINGS_PATH));
  } catch (err) {
    return {
      read: false,
      bundleIds: {},
      why: `${PROJECT_SETTINGS_PATH} could not be read (${err instanceof Error ? err.message : String(err)})`,
    };
  }
  const scalar = (field: string): string | undefined => {
    const m = new RegExp(`^\\s*${field}:[ \\t]*(.*)$`, "mu").exec(text);
    if (!m) return undefined;
    const value = m[1]!.trim().replace(/^['"]|['"]$/gu, "");
    return value === "" || value === "{}" ? undefined : value;
  };
  const company = scalar("companyName");
  const orientationCode = scalar("defaultScreenOrientation");
  // `applicationIdentifier:` opens a per-platform map; its indented children
  // are the platform keys. An empty map is written as `{}` on the same line.
  const bundleIds: Record<string, string> = {};
  const block = /^[ \t]*applicationIdentifier:[ \t]*\n((?:[ \t]+\S.*\n?)*)/mu.exec(text);
  for (const line of (block?.[1] ?? "").split("\n")) {
    const entry = /^[ \t]+([A-Za-z0-9_.]+):[ \t]*(.*)$/u.exec(line);
    const value = entry?.[2]?.trim().replace(/^['"]|['"]$/gu, "");
    if (entry && value !== undefined && value !== "") bundleIds[entry[1]!] = value;
  }
  return {
    read: true,
    bundleIds,
    ...(company !== undefined && company !== UNITY_DEFAULT_COMPANY ? { companyName: company } : {}),
    ...(scalar("productName") !== undefined ? { productName: scalar("productName")! } : {}),
    ...(orientationOf(orientationCode === undefined ? undefined : Number(orientationCode)) !== undefined
      ? { orientation: orientationOf(Number(orientationCode))! }
      : {}),
  };
}

/**
 * The orientation a document ASKS FOR, or nothing.
 *
 * Only an unambiguous statement counts: a document that names both
 * orientations is describing something this reader cannot settle, and a guess
 * would refuse a delivery over prose.
 */
export function specOrientation(gddText: string | undefined): ScreenOrientation | undefined {
  if (gddText === undefined) return undefined;
  const portrait = /\bportrait\b/iu.test(gddText);
  const landscape = /\blandscape\b/iu.test(gddText);
  if (portrait === landscape) return undefined;
  return portrait ? "portrait" : "landscape";
}

export interface IdentityVerdict {
  /** What a person is told, measured or not. */
  readonly lines: string[];
  /** Set only when the delivery must not go out as it is. */
  readonly refusal?: string;
}

/**
 * The identity against the document.
 *
 * A refusal needs a STATED expectation or a platform that cannot ship without
 * the field:
 *  - a handheld game with no company name or no application identifier cannot
 *    be installed or submitted, whatever the document says about either;
 *  - an orientation the document states and the project contradicts is the
 *    document being overruled silently.
 * Everything else is disclosed: a field the document never mentions is an
 * assumption a person may want to change, not a defect.
 */
export function identityAnswersSpec(
  identity: ProjectIdentity,
  gddText: string | undefined,
  handheld: boolean,
): IdentityVerdict {
  if (!identity.read) {
    return { lines: [`NOT measured: app identity — ${identity.why ?? `${PROJECT_SETTINGS_PATH} was not read`}`] };
  }
  const lines: string[] = [];
  const missing: string[] = [];
  if (identity.companyName === undefined) missing.push("companyName (empty or still DefaultCompany)");
  if (Object.keys(identity.bundleIds).length === 0) missing.push("applicationIdentifier (no platform has one)");
  lines.push(
    `App identity: company ${identity.companyName ?? "NOT set"}, product ${identity.productName ?? "NOT set"}, ` +
      `application identifier ${
        Object.keys(identity.bundleIds).length === 0
          ? "NOT set"
          : Object.entries(identity.bundleIds).map(([k, v]) => `${k}=${v}`).join(", ")
      } (${PROJECT_SETTINGS_PATH})`,
  );

  const asked = specOrientation(gddText);
  if (asked === undefined) {
    lines.push(
      `Orientation: ${identity.orientation ?? "not set in the project"}, and the document states none — ` +
        "this is an assumption, not a requirement",
    );
  } else if (identity.orientation === undefined) {
    lines.push(`Orientation: the document asks for ${asked} and the project sets no orientation Unity defines`);
  } else if (identity.orientation !== asked && !(asked === "portrait" && identity.orientation === "auto")) {
    return {
      lines,
      refusal:
        `The document asks for ${asked} and the project is set to ${identity.orientation} ` +
        `(defaultScreenOrientation in ${PROJECT_SETTINGS_PATH}). Set it to what the document asks for, ` +
        "or say in the plan why the document is wrong — do not deliver the other orientation silently.",
    };
  } else {
    lines.push(`Orientation: ${identity.orientation}, as the document asks (${asked})`);
  }

  if (handheld && missing.length > 0) {
    return {
      lines,
      refusal:
        `This is a handheld game and ${missing.join(" and ")} ${missing.length === 1 ? "is" : "are"} unset in ` +
        `${PROJECT_SETTINGS_PATH}. A build without them cannot be installed on a device or submitted to a store, ` +
        "so it is not a delivery. Set them in Project Settings → Player.",
    };
  }
  if (missing.length > 0) {
    lines.push(`App identity: ${missing.join(" and ")} — unset, and this document asks for no handheld platform`);
  }
  return { lines };
}
