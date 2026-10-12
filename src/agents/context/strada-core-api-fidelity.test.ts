/**
 * Every Strada.Core API Brain teaches must exist in Strada.Core.
 *
 * The static framework block, the learning seeds and STRADA_API were typed by
 * hand and drifted from the framework: they taught an `EntityQuery` builder with
 * `WithAll/WithAny/WithNone`, a bus `Register<T>()`, "Strada.Core MediatR" and
 * UniTask, none of which Core has, and workers wrote calls against them. Only
 * type names were ever compared, so nothing noticed.
 *
 * This reads the real Core source (the files the framework extractor reads) and
 * holds every identifier those texts name to it:
 * - a namespace must be declared, an attribute must be a declared `…Attribute`;
 * - a call must be a member of the type it is qualified with, or, unqualified,
 *   of a type the same section (or STRADA_API group) names;
 * - any other name must be a Core type, a member of a type the passage names, or
 *   a BCL/Unity name Core's code uses without declaring (`ValueTask`,
 *   `MonoBehaviour`).
 * Existence, not signatures: an overload Core dropped still passes by name.
 *
 * The checkout comes from STRADA_CORE_PATH (CI clones Core there), else a
 * sibling `../Strada.Core`, else /tmp/Strada.Core-ci. Without one the checks
 * skip and say so in their names.
 */

import { describe, it, expect } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import os from "node:os";
import { globSync } from "glob";
import { STRADA_AGENT_PREAMBLE, STRADA_STATIC_FRAMEWORK_KNOWLEDGE } from "./strada-knowledge.js";
import { STRADA_API } from "./strada-api-reference.js";
import { STRADA_SEEDS } from "../../learning/seeds/strada-core-seeds.js";
import { CORE_PACKAGE_CONFIG } from "../../intelligence/framework/framework-package-configs.js";
import { CSharpFrameworkExtractor } from "../../intelligence/framework/framework-extractor-csharp.js";
import { StradaCoreExtractor } from "../../intelligence/strada-core-extractor.js";
import { validateDrift } from "../../intelligence/strada-drift-validator.js";

const CORE_PATH_FROM_ENV = process.env["STRADA_CORE_PATH"]?.trim() || undefined;
const CORE_ROOT =
  CORE_PATH_FROM_ENV ??
  [join(process.cwd(), "..", "Strada.Core"), "/tmp/Strada.Core-ci"].find((p) => existsSync(join(p, "Runtime")));
const SKIPPED = CORE_ROOT
  ? ""
  : " (skipped: no Strada.Core checkout; set STRADA_CORE_PATH, as CI does for /tmp/Strada.Core-ci)";

// ─── Core's declared surface ─────────────────────────────────────────────────

interface TypeSurface {
  members: Set<string>;
  bases: Set<string>;
}

interface CoreSurface {
  /** The files read, relative to the checkout. */
  files: string[];
  namespaces: Set<string>;
  types: Map<string, TypeSurface>;
  /** Extension methods by the simple name of the type they extend. */
  extensions: Map<string, Set<string>>;
  /** Names Core's code applies as attributes (Core's own and BCL/Unity ones). */
  attributeUses: Set<string>;
  /**
   * Identifiers Core's code uses but never declares: the BCL and Unity names it
   * builds on (`ValueTask`, `MonoBehaviour`, `LayoutKind`). A name Core declares
   * is held to where it is declared instead.
   */
  external: Set<string>;
}

