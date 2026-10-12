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
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, win32 } from "node:path";
import os from "node:os";
import { globSync, type GlobOptions } from "glob";
import { buildDepsContext, STRADA_AGENT_PREAMBLE, STRADA_STATIC_FRAMEWORK_KNOWLEDGE } from "./strada-knowledge.js";
import { STRADA_API } from "./strada-api-reference.js";
import { STRADA_WORK_DIVISION } from "./strada-work-division.js";
import { STRADA_SEEDS } from "../../learning/seeds/strada-core-seeds.js";
import { CORE_PACKAGE_CONFIG } from "../../intelligence/framework/framework-package-configs.js";
import { CSharpFrameworkExtractor } from "../../intelligence/framework/framework-extractor-csharp.js";
import { StradaCoreExtractor } from "../../intelligence/strada-core-extractor.js";
import { validateDrift } from "../../intelligence/strada-drift-validator.js";
import type { StradaDepsStatus } from "../../config/strada-deps.js";
import { assessFrameworkBypass } from "../autonomy/scene-wiring.js";
import { SystemCreateTool } from "../tools/strada/system-create.js";

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
  /** Namespaces Core's generators give game code: `Game.Modules`. */
  generatedNamespaces: Set<string>;
  /** The folders of Core's module layout, relative to the module: `Scripts/Systems`. */
  moduleFolders: Set<string>;
  /**
   * The IModuleBuilder registrations that ask the container to run member
   * injection (`[Inject]`) after construction; none on a Core that never runs it.
   */
  memberInjecting: Set<string>;
  /**
   * When what a JobSystemBase's jobs record in its EntityCommandBuffer is
   * played back: at the start of the system's next update, or in this one.
   */
  commandBufferPlayback?: "next update" | "same update";
}

/**
 * C# source without comments, string/char literals or preprocessor lines;
 * with `keepStrings`, string literals stay, for the defaults Core writes in them.
 */
function stripCode(src: string, keepStrings = false): string {
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
      const start = i;
      i += verbatim[0].length;
      while (i < src.length && !(src[i] === '"' && src[i + 1] !== '"')) i += src[i] === '"' ? 2 : 1;
      i++;
      out += keepStrings ? src.slice(start, i) : '""';
      continue;
    }
    if (c === '"') {
      const start = i;
      i++;
      while (i < src.length && src[i] !== '"' && src[i] !== "\n") i += src[i] === "\\" ? 2 : 1;
      i++;
      out += keepStrings ? src.slice(start, i) : '""';
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

/**
 * Core's C# files, relative to the checkout and written with "/" on every
 * host: the checks below compare them with "Runtime/" and "Tests/". `walk`
 * lets a test hand glob another platform's filesystem.
 */
function listCoreFiles(root: string, walk: Pick<GlobOptions, "platform" | "fs"> = {}): string[] {
  return globSync(CORE_PACKAGE_CONFIG.fileGlob, { cwd: root, ignore: CORE_PACKAGE_CONFIG.ignoreGlobs, posix: true, ...walk });
}

/** The methods declared directly in the type whose body opens at `open`, with their bodies. */
function* methodsIn(code: string, depth: Int32Array, open: number, close: number): Generator<{ name: string; body: string }> {
  const inner = depth[open]! + 1;
  const header = /\b(\w+)\s*(?:<[^>]*>)?\s*\([^)]*\)[^{;=]*(\{|=>)/g;
  header.lastIndex = open + 1;
  for (let m = header.exec(code); m && m.index < close; m = header.exec(code)) {
    const start = m.index + m[0].length - m[2]!.length;
    if (depth[start] !== inner) continue;
    const block = m[2] === "{";
    let end = start + m[2]!.length;
    while (end < close && !(block ? code[end] === "}" && depth[end] === inner + 1 : code[end] === ";" && depth[end] === inner)) end++;
    yield { name: m[1]!, body: code.slice(start, end) };
  }
}

function readCoreSurface(root: string): CoreSurface {
  const files = listCoreFiles(root);
  const surface: CoreSurface = {
    files,
    namespaces: new Set(),
    types: new Map(),
    extensions: new Map(),
    attributeUses: new Set(),
    external: new Set(),
    generatedNamespaces: new Set(),
    moduleFolders: new Set(),
    memberInjecting: new Set(),
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
    const source = readFileSync(join(root, file), "utf8");
    // The module generator's default, `Namespace = "Game.Modules"`, and its
    // layout table, `new FolderEntry { Path = "Scripts/Systems", … }`. A
    // migration's list of retired folders is not written that way.
    const withStrings = stripCode(source, true);
    for (const m of withStrings.matchAll(/\b\w*[Nn]amespace\s*=\s*"([A-Za-z_][\w.]*)"/g)) surface.generatedNamespaces.add(m[1]!);
    for (const m of withStrings.matchAll(/\bnew\s+FolderEntry\s*\{\s*Path\s*=\s*"([^"]+)"/g)) surface.moduleFolders.add(m[1]!);
    const code = stripCode(source);
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

      // A registration runs [Inject] when its body asks the container to
      // (`RegisterWithMemberInjection`); RegisterModel forwarding to Register does not.
      if (type.bases.has("IModuleBuilder")) {
        for (const method of methodsIn(code, depth, open, close)) {
          if (method.name.startsWith("Register") && /\bRegisterWithMemberInjection\b/u.test(method.body)) surface.memberInjecting.add(method.name);
        }
      }
      // Whether a job system plays its command buffer back before it schedules
      // this update's jobs, which defers what those jobs record to the next one.
      if (m[2] === "JobSystemBase") {
        const update = [...methodsIn(code, depth, open, close)].find((method) => method.name === "OnUpdate")?.body ?? "";
        const playback = update.indexOf(".Playback(");
        const schedule = update.indexOf("OnSchedule(");
        if (playback >= 0 && schedule >= 0) surface.commandBufferPlayback = playback < schedule ? "next update" : "same update";
      }
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
  /** A folder a directory tree puts inside a module, relative to it: `Scripts/Systems`. */
  moduleFolder?: true;
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

/** A namespace and what goes under it: `Strada.Core.*`, `Game.Modules.<name>`. */
const NAMESPACE_SPAN = /^([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*)\.(?:\*|<\w+>)$/u;
const atOrAbove = (names: Iterable<string>, name: string, separator = "."): boolean =>
  [...names].some((n) => n === name || n.startsWith(`${name}${separator}`));

function problemsIn(core: CoreSurface, claim: Claim, owners: readonly string[]): string[] {
  const problems: string[] = [];
  const say = (what: string) => problems.push(`${claim.where}: ${what}  ← ${JSON.stringify(claim.text.trim().slice(0, 140))}`);
  const ownedBy = (name: string) => owners.some((o) => hasMember(core, o, name));

  if (claim.moduleFolder) {
    if (!atOrAbove(core.moduleFolders, claim.text, "/")) say(`Strada.Core's module layout has no ${claim.text}/ folder`);
    return problems;
  }

  const namespace = claim.code ? NAMESPACE_SPAN.exec(claim.text.trim())?.[1] : undefined;
  if (namespace) {
    if (!atOrAbove(core.namespaces, namespace) && !atOrAbove(core.generatedNamespaces, namespace)) {
      say(`namespace ${namespace} is neither declared in Strada.Core nor the one its module generator gives game code`);
    }
    return problems;
  }

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
 * A directory tree's folders inside a module (`Assets/Modules/<Module>/…`),
 * relative to the module, and the notes in parentheses beside its entries.
 */
function treeClaims(where: string, tree: string): Claim[] {
  const claims: Claim[] = [];
  const open: string[] = [];
  for (const line of tree.split("\n")) {
    // "│   ├── Systems/      (SystemBase)": four columns per level, then the
    // entry (several on a line are siblings), then a note.
    const m = /^((?:[│ ] {3})*)([├└]── )?(.*?)\s*(?:\((.*)\))?\s*$/u.exec(line);
    if (!m?.[3]) continue;
    const depth = m[1]!.length / 4 + (m[2] ? 1 : 0);
    for (const entry of m[3].split(/\s{2,}/u)) {
      if (!entry.endsWith("/")) continue;
      open[depth] = entry.slice(0, -1);
      open.length = depth + 1;
      if (open[0] === "Assets" && open[1] === "Modules" && open.length > 3) {
        claims.push({ where, text: open.slice(3).join("/"), code: true, moduleFolder: true });
      }
    }
    if (m[4]) claims.push({ where, text: m[4], code: false });
  }
  return claims;
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
    const body = section.replace(/```[^\n]*\n([\s\S]*?)```/gu, (_m, tree: string) => {
      claims.push(...treeClaims(where, tree));
      return " ";
    });
    const rest = body.replace(/`([^`]+)`/gu, (_m, span: string) => {
      // Paths and file globs (Assets/Modules/, *ModuleConfig, .asmdef) are not
      // APIs; a namespace with a wildcard (`Strada.Core.*`) is.
      if (NAMESPACE_SPAN.test(span) || !/[/*]|^\./u.test(span) || /\(/u.test(span)) spans.push(span);
      return " ";
    });
    for (const span of spans) claims.push({ where, text: span, code: true });
    if (prose) for (const line of rest.split("\n")) if (line.trim()) claims.push({ where, text: line, code: false });
    return { claims, texts: [heading, ...spans] };
  });
}

/** The recommendation in a seed; what follows "not" names the alternatives it rejects. */
const recommended = (description: string): string => description.split(/,?\s+(?:not|instead of)\s+/u)[0]!;

/**
 * A text that says when Core runs `[Inject]` must name the registrations that
 * run it, and no other; on a Core that never runs it, it must say that only
 * newer Core does. "Types registered through IModuleBuilder" named none, and
 * Register, RegisterModel, RegisterFactory and RegisterInstance only construct.
 */
function injectProblems(core: CoreSurface, where: string, text: string): string[] {
  const say = (what: string): string[] => [`${where}: ${what}  ← ${JSON.stringify(text.trim().slice(0, 160))}`];
  if (core.memberInjecting.size === 0) {
    return /\bnewer Core\b/u.test(text) ? [] : say("this Core never runs [Inject], and the text does not say only newer Core does");
  }
  const runs = [...core.memberInjecting].sort().join(", ");
  const named = new Set([...text.matchAll(/\b(Register\w+)/gu)].map((m) => m[1]!));
  if (named.size === 0) return say(`names no registration; Core runs [Inject] only for ${runs}`);
  const wrong = [...named].filter((name) => !core.memberInjecting.has(name));
  return wrong.length > 0 ? say(`${wrong.join(", ")} never run [Inject]; Core runs it only for ${runs}`) : [];
}

/**
 * "a controller per flow, a signal and its handler per action, …": each piece
 * of work must be something Core lets a module register (`RegisterController`,
 * `RegisterSignalHandler`) or a type it provides (`Controller`, `SystemBase`).
 * The words are lowercase prose, which the name checks never read.
 */
function workDivisionProblems(core: CoreSurface, division: string): string[] {
  const pieces = [...division.matchAll(/\ban? (\w+)(?: and its (\w+))? (?:per|for)\b/gu)];
  if (pieces.length === 0) return [`names no "a <piece> per <work>": ${JSON.stringify(division)}`];
  const registrations = new Set([...core.types.values()].flatMap((t) => [...t.members].filter((m) => m.startsWith("Register"))));
  const pascal = (word: string): string => word.charAt(0).toUpperCase() + word.slice(1);
  return pieces.flatMap(([phrase, piece, owned]) => {
    const name = pascal(piece!) + (owned ? pascal(owned) : "");
    const known = [name, `${name}Base`, `I${name}`].some((t) => core.types.has(t)) || registrations.has(`Register${name}`);
    return known ? [] : [`"${phrase}": Strada.Core has no ${name} type and no Register${name}`];
  });
}

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
    // The table the preamble's directory tree is held to.
    expect(core!.moduleFolders.size, "Core declares no `new FolderEntry { Path = … }` module layout").toBeGreaterThan(0);
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

  it.skipIf(!CORE_ROOT)(`what Brain says about when [Inject] runs${SKIPPED}`, () => {
    const lines = (where: string, block: string) =>
      block.split("\n").filter((line) => line.includes("[Inject]")).map((line) => [where, line] as const);
    const locatorAdvice = assessFrameworkBypass("/p", {
      listFiles: () => ["/p/Assets/A.cs"],
      readFile: () => "GameBootstrapper.Services?.TryGet(out _a);\nGameBootstrapper.Services?.TryGet(out _b);",
      exists: () => true,
    }).find((finding) => finding.what.includes("service-locator"))?.instead;
    const texts = [
      ...lines("STRADA_AGENT_PREAMBLE", STRADA_AGENT_PREAMBLE),
      ...lines("STRADA_STATIC_FRAMEWORK_KNOWLEDGE", STRADA_STATIC_FRAMEWORK_KNOWLEDGE),
      ["strada_create_system inject_services", new SystemCreateTool().inputSchema.properties.inject_services.description] as const,
      ["the service-locator advice", locatorAdvice ?? ""] as const,
    ];

    expect(texts.length).toBeGreaterThanOrEqual(4);
    const problems = texts.flatMap(([where, text]) => injectProblems(core!, where, text));
    expect(problems, `says [Inject] runs where Strada.Core does not run it:\n${problems.join("\n")}`).toEqual([]);
  });

  it.skipIf(!CORE_ROOT)(`when the framework block says an EntityCommandBuffer plays back${SKIPPED}`, () => {
    expect(core!.commandBufferPlayback, "JobSystemBase.OnUpdate neither plays back nor schedules").toBeDefined();
    const line = STRADA_STATIC_FRAMEWORK_KNOWLEDGE.split("\n").find((l) => l.includes("`EntityCommandBuffer`")) ?? "";

    // Core plays the buffer back at the start of the system's next update, so a
    // structural change recorded this frame is not visible later in it.
    expect(/\bnext update\b/u.test(line), `Core plays back in the ${core!.commandBufferPlayback}: ${line}`).toBe(
      core!.commandBufferPlayback === "next update",
    );
  });

  it.skipIf(!CORE_ROOT)(`the way the deps context and the FILE TOO LONG gate divide work${SKIPPED}`, () => {
    expect(workDivisionProblems(core!, STRADA_WORK_DIVISION)).toEqual([]);
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

/** A throwaway directory holding `files`, removed after `use`. */
async function withTree(files: Record<string, string>, use: (root: string) => unknown): Promise<void> {
  const root = mkdtempSync(join(os.tmpdir(), "core-tree-"));
  try {
    for (const [path, source] of Object.entries(files)) {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), source);
    }
    await use(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/** A Core small enough to read in a test, with a module generator. */
const SMALL_CORE = {
  "Runtime/Communication/EventBus.cs": [
    "namespace Strada.Core.Communication { public sealed class EventBus {",
    "  public void Publish<T>(T message) { }",
    "  public void RegisterSignalHandler<T>(System.Action<T> handler) { }",
    "} }",
  ].join("\n"),
  "Runtime/Patterns/Controller.cs": "namespace Strada.Core.Patterns { public abstract class Controller { } }",
  "Editor/ModuleGenerator/ModuleDefinition.cs":
    'namespace Strada.Core.Editor.ModuleGenerator { public class ModuleDefinition { public string Namespace = "Game.Modules"; } }',
  "Editor/ModuleGenerator/ModuleLayout.cs": [
    "namespace Strada.Core.Editor.ModuleGenerator {",
    "  public class FolderEntry { public string Path; }",
    "  public static class ModuleLayout {",
    '    public static FolderEntry[] DefaultEntries() => new[] { new FolderEntry { Path = "Scripts" }, new FolderEntry { Path = "Scripts/Systems" }, new FolderEntry { Path = "Tests/Runtime" } };',
    "  }",
    "}",
  ].join("\n"),
  "Runtime/ECS/Systems/SystemBase.cs": "namespace Strada.Core.ECS.Systems { public abstract class SystemBase { } }",
  "Runtime/ECS/Systems/JobSystemBase.cs": [
    "namespace Strada.Core.ECS.Systems {",
    "  public abstract class JobSystemBase : SystemBase {",
    "    protected sealed override void OnUpdate(float deltaTime)",
    "    {",
    "      _lastJobHandle.Complete();",
    "      if (_commandBufferCreated) { _commandBuffer.Playback(EntityManager); }",
    "      _lastJobHandle = OnSchedule(deltaTime, _lastJobHandle);",
    "    }",
    "    protected abstract JobHandle OnSchedule(float deltaTime, JobHandle dependency);",
    "  }",
    "}",
  ].join("\n"),
  "Runtime/Modules/ModuleBuilder.cs": [
    "namespace Strada.Core.Modules {",
    "  public interface IModuleBuilder { }",
    "  public sealed class ModuleBuilder : IModuleBuilder {",
    "    public IModuleBuilder Register<TInterface, TImplementation>(Lifetime lifetime) where TImplementation : class { return this; }",
    "    public IModuleBuilder RegisterModel<TInterface, TImplementation>() { return Register<TInterface, TImplementation>(Lifetime.Singleton); }",
    "    public IModuleBuilder RegisterController<T>() where T : class",
    "    {",
    "      _builder.RegisterWithMemberInjection(typeof(T), typeof(T), Lifetime.Singleton);",
    "      return this;",
    "    }",
    "  }",
    "}",
  ].join("\n"),
};

/** The same Core before it ran member injection at all. */
const SMALL_CORE_WITHOUT_INJECTION = {
  ...SMALL_CORE,
  "Runtime/Modules/ModuleBuilder.cs": SMALL_CORE["Runtime/Modules/ModuleBuilder.cs"].replace(
    "_builder.RegisterWithMemberInjection(typeof(T), typeof(T), Lifetime.Singleton);",
    "_builder.Register(typeof(T), typeof(T), Lifetime.Singleton);",
  ),
};

/** What the checks report for a prompt block read against `core`. */
function problemsOf(core: CoreSurface, block: string): string[] {
  return sectionClaims("block", block, false).flatMap(({ claims, texts }) =>
    claims.flatMap((claim) => problemsIn(core, claim, ownersIn(core, texts))),
  );
}

describe("what the checks read in a prompt block", () => {
  it("holds a namespace with a wildcard to the namespaces Core declares", async () => {
    await withTree(SMALL_CORE, (root) => {
      const core = readCoreSurface(root);

      expect(problemsOf(core, "- Namespace: `Strada.Core.*` for framework")).toEqual([]);
      // The measured defect: workers were told to put game code in a
      // namespace nobody uses, and a span with a "*" was skipped as a glob.
      expect(problemsOf(core, "- Namespace: `Strada.Core.*` for framework, `YourGame.*` for game code")).toEqual([
        expect.stringContaining("namespace YourGame is neither declared"),
      ]);
      expect(problemsOf(core, "- `Strada.Kernel.*`")).toEqual([expect.stringContaining("namespace Strada.Kernel is neither declared")]);
    });
  });

  it("accepts the namespace Core's module generator gives game code, and no other", async () => {
    await withTree(SMALL_CORE, (root) => {
      const core = readCoreSurface(root);

      expect(problemsOf(core, "- game code: `Game.Modules.<name>`")).toEqual([]);
      expect(problemsOf(core, "- game code: `Studio.Modules.<name>`")).toEqual([
        expect.stringContaining("namespace Studio.Modules is neither declared"),
      ]);
    });
  });

  it("holds a module tree's folders to Core's module layout and its notes to Core's types", async () => {
    await withTree(SMALL_CORE, (root) => {
      const core = readCoreSurface(root);
      const tree = (...module: string[]) =>
        ["### Layout", "```", "Assets/", "└── Modules/", "    └── CombatModule/", ...module, "```"].join("\n");

      expect(problemsOf(core, tree(
        "        ├── Scripts/",
        "        │   └── Systems/",
        "        │       └── DamageSystem.cs        (SystemBase)",
        "        └── Tests/                         (own assemblies)",
        "            └── Runtime/",
      ))).toEqual([]);
      // The tree taught a Commands/ folder, which Core's layout has dropped,
      // and a fenced block was skipped whole.
      expect(problemsOf(core, tree(
        "        └── Scripts/",
        "            ├── Commands/",
        "            └── Systems/                   (SystemTicker)",
      ))).toEqual([
        expect.stringContaining("module layout has no Scripts/Commands/ folder"),
        expect.stringContaining("SystemTicker is not a Strada.Core type"),
      ]);
    });
  });

  it("holds each piece of a work division to what Core lets a module register", async () => {
    await withTree(SMALL_CORE, (root) => {
      const core = readCoreSurface(root);

      expect(workDivisionProblems(core, "a controller per flow, a signal and its handler per action, a system for per-frame work")).toEqual([]);
      // The deps context and the FILE TOO LONG gate both taught this, and
      // neither text was read by any check.
      expect(workDivisionProblems(core, "a command per action, a system for per-frame work")).toEqual([
        expect.stringContaining("Strada.Core has no Command type and no RegisterCommand"),
      ]);
    });
  });

  it("holds what a text says about [Inject] to the registrations whose body runs it", async () => {
    await withTree(SMALL_CORE, (root) => {
      const core = readCoreSurface(root);

      expect([...core.memberInjecting]).toEqual(["RegisterController"]);
      expect(injectProblems(core, "t", "`[Inject]` runs only in newer Core builds, for `RegisterController<T>()`")).toEqual([]);
      // What the prompt said: every IModuleBuilder registration, which names none.
      expect(injectProblems(core, "t", "`[Inject]` runs only in newer Core builds, for types registered through `IModuleBuilder`")).toEqual([
        expect.stringContaining("names no registration; Core runs [Inject] only for RegisterController"),
      ]);
      expect(injectProblems(core, "t", "`[Inject]` runs for `RegisterController<T>()` and `RegisterModel<TInterface, TImpl>()`")).toEqual([
        expect.stringContaining("RegisterModel never run [Inject]"),
      ]);
    });
    await withTree(SMALL_CORE_WITHOUT_INJECTION, (root) => {
      const core = readCoreSurface(root);

      expect([...core.memberInjecting]).toEqual([]);
      expect(injectProblems(core, "t", "`[Inject]` runs only in newer Core builds, for `RegisterController<T>()`")).toEqual([]);
      expect(injectProblems(core, "t", "`[Inject]` runs for `RegisterController<T>()`")).toEqual([
        expect.stringContaining("this Core never runs [Inject]"),
      ]);
    });
  });

  it("reads when a job system plays back its command buffer from the order of its update", async () => {
    await withTree(SMALL_CORE, (root) => {
      // Playback, then this update's jobs: what they record waits a frame.
      expect(readCoreSurface(root).commandBufferPlayback).toBe("next update");
    });
    const scheduleFirst = SMALL_CORE["Runtime/ECS/Systems/JobSystemBase.cs"].replace(
      "      if (_commandBufferCreated) { _commandBuffer.Playback(EntityManager); }\n      _lastJobHandle = OnSchedule(deltaTime, _lastJobHandle);",
      "      _lastJobHandle = OnSchedule(deltaTime, _lastJobHandle);\n      _lastJobHandle.Complete(); _commandBuffer.Playback(EntityManager);",
    );
    await withTree({ ...SMALL_CORE, "Runtime/ECS/Systems/JobSystemBase.cs": scheduleFirst }, (root) => {
      expect(readCoreSurface(root).commandBufferPlayback).toBe("same update");
    });
  });
});

describe("the work division the deps context and the FILE TOO LONG gate teach", () => {
  it("is the one copy, in the deps context's item 7", () => {
    const deps: StradaDepsStatus = {
      coreInstalled: true, corePath: "/core", modulesInstalled: false, modulesPath: null,
      mcpInstalled: true, mcpPath: "/mcp", mcpVersion: null, warnings: [],
    };
    const item7 = buildDepsContext(deps).split("\n").find((line) => line.startsWith("7. "));

    expect(item7).toContain(STRADA_WORK_DIVISION);
  });
});

/** Core's API beside its test suites and its root build tooling. */
const API_AND_TOOLING = {
  "Runtime/Bus/Relay.cs": "namespace Strada.Core.Bus { public sealed class Relay { } }",
  "Editor/Tools/LayoutTool.cs": "namespace Strada.Core.Editor { public class LayoutTool { } }",
  "Tests/Runtime/RelayTests.cs": "namespace Strada.Core.Tests { public class RelayTests { } }",
  "Tools/bench~/Fixtures.cs": "namespace Bench { public sealed class T1 { } public sealed class ForeignContainer { } }",
};

describe("the Core checkout's file list", () => {
  // windows-test clones Core and sets STRADA_CORE_PATH, so the checks above
  // run there too, and glob answers with the host's separator: every
  // "Runtime/" and "Tests/" test would judge `Runtime\…` paths.
  it("is written with / on Windows too, where glob answers with \\", async () => {
    await withTree(API_AND_TOOLING, (root) => {
      // A win32 walk whose C:\core is this directory.
      const drive = "C:\\core";
      const onDisk = (p: string): string => join(root, ...win32.relative(drive, p).split(win32.sep));
      const fs = {
        lstatSync: (p: string) => lstatSync(onDisk(p)),
        readdirSync: (p: string, options: { withFileTypes: true }) => readdirSync(onDisk(p), options),
        readlinkSync: (p: string) => readlinkSync(onDisk(p)),
        realpathSync: (p: string) => p,
      };

      expect(listCoreFiles(drive, { platform: "win32", fs }).sort()).toEqual(["Editor/Tools/LayoutTool.cs", "Runtime/Bus/Relay.cs"]);
    });
  });
});

describe("the Core extractor reads Core's API only", () => {
  it("skips the root Tests/ and Tools/ trees and keeps an Editor/Tools folder", async () => {
    await withTree(API_AND_TOOLING, async (root) => {
      const snapshot = await new CSharpFrameworkExtractor(root, CORE_PACKAGE_CONFIG).extract();

      expect(snapshot.classes.map((c) => c.name).sort()).toEqual(["LayoutTool", "Relay"]);
    });
  });
});