/** C# source without comments, string/char literals or preprocessor lines. */
function stripCode(src: string): string {
  let out = "";
  let i = 0;
  let lineStart = true;
  while (i < src.length) {
    const c = src[i]!;
    const next = src[i + 1];
    if (c === "/" && next === "/") {
      while (i < src.length && src[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && next === "*") {
      const end = src.indexOf("*/", i + 2);
      i = end < 0 ? src.length : end + 2;
      out += " ";
      continue;
    }
    if (c === "#" && lineStart) {
      while (i < src.length && src[i] !== "\n") i++;
      continue;
    }
    const verbatim = /^(?:@\$?|\$@)"/.exec(src.slice(i, i + 3));
    if (verbatim) {
      i += verbatim[0].length;
      while (i < src.length && !(src[i] === '"' && src[i + 1] !== '"')) i += src[i] === '"' ? 2 : 1;
      i++;
      out += '""';
      continue;
    }
    if (c === '"') {
      i++;
      while (i < src.length && src[i] !== '"' && src[i] !== "\n") i += src[i] === "\\" ? 2 : 1;
      i++;
      out += '""';
      continue;
    }
    if (c === "'") {
      const literal = /^'(?:\\[^']+|[^'\\\n])'/.exec(src.slice(i, i + 12));
      if (literal) {
        i += literal[0].length;
        out += "' '";
        continue;
      }
    }
    if (c === "\n") lineStart = true;
    else if (c !== " " && c !== "\t" && c !== "\r") lineStart = false;
    out += c;
    i++;
  }
  return out;
}

/** Generic argument list, nested up to three levels deep. */
const GENERIC = String.raw`<(?:[^<>{};]|<(?:[^<>{};]|<[^<>{};]*>)*>)*>`;
/** Words that sit before a declared member's name only as modifiers. */
const MODIFIERS = new Set(
  "public protected internal private static readonly override virtual abstract sealed async extern unsafe event const partial volatile".split(" "),
);
const KEYWORDS = new Set(
  ("as base break case catch checked class continue default delegate do else enum explicit finally fixed for foreach goto " +
    "if implicit in interface is lock namespace new operator out params ref return sizeof stackalloc struct switch throw try " +
    "typeof unchecked using while yield await var when where nameof get set init add remove value record").split(" "),
);
const simpleName = (type: string): string => type.trim().replace(/<.*$/su, "").replace(/\?$/u, "").split(".").pop()!.trim();

function readCoreSurface(root: string): CoreSurface {
  const files = globSync(CORE_PACKAGE_CONFIG.fileGlob, { cwd: root, ignore: CORE_PACKAGE_CONFIG.ignoreGlobs });
  const surface: CoreSurface = {
    files,
    namespaces: new Set(),
    types: new Map(),
    extensions: new Map(),
    attributeUses: new Set(),
    external: new Set(),
  };
  const words = new Set<string>();
  const typeRe = new RegExp(
    String.raw`\b(class|struct|interface|enum|record)\s+(\w+)\s*(?:${GENERIC})?\s*(?:\([^)]*\))?\s*(?::\s*([^{;]*?))?\s*(?:where\b[^{;]*)?\{`,
    "g",
  );
  const memberRe = new RegExp(String.raw`(\w+|${GENERIC}|[\]?])\s+(\w+)\s*(?:${GENERIC})?\s*(?:\(|\{|=>|=|;)`, "g");
  const extensionRe = new RegExp(
    String.raw`\bstatic\s+[^;{}()=]*?\s(\w+)\s*(?:${GENERIC})?\s*\(\s*this\s+(?:ref\s+|in\s+)?([\w.]+)`,
    "g",
  );
  const delegateRe = new RegExp(String.raw`\bdelegate\s+[\w<>\[\],.?\s]+?\s(\w+)\s*(?:${GENERIC})?\s*\(`, "g");

  for (const file of files) {
    const code = stripCode(readFileSync(join(root, file), "utf8"));
    for (const m of code.matchAll(/\b[A-Za-z_]\w*\b/g)) words.add(m[0]);
    for (const m of code.matchAll(/\bnamespace\s+([\w.]+)/g)) surface.namespaces.add(m[1]!);
    for (const m of code.matchAll(/\[\s*(?:\w+\s*:\s*)?([A-Z]\w*)\s*[\](,]/g)) surface.attributeUses.add(m[1]!);

    const depth = new Int32Array(code.length + 1);
    for (let i = 0, d = 0; i < code.length; i++) {
      depth[i] = d;
      if (code[i] === "{") d++;
      else if (code[i] === "}") d--;
    }

    for (const m of code.matchAll(typeRe)) {
      const kind = m[1]!;
      const open = m.index! + m[0].length - 1;
      const inner = depth[open]! + 1;
      let close = open + 1;
      while (close < code.length && !(code[close] === "}" && depth[close] === inner)) close++;
      const body = code.slice(open + 1, close);
      const type = surface.types.get(m[2]!) ?? { members: new Set<string>(), bases: new Set<string>() };
      surface.types.set(m[2]!, type);
      for (const base of (m[3] ?? "").split(/,(?![^<]*>)/u)) if (base.trim()) type.bases.add(simpleName(base));

      if (kind === "enum") {
        for (const entry of body.replace(/\[[^\]]*\]/gu, " ").split(",")) {
          const id = /^\s*(\w+)/u.exec(entry)?.[1];
          if (id) type.members.add(id);
        }
        continue;
      }
      for (const mm of body.matchAll(memberRe)) {
        // Only declarations directly in this type's body; method bodies are deeper.
        if (depth[open + 1 + mm.index! + mm[0].length - 1] !== inner) continue;
        const before = mm[1]!;
        if (/^\w+$/u.test(before) && KEYWORDS.has(before)) continue;
        if (KEYWORDS.has(mm[2]!) || MODIFIERS.has(mm[2]!)) continue;
        type.members.add(mm[2]!);
      }
      for (const nested of body.matchAll(/\b(?:class|struct|interface|enum|record)\s+(\w+)/g)) type.members.add(nested[1]!);
    }
    for (const m of code.matchAll(delegateRe)) {
      if (!surface.types.has(m[1]!)) surface.types.set(m[1]!, { members: new Set(), bases: new Set() });
    }
    for (const m of code.matchAll(extensionRe)) {
      const target = simpleName(m[2]!);
      const names = surface.extensions.get(target) ?? new Set<string>();
      names.add(m[1]!);
      surface.extensions.set(target, names);
    }
  }
  const declared = new Set<string>([...surface.types.keys(), ...[...surface.namespaces].flatMap((n) => n.split("."))]);
  for (const type of surface.types.values()) for (const member of type.members) declared.add(member);
  for (const names of surface.extensions.values()) for (const name of names) declared.add(name);
  for (const word of words) if (!declared.has(word)) surface.external.add(word);
  return surface;
}

function hasMember(core: CoreSurface, typeName: string, member: string, seen = new Set<string>()): boolean {
  const name = simpleName(typeName);
  if (seen.has(name)) return false;
  seen.add(name);
  if (core.extensions.get(name)?.has(member)) return true;
  const type = core.types.get(name);
  if (!type) return false;
  if (type.members.has(member)) return true;
  for (const base of type.bases) if (hasMember(core, base, member, seen)) return true;
  return false;
}

// ─── What the texts claim ────────────────────────────────────────────────────

/** `builder` is the IModuleBuilder that ModuleConfig.Configure receives. */
const RECEIVERS: Record<string, string> = { builder: "IModuleBuilder" };
/** A type parameter (T, T1, TModel, TEvent …) stands for the caller's type. */
const isTypeParameter = (name: string): boolean => /^T(?:\d+|[A-Z]\w*)?$/u.test(name);

interface Claim {
  /** Where the text came from, for the failure message. */
  where: string;
  text: string;
  /** Code (a backtick span, a STRADA_API value) or prose around it. */
  code: boolean;
}

/** Core types a passage names: the owners its unqualified calls must belong to. */
function ownersIn(core: CoreSurface, texts: readonly string[]): string[] {
  const owners = new Set<string>();
  for (const text of texts) {
    for (const m of text.matchAll(/\b[A-Z]\w*\b/g)) if (core.types.has(m[0]) && !isTypeParameter(m[0])) owners.add(m[0]);
  }
  return [...owners];
}

/** Prose names a type only in code shape: `EventBus`, `MediatR`, `IServiceLocator`, not "Every" or "IDs". */
const isCodeShaped = (name: string): boolean => /^[A-Z][a-z0-9]+[A-Z]/u.test(name) || /^I[A-Z][a-z]\w+$/u.test(name);

function problemsIn(core: CoreSurface, claim: Claim, owners: readonly string[]): string[] {
  const problems: string[] = [];
  const say = (what: string) => problems.push(`${claim.where}: ${what}  ← ${JSON.stringify(claim.text.trim().slice(0, 140))}`);
  const ownedBy = (name: string) => owners.some((o) => hasMember(core, o, name));
  // typeof(X) names the caller's own type.
  let text = claim.text.replace(/typeof\([^)]*\)/gu, "typeof()");

  text = text.replace(/\bStrada(?:\.\w+)+(\.\*)?/gu, (ns, wildcard: string | undefined) => {
    const name = wildcard ? ns.slice(0, -2) : ns;
    const declared = wildcard
      ? [...core.namespaces].some((n) => n === name || n.startsWith(`${name}.`))
      : core.namespaces.has(name);
    if (!declared && name !== "Strada.Core") say(`namespace ${name} is not declared in Strada.Core`);
    return " ";
  });

  text = text.replace(/\[([A-Z]\w*)(?=\s*[\](])/gu, (_m, name: string) => {
    const declared = core.types.has(name.endsWith("Attribute") ? name : `${name}Attribute`);
    if (!declared && !core.attributeUses.has(name)) say(`[${name}] is not an attribute Strada.Core declares or uses`);
    return "[ ";
  });

  // A call is written against its name with no space: "Configure(", "Send<T>(".
  const callRe = new RegExp(String.raw`(?:\b([A-Za-z_]\w*)\.)?\b([A-Z]\w*)(${GENERIC})?\(`, "gu");
  text = text.replace(callRe, (_m, qualifier: string | undefined, name: string, generic: string | undefined) => {
    if (name.length === 1) return " "; // O(1)
    const owner = qualifier && /^[A-Z]/u.test(qualifier) ? qualifier : qualifier ? RECEIVERS[qualifier] : undefined;
    if (owner) {
      if (!core.types.has(simpleName(owner))) say(`${owner} is not a Strada.Core type (called as ${owner}.${name})`);
      else if (!hasMember(core, owner, name)) say(`${owner}.${name} does not exist in Strada.Core`);
    } else if (!core.types.has(name) && !ownedBy(name)) {
      say(owners.length > 0
        ? `${name}() is not a member of ${owners.join(", ")}`
        : `${name}() is called but the passage names no Strada.Core type it belongs to`);
    }
    return ` ${generic ?? ""}(`;
  });

  text = text.replace(/\b([A-Z]\w*)\.([A-Za-z_]\w*)\b/gu, (whole, type: string, member: string) => {
    if (core.types.has(type)) {
      if (!hasMember(core, type, member)) say(`${type}.${member} does not exist in Strada.Core`);
    } else if (isCodeShaped(type) && !(core.external.has(type) && core.external.has(member))) {
      say(`${whole} is neither Strada.Core's nor a BCL/Unity name Core uses`);
    }
    return " ";
  });

  for (const m of text.matchAll(/(?<![.\w-])([A-Z]\w*)\b/gu)) {
    const name = m[1]!;
    if (isTypeParameter(name) || (!claim.code && !isCodeShaped(name))) continue;
    if (core.types.has(name) || ownedBy(name) || core.external.has(name)) continue;
    say(owners.length > 0
      ? `${name} is not a Strada.Core type, not a member of ${owners.join(", ")}, and not a BCL/Unity name Core uses`
      : `${name} is not a Strada.Core type nor a BCL/Unity name Core uses`);
  }
  return problems;
}

/**
 * Split a prompt block into `##`/`###` sections, each with its code spans and,
 * where the block describes the API itself, its prose.
 */
function sectionClaims(source: string, block: string, prose: boolean): Array<{ claims: Claim[]; texts: string[] }> {
  return block.split(/^(?=#{2,3} )/mu).map((section) => {
    const heading = /^#{2,3} (.*)$/mu.exec(section)?.[1] ?? "(preamble)";
    const where = `${source} § ${heading}`;
    const claims: Claim[] = [];
    const spans: string[] = [];
    // A fenced block in these prompts is a directory tree, not code.
    const body = section.replace(/```[\s\S]*?```/gu, " ");
    const rest = body.replace(/`([^`]+)`/gu, (_m, span: string) => {
      // Paths and file globs (Assets/Modules/, *ModuleConfig, .asmdef) are not APIs.
      if (!/[/*]|^\./u.test(span) || /\(/u.test(span)) spans.push(span);
      return " ";
    });
    for (const span of spans) claims.push({ where, text: span, code: true });
    if (prose) for (const line of rest.split("\n")) if (line.trim()) claims.push({ where, text: line, code: false });
    return { claims, texts: [heading, ...spans] };
  });
}

/** The recommendation in a seed; what follows "not" names the alternatives it rejects. */
const recommended = (description: string): string => description.split(/,?\s+(?:not|instead of)\s+/u)[0]!;

/** Groups whose values name members without naming the type that declares them. */
const API_GROUP_OWNERS: Partial<Record<keyof typeof STRADA_API, string[]>> = {
  systemApi: ["SystemBase"],
  updatePhases: ["UpdatePhase"],
};

function leafStrings(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(leafStrings);
  if (value && typeof value === "object") return Object.values(value).flatMap(leafStrings);
  return [];
}

// ─── The checks ──────────────────────────────────────────────────────────────

describe("Brain's Strada.Core knowledge names only APIs Strada.Core has", () => {
  const core = CORE_ROOT ? readCoreSurface(CORE_ROOT) : undefined;

  it.skipIf(!CORE_ROOT)(`reads the Core checkout's API, not its test suites or build tools${SKIPPED}`, () => {
    expect(existsSync(join(CORE_ROOT!, "Runtime")), `${CORE_ROOT} is not a Strada.Core checkout`).toBe(true);
    expect(core!.files.some((f) => f.startsWith("Runtime/"))).toBe(true);
    expect(core!.types.has("EventBus")).toBe(true);
    // Tools/ holds benchmark fixtures named T0..T4 and adapters for other DI
    // containers; read as Core, they made type parameters and foreign APIs "exist".
    expect(core!.files.filter((f) => /^(?:Tests|Tools)\//u.test(f))).toEqual([]);
  });

  it.skipIf(!CORE_ROOT)(`the static framework block and the code conventions${SKIPPED}`, () => {
    const problems: string[] = [];
    // The framework block describes the API, so its prose is held to Core too;
    // the preamble's prose is conduct, only its code spans name APIs.
    for (const [source, block, prose] of [
      ["STRADA_STATIC_FRAMEWORK_KNOWLEDGE", STRADA_STATIC_FRAMEWORK_KNOWLEDGE, true],
      ["STRADA_AGENT_PREAMBLE", STRADA_AGENT_PREAMBLE, false],
    ] as const) {
      for (const { claims, texts } of sectionClaims(source, block, prose)) {
        const owners = ownersIn(core!, texts);
        for (const claim of claims) problems.push(...problemsIn(core!, claim, owners));
      }
    }
    expect(problems, `names Strada.Core does not have:\n${problems.join("\n")}`).toEqual([]);
  });

  it.skipIf(!CORE_ROOT)(`the learning seeds${SKIPPED}`, () => {
    const problems = STRADA_SEEDS.flatMap((seed) => {
      const text = recommended(seed.action.description);
      return problemsIn(core!, { where: `seed ${seed.pattern}`, text, code: false }, ownersIn(core!, [text]));
    });
    expect(problems, `names Strada.Core does not have:\n${problems.join("\n")}`).toEqual([]);
  });

  it.skipIf(!CORE_ROOT)(`the STRADA_API reference${SKIPPED}`, () => {
    const problems: string[] = [];
    const asmdef = JSON.parse(readFileSync(join(CORE_ROOT!, "Runtime", "Strada.Core.asmdef"), "utf8")) as {
      name: string;
      references: string[];
    };
    for (const [group, value] of Object.entries(STRADA_API) as Array<[keyof typeof STRADA_API, unknown]>) {
      const leaves = leafStrings(value);
      const where = `STRADA_API.${group}`;
      if (group === "namespaces") {
        for (const ns of leaves) if (!core!.namespaces.has(ns)) problems.push(`${where}: namespace ${ns} is not declared`);
        continue;
      }
      if (group === "assemblyReferences") {
        const known = new Set([asmdef.name, ...asmdef.references]);
        for (const name of leaves) if (!known.has(name)) problems.push(`${where}: ${name} is not Strada.Core's assembly or a reference of it`);
        continue;
      }
      const owners = [...(API_GROUP_OWNERS[group] ?? []), ...ownersIn(core!, leaves)];
      for (const leaf of leaves) problems.push(...problemsIn(core!, { where, text: leaf, code: true }, owners));
    }
    expect(problems, `names Strada.Core does not have:\n${problems.join("\n")}`).toEqual([]);
  });

  // `npm run sync:check` against the same checkout: Brain's reference against
  // what the extractor reads. It scored 100/100 with nine false "attribute
  // removed" warnings against a Core that declares every one of them.
  it.skipIf(!CORE_ROOT)(`sync:check finds no drift between STRADA_API and the checkout${SKIPPED}`, async () => {
    const report = validateDrift(await new StradaCoreExtractor(CORE_ROOT!).extract());

    expect([...report.errors, ...report.warnings].map((i) => i.message)).toEqual([]);
    expect(report.driftScore).toBe(0);
  });
});

describe("the Core extractor reads Core's API only", () => {
  it("skips the root Tests/ and Tools/ trees and keeps an Editor/Tools folder", async () => {
    const root = mkdtempSync(join(os.tmpdir(), "core-extract-"));
    const write = (path: string, source: string) => {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), source);
    };
    try {
      write("Runtime/Bus/Relay.cs", "namespace Strada.Core.Bus { public sealed class Relay { } }");
      write("Editor/Tools/LayoutTool.cs", "namespace Strada.Core.Editor { public class LayoutTool { } }");
      write("Tests/Runtime/RelayTests.cs", "namespace Strada.Core.Tests { public class RelayTests { } }");
      write("Tools/bench~/Fixtures.cs", "namespace Bench { public sealed class T1 { } public sealed class ForeignContainer { } }");

      const snapshot = await new CSharpFrameworkExtractor(root, CORE_PACKAGE_CONFIG).extract();

      expect(snapshot.classes.map((c) => c.name).sort()).toEqual(["LayoutTool", "Relay"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
