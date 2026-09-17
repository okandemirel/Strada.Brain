/**
 * SessionManager — encapsulates all session lifecycle, visible-transcript,
 * and persistence logic previously spread across orchestrator.ts and
 * orchestrator-session-persistence.ts.
 *
 * Pure refactor: every method is copied verbatim from its source, with only
 * `ctx.X` → `this.X` / `this.deps.X` adaptations.
 */

import type { ConversationMessage } from "./providers/provider.interface.js";
import type {
  MessageContent,
  AssistantMessage,
} from "./providers/provider-core.interface.js";
import type { IMemoryManager } from "../memory/memory.interface.js";
import type { ChatId } from "../types/index.js";
import type { GoalTree } from "../goals/types.js";
import type { IEmbeddingProvider, IRAGPipeline } from "../rag/rag.interface.js";
import type { InstinctRetriever } from "./instinct-retriever.js";
import type { ReRetrievalConfig } from "../config/config.js";
import { stripInternalDecisionMarkers } from "./orchestrator-supervisor-routing.js";
import type { IEventEmitter, LearningEventMap } from "../core/event-bus.js";
import type { ExecutionJournal } from "./autonomy/index.js";
import type { TaskExecutionStore } from "../memory/unified/task-execution-store.js";
import type { SessionSummarizer } from "../memory/unified/session-summarizer.js";
import type { InteractionGateState } from "./autonomy/interaction-policy.js";
import type { InteractionBoundaryDecision } from "./autonomy/visibility-boundary.js";
import { writeFile, mkdir } from "node:fs/promises";
import { existsSync, readFileSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { MemoryRefresher } from "./memory-refresher.js";
import {
  redactSensitiveText,
  stripVisibleProviderArtifacts,
} from "./orchestrator-text-utils.js";
import { capRollingSummary, MAX_ROLLING_SUMMARY_CHARS } from "./session-compaction.js";
import { getLogger } from "../utils/logger.js";

// ─── Constants ────────────────────────────────────────────────────────────────

const MAX_SESSIONS = 100;

// ─── Types ────────────────────────────────────────────────────────────────────

// A "low-signal" model draft after a self-managed write rejection = a bare ack (done/ok/…) that
// produced no safer replacement; the run must then surface the rejection reason, not the ack.
const LOW_SIGNAL_EXECUTION_ACK_RE =
  /^(?:adjusted|done|ok(?:ay)?|noted|ack(?:nowledged)?|revised|updated|handled|understood|fixed)\.?$/iu;

export interface Session {
  messages: ConversationMessage[];
  visibleMessages?: ConversationMessage[];
  lastActivity: Date;
  conversationScope?: string;
  profileKey?: string;
  mixedParticipants?: boolean;
  postSetupBootstrapDelivered?: boolean;
  lastJournalSnapshot?: import("./autonomy/execution-journal.js").ExecutionJournalSnapshot;
  /**
   * Persisted cross-task tally of PAOR reflection overrides (CONTINUE forced
   * over DONE). Mirrors {@link import("./agent-state.js").AgentState.reflectionOverrideCount}
   * so the counter survives session serialize/deserialize. Optional for
   * backward compatibility with legacy session files written before this
   * field existed — those default to 0 on restore.
   */
  reflectionOverrideCount?: number;
  /**
   * Rolling summary produced by session compaction (see session-compaction.ts).
   * Appended to the system prompt at provider call time instead of being stored
   * as a system-role message in `messages` (ConversationMessage has no system role).
   * Optional for backward compatibility with legacy session files.
   */
  compactionSummary?: string;
  /**
   * The provider's own count of the last call's input tokens (2026-09-09).
   * Compaction trusts this over the chars/4 estimate; cleared by a compaction
   * so a stale count cannot re-trigger before the next call reports.
   */
  lastInputTokens?: number;
}

/**
 * Narrow dependency interface for SessionManager — carries only the external
 * collaborators it actually needs.
 */
export interface SessionManagerDeps {
  readonly channel: {
    sendText(chatId: string, text: string): Promise<void>;
    sendMarkdown(chatId: string, markdown: string): Promise<void>;
    /**
     * Optional system-notice sink (renders as a distinct system pill rather
     * than an assistant answer). Mirrors {@link import("../channels/channel-core.interface.js").IChannelSender.sendSystemMessage}.
     * Optional so non-pill channels / test mocks keep working —
     * {@link SessionManager.sendVisibleAssistantNotice} falls back to
     * {@link sendMarkdown} when this is absent.
     */
    sendSystemMessage?(chatId: string, text: string): Promise<void>;
  };
  readonly interactionPolicy: {
    get(chatId: string): InteractionGateState | undefined;
  };
  readonly activeGoalTrees: Map<string, GoalTree>;
  readonly pendingResumeTrees: Map<string, GoalTree[]>;
  readonly memoryManager?: IMemoryManager;
  readonly sessionSummarizer?: SessionSummarizer;
  readonly reRetrievalConfig?: ReRetrievalConfig;
  readonly embeddingProvider?: IEmbeddingProvider;
  readonly ragPipeline?: IRAGPipeline;
  readonly instinctRetriever: InstinctRetriever | null;
  readonly eventEmitter: IEventEmitter<LearningEventMap> | null;
  readonly taskExecutionStore?: TaskExecutionStore;
  readonly sessionsDir?: string;
}

// ─── SessionManager ──────────────────────────────────────────────────────────

/**
 * Names that mean a tool changes things; used only when the caller has no
 * tool metadata. An UNKNOWN name is not a writer: the default used to treat
 * every name that did not look like a read as a write, and ten registered
 * read-only tools (learning_stats, code_quality, show_plan, …) cleared a
 * rejection on success (Codex 2026-09-17 #4). Both production boundaries pass
 * real metadata; this is the fallback's conservative side.
 */
const WRITE_TOOL_NAME_RE =
  /(^|_)(write|edit|create|delete|remove|move|rename|generate|bind|manage|apply|install|exec|run|commit|save|set|update|patch|stash|import|link|regenerate|prerender|push|pull|append|init|sync|index|switch|automation|place|checkout|merge|rebase|reset|tag|branch|clone|fetch|upload|record|capture|bake|convert|add)(_|$)/iu;
const READ_ONLY_TOOL_NAME_RE = /(^|_)(read|search|list|glob|grep|status|analyze|analyse|inspect|get|find|lookup|query|verify|diff|log|stats|quality|measure|show|plan|ask|speech|build|test)(_|$)/iu;
function defaultIsWriteCapable(toolName: string): boolean {
  return WRITE_TOOL_NAME_RE.test(toolName) && !READ_ONLY_TOOL_NAME_RE.test(toolName);
}

/**
 * A write-capable tool used to INSPECT: a shell running `git status`, a
 * stash tool listing, a manage tool reading. Such a call writes nothing and
 * is not the replacement the review asked for (Codex 2026-09-17 #3). The
 * first program of each segment of a shell chain is what counts.
 */
/**
 * POSITIVE evidence of a mutation, or nothing. The first version listed
 * read-only programs and called everything else a write, so `python -c
 * "print(1)"` and `sed -n 1,20p` resolved a rejection while `git branch
 * fix/hud` and `find -delete` did not (Codex 2026-09-17 #4/#5). A shell
 * command is a replacement write only when some segment provably mutates.
 */
const MUTATING_PROGRAM_RE =
  /^(?:\S*\/)?(?:tee|mv|cp|rm|rmdir|mkdir|touch|chmod|chown|ln|install|truncate|dd|patch|rsync|unzip|make|cargo|go|gradle|\.\/gradlew|gradlew|mvn|msbuild|xcodebuild|unity|unityhub)$/iu;
const GIT_MUTATING_RE =
  /^(?:add|apply|am|checkout|switch|restore|commit|merge|rebase|reset|revert|cherry-pick|clean|mv|rm|stash(?!\s+(?:list|show))|tag\s+(?!-l\b|--list\b|-n\d*\b)\S+|branch\s+(?!-[alrv]|--list|--all|--remotes|--show-current|$)\S+|remote\s+(?:add|remove|rm|rename|set-url)|push|pull|fetch|clone|init|submodule\s+(?:add|update|init)|worktree\s+(?:add|remove|prune)|config(?!\s+--get|\s+--list|\s+-l\b)\s+\S+|notes|filter-branch|gc|prune)\b/iu;
const READ_ONLY_ACTION_RE = /^(?:list|show|get|status|info|read|inspect|describe|check)$/iu;
/**
 * A write-shaped call inside an inline interpreter body (`python3 -c`,
 * `node -e`, …). The interpreter itself is neither a reader nor a writer;
 * its body is. `print(1)` and `json.load(open('x'))` are not writes;
 * `Path('x').write_text(…)` and `fs.writeFileSync(…)` are (Codex wave 0-A
 * review 2026-09-17 #5).
 */
const INTERPRETER_WRITE_RE =
  /\b(?:write_text|write_bytes|writeFileSync|writeFile|appendFileSync|appendFile|copyFileSync|copyFile|unlinkSync|unlink|renameSync|rename|rmSync|rmdirSync|rmdir|mkdirSync|mkdir|makedirs|touch)\s*\(|\bshutil\.(?:copy|copy2|copyfile|copytree|move|rmtree|make_archive|unpack_archive)\s*\(|\bos\.(?:remove|replace)\s*\(|\bopen\s*\([^)]*(?:,|mode\s*=)\s*['"][wax][bt+]*['"]|\.open\s*\(\s*['"][wax][bt+]*['"]|\.to_(?:csv|json|parquet|excel|pickle|hdf|feather)\s*\(|\bnp\.save(?:z|txt|z_compressed)?\s*\(|\b(?:json|pickle)\.dump\s*\(|\btorch\.save\s*\(|\.save\s*\(/u;
/**
 * The shell this inference reads: FLAT lists of simple commands joined by
 * `;`, newline, `&&`, `||` and `|`. A subshell, a brace group, a
 * heredoc, a command substitution, a continuation line or a compound
 * keyword can run or skip a write in ways no text inference can settle —
 * `(false && touch x); true` exits 0 and writes nothing (Codex 2026-09-17
 * on 2df6170e #4) — so such a command proves no write. `{}` alone is
 * find's and xargs' placeholder, not a group.
 */
const UNSUPPORTED_SHELL_RE = /[()`]|\{(?!\})|(?<!\{)\}|\$\(|\$'|<<|\\\n|(?:^|[;\n|&]\s*)(?:if|for|while|until|case|function|select)\s|(?:^|[\s;|&])eval(?=[\s;|&]|$)/u;
/**
 * A lone `&` backgrounds the command before it: `touch /missing/x &` exits
 * 0 at once and the write fails later, unobserved (Codex 2026-09-17 round
 * 3 #11). `&&` is a list operator, `2>&1` and `&>` are redirections.
 */
const BACKGROUND_RE = /(?<![&>])&(?![&>])/u;
const SHELL_PROGRAM_RE = /^(?:\S*\/)?(?:sh|bash|zsh|dash|ksh)$/u;
const INTERPRETER_PROGRAM_RE = /^(?:\S*\/)?(?:python(?:\d+(?:\.\d+)?)?|node|perl|ruby)$/iu;

/**
 * Drop `# …` comments: a `#` that starts a word outside quotes comments
 * to the end of the line. `true # ; touch x` runs `true` alone, and the
 * text-level statement split read `touch x` as its last statement (Codex
 * 2026-09-17 round 3 #11).
 */
function stripShellComments(command: string): string {
  let out = "";
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < command.length; i += 1) {
    const ch = command[i] ?? "";
    if (quote === null) {
      if (ch === "\\") {
        out += ch + (command[i + 1] ?? "");
        i += 1;
        continue;
      }
      if (ch === '"' || ch === "'") {
        quote = ch;
        out += ch;
        continue;
      }
      if (ch === "#" && (i === 0 || /[\s;|&(]/u.test(command[i - 1] ?? ""))) {
        const newline = command.indexOf("\n", i);
        if (newline === -1) break;
        i = newline - 1; // the newline itself still separates statements
        continue;
      }
      out += ch;
      continue;
    }
    if (quote === '"' && ch === "\\") {
      out += ch + (command[i + 1] ?? "");
      i += 1;
      continue;
    }
    if (ch === quote) quote = null;
    out += ch;
  }
  return out;
}

interface ShellWord {
  readonly text: string;
  readonly quoted: boolean;
  /** An unquoted `;`, `|`, `&`, newline or bracket: not a word, a boundary. */
  readonly structural: boolean;
}

/** Split into shell words, unquoting as the shell would; quotes concatenate (`"a"b'c'` is one word). */
function shellWords(command: string): ShellWord[] {
  const words: ShellWord[] = [];
  let text = "";
  let quoted = false;
  let started = false;
  const flush = (): void => {
    if (started) words.push({ text, quoted, structural: false });
    text = "";
    quoted = false;
    started = false;
  };
  for (let i = 0; i < command.length; i += 1) {
    const ch = command[i] ?? "";
    if (ch === "'") {
      const end = command.indexOf("'", i + 1);
      const close = end === -1 ? command.length : end;
      text += command.slice(i + 1, close);
      quoted = true;
      started = true;
      i = close;
      continue;
    }
    if (ch === '"') {
      let j = i + 1;
      for (; j < command.length && command[j] !== '"'; j += 1) {
        const c = command[j] ?? "";
        if (c === "\\" && /[$`"\\\n]/u.test(command[j + 1] ?? "")) {
          text += command[j + 1] ?? "";
          j += 1;
        } else {
          text += c;
        }
      }
      quoted = true;
      started = true;
      i = j;
      continue;
    }
    if (ch === "\\") {
      text += command[i + 1] ?? "";
      started = true;
      i += 1;
      continue;
    }
    if (/[ \t]/u.test(ch)) {
      flush();
      continue;
    }
    if (/[;|&\n(){}<>]/u.test(ch)) {
      flush();
      words.push({ text: ch, quoted: false, structural: true });
      continue;
    }
    text += ch;
    started = true;
  }
  flush();
  return words;
}

/**
 * `sh -c "…"`, `bash -lc "…"`: the wrapper runs its body, and the body is
 * what is judged (Codex 2026-09-17 on 2df6170e #7). The body is exactly
 * the word after the flags; later words are `$0` and the arguments, so
 * `sh -lc 'true' '; touch x'` runs `true` — the greedy quote-to-quote
 * regex read `true' '; touch x` as the body (round 3 #12). A flag word
 * with `n` (`-n`, no-exec) parses without running; `-o` names an option
 * that may be `noexec`. Returns `null` when the command is not a plain
 * wrapper (the caller infers it as ordinary shell), `false` when it is a
 * wrapper that proves nothing.
 */
function shellWrapperBody(raw: string): string | false | null {
  const words = shellWords(raw);
  if (words.some((w) => w.structural)) return null;
  const program = words[0];
  if (program === undefined || program.quoted || !SHELL_PROGRAM_RE.test(program.text)) return null;
  let i = 1;
  let runsString = false;
  for (; i < words.length; i += 1) {
    const w = words[i];
    if (w === undefined || w.quoted || !w.text.startsWith("-")) break;
    if (w.text === "--") {
      i += 1;
      break;
    }
    if (/n/u.test(w.text) || /^[-+]o$/u.test(w.text)) return false;
    if (/^-[a-zA-Z]*c[a-zA-Z]*$/u.test(w.text)) runsString = true;
  }
  if (!runsString) return null;
  const body = words[i];
  return body === undefined ? false : body.text;
}

/**
 * Which `&&`/`||`-joined segments of the LAST statement provably ran AND
 * SUCCEEDED, given the whole command exited 0 (the caller only asks about
 * results that exited 0).
 *
 * "Ran" was not enough: `touch /missing-parent/x || true` exits 0 and
 * writes nothing, and the first version credited the first segment for
 * having run (Codex 2026-09-17 on 2df6170e #5). With no `||` present,
 * exit 0 needs every `&&` segment to succeed — unless one is the literal
 * `false`, which contradicts the premise.
 *
 * `&&` and `||` are left-associative, so `A || B && Z1 && Z2` is
 * `((A || B) && Z1) && Z2`: exit 0 proves Z1 and Z2 ran and succeeded
 * (every segment after the one that follows the last `||`), and proves
 * `A || B` exited 0 — which says nothing about B unless A is the literal
 * `false` (`false || touch x`). The first version withheld Z1 and Z2 too
 * (Codex 2026-09-17 round 3 #15).
 */
function provablySucceededSegments(statement: string): string[] {
  const parts = statement.split(/\s*(&&|\|\|)\s*/u);
  const segments: string[] = [];
  const ops: string[] = [];
  for (let i = 0; i < parts.length; i += 1) {
    if (i % 2 === 0) segments.push((parts[i] ?? "").trim());
    else ops.push(parts[i] ?? "");
  }
  const isFalse = (seg: string): boolean => /^(?:false|!\s+true)$/u.test(seg);
  const nonEmpty = (segs: string[]): string[] => segs.filter((seg) => seg.length > 0);
  const lastOr = ops.lastIndexOf("||");
  if (lastOr === -1) return segments.some(isFalse) ? [] : nonEmpty(segments);
  const tail = segments.slice(lastOr + 2);
  if (tail.some(isFalse)) return [];
  const prefixIsFalse = lastOr === 0 && isFalse(segments[0] ?? "");
  const alternative = segments[lastOr + 1] ?? "";
  return nonEmpty(prefixIsFalse ? [alternative, ...tail] : tail);
}

function mutatesSomething(input: Record<string, unknown> | undefined): boolean {
  if (input === undefined) return true;
  const action = input["action"];
  if (typeof action === "string") return !READ_ONLY_ACTION_RE.test(action);
  const command = input["command"];
  if (typeof command !== "string") return true;
  const raw = stripShellComments(command.trim()).trim();
  // A wrapper runs its body: `sh -c "touch x"` is judged as `touch x`.
  const wrapped = shellWrapperBody(raw);
  if (wrapped === false) return false;
  if (wrapped !== null) return mutatesSomething({ command: wrapped });
  // Syntax this inference does not read proves nothing. Quoted text is
  // blanked first: the parentheses of `python3 -c "Path('x').write_text()"`
  // are the body's, not the shell's. ANSI-C quoting (`$'-c'`) keeps its
  // `$'` opener: its escapes are not decoded here, so `touch $'-c' x`
  // proves nothing (Codex 2026-09-17 round 4 #6).
  const structure = raw.replace(/"((?:[^"\\]|\\.)*)"|(\$?)'([^']*)'/gu, (m, _d: string | undefined, dollar: string | undefined) =>
    dollar ? `$'${"_".repeat(m.length - 2)}` : "_".repeat(m.length));
  if (UNSUPPORTED_SHELL_RE.test(structure)) return false;
  if (BACKGROUND_RE.test(structure)) return false;
  // Quoted text is not shell syntax: printf "a > b" writes nothing, and
  // 2>&1 duplicates a descriptor (Codex 2026-09-17 round 2 #6).
  // …so quoted text keeps its words (a quoted program path is still the
  // program) and loses its shell characters.
  const unquoted = raw
    .replace(/"((?:[^"\\]|\\.)*)"|'([^']*)'/gu, (_m, d: string | undefined, q: string | undefined) => (d ?? q ?? "").replace(/[<>|;&\n]/gu, "_"))
    .replace(/\d*>&\d+/gu, " ");
  // EXIT 0 IS THE LAST STATEMENT'S. `test -d /absent && touch x; true`
  // exits 0 and writes nothing: an earlier statement's status is masked by
  // the later one, so only the last statement is inferred (Codex 2026-09-17
  // on 2df6170e #3). Within it, only the segments that provably succeeded
  // count, and of a pipeline only the last stage's status is known.
  const statements = unquoted.split(/\s*(?:(?<!\\);|\n)+\s*/u).map((s) => s.trim()).filter((s) => s.length > 0);
  const last = statements[statements.length - 1];
  if (last === undefined) return false;
  return provablySucceededSegments(last).some((segment) => {
    const stages = segment.split(/\s*\|\s*/u).map((stage) => stage.trim()).filter((stage) => stage.length > 0);
    const final = stages[stages.length - 1];
    return final !== undefined && stageMutates(final);
  });
}

/**
 * Strip the words that only set up the program: `env` and its options and
 * assignments, bare assignments, and sudo/time/nice/nohup/command/exec.
 * `null` when nothing is left to run, or when an `env` form (`-S`, whose
 * operand is re-split into words) is not read here.
 */
function unwrapEnvPrefix(words: string[]): string[] | null {
  let i = 0;
  const assignment = /^[A-Za-z_][A-Za-z0-9_]*=/u;
  while (i < words.length) {
    const w = words[i] ?? "";
    if (assignment.test(w)) {
      i += 1;
      continue;
    }
    if (/^(?:\S*\/)?env$/u.test(w)) {
      i += 1;
      while (i < words.length) {
        const opt = words[i] ?? "";
        if (opt === "--") {
          i += 1;
          break;
        }
        if (assignment.test(opt)) {
          i += 1;
          continue;
        }
        if (!opt.startsWith("-")) break;
        if (/^-[a-zA-Z]*S/u.test(opt) || /^--split-string/u.test(opt)) return null;
        if (/^-[uC]$/u.test(opt) || /^--(?:unset|chdir)$/u.test(opt)) {
          if (i + 1 >= words.length) return null;
          i += 2;
          continue;
        }
        i += 1;
      }
      continue;
    }
    // `command -p touch x` and `exec -a x touch x` run touch; `-p`/`-a x`
    // are the wrapper's options, not the program (Codex 2026-09-17 round
    // 4 #9). `command -v`/`-V` inspect and run nothing.
    if (w === "command") {
      i += 1;
      while (i < words.length) {
        const opt = words[i] ?? "";
        if (opt === "--") {
          i += 1;
          break;
        }
        if (!/^-[pvV]+$/u.test(opt)) break;
        if (/[vV]/u.test(opt)) return null;
        i += 1;
      }
      continue;
    }
    if (w === "exec") {
      i += 1;
      while (i < words.length) {
        const opt = words[i] ?? "";
        if (opt === "--") {
          i += 1;
          break;
        }
        if (/^-[cl]*a$/u.test(opt)) {
          if (i + 1 >= words.length) return null;
          i += 2;
          continue;
        }
        if (!/^-[cl]+$/u.test(opt)) break;
        i += 1;
      }
      continue;
    }
    if (/^(?:sudo|time|nice|nohup)$/u.test(w)) {
      i += 1;
      continue;
    }
    break;
  }
  const rest = words.slice(i);
  return rest.length === 0 ? null : rest;
}

/**
 * Drop redirections and their operands from a program's words: `<file`,
 * `< file`, `N>file`, `>>file`, `&>file`. `tee /dev/null < package.json`
 * read the input file as a tee operand (Codex 2026-09-17 round 4 #8).
 * `>&N` duplications were blanked before this view.
 */
function withoutRedirections(words: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < words.length; i += 1) {
    const w = words[i] ?? "";
    if (/^(?:\d*[<>]{1,2}|&>>?)$/u.test(w)) {
      i += 1; // the operand is the next word
      continue;
    }
    if (/^(?:\d*[<>]{1,2}|&>>?)\S/u.test(w)) continue;
    out.push(w);
  }
  return out;
}

/** Does one pipeline stage (a single program invocation) positively mutate something? */
function stageMutates(seg: string): boolean {
  // A redirection writes — unless it is to /dev/null, or to a variable
  // (`printf x > "$OUT"` with OUT=/dev/null; the quotes are gone from this
  // view, so the target word begins with `$`) whose value is not read here
  // (Codex 2026-09-17 round 3 #14).
  if (/(?:^|[^<>])>\s*(?!\/dev\/null\b|\$)\S/u.test(seg.replace(/>>/gu, ">"))) return true;
  // Unwrap `env VAR=x`, `env -i`/`-u VAR`, plain assignments and
  // sudo/time/nice/command/exec. An option operand is consumed even when
  // it is the last word: `env -u touch` unsets a variable and runs
  // nothing (Codex 2026-09-17 round 3 #13, #15).
  const unwrapped = unwrapEnvPrefix(seg.split(/\s+/u).filter((w) => w.length > 0));
  if (unwrapped === null) return false;
  const words = unwrapped;
  // "/Applications/Unity/Unity.exe" is the same program as unity; quotes
  // were blanked above.
  const program = (words[0] ?? "").replace(/\.exe$/iu, "");
  const rest = words.slice(1).join(" ");
  if (/^(?:\S*\/)?git$/iu.test(program)) {
    // Leading options: -C dir, -c k=v, --no-pager, --git-dir=…
    const sub = rest.replace(/^(?:(?:-C\s+\S+|-c\s+\S+|--no-pager|--git-dir=\S+|--work-tree=\S+)\s+)*/u, "");
    return GIT_MUTATING_RE.test(sub);
  }
  if (/^(?:\S*\/)?sed$/iu.test(program)) return /(?:^|\s)-i\b|(?:^|\s)--in-place\b/u.test(rest);
  if (/^(?:\S*\/)?find$/iu.test(program)) {
    if (/\s-delete\b/u.test(rest)) return true;
    // -exec runs a program: it writes only if THAT program does.
    const exec = /\s-(?:exec|execdir|ok)\s+(.+?)(?:\s*[;+]|$)/u.exec(rest);
    return exec !== null && mutatesSomething({ command: exec[1] ?? "" });
  }
  if (/^(?:\S*\/)?dotnet$/iu.test(program)) {
    return /^(?:build|run|new|add|remove|restore|publish|pack|clean|format|tool|workload|nuget\s+(?:add|push|delete)|sln|ef)\b/iu.test(rest);
  }
  if (/^(?:\S*\/)?(?:npm|pnpm|yarn|bun)$/iu.test(program)) {
    if (/^(?:install|i|ci|add|remove|uninstall|update|up|link|unlink|publish|version|init|create|dedupe|prune|rebuild|exec|dlx|x)\b/iu.test(rest)) return true;
    // "npm run lint" inspects; "npm run build" writes. Decide by the script name.
    const run = /^run(?:-script)?\s+(\S+)/iu.exec(rest);
    return run !== null && /build|gen|generate|create|write|migrate|setup|install|prepare|format|fix|bump|release|compile|bundle|pack/iu.test(run[1] ?? "");
  }
  if (/^(?:\S*\/)?(?:npx|bunx)$/iu.test(program)) return true;
  if (/^(?:\S*\/)?curl$/iu.test(program)) {
    return /(?:^|\s)(?:-o|-O|--output|--remote-name|-X\s*(?:POST|PUT|DELETE|PATCH)|-d|--data\S*|-F|--form|-T|--upload-file)\b/u.test(rest);
  }
  if (/^(?:\S*\/)?wget$/iu.test(program)) return !/(?:^|\s)--spider\b/u.test(rest);
  if (/^(?:\S*\/)?tar$/iu.test(program)) {
    const flags = rest.split(/\s+/u)[0] ?? "";
    return /^--(?:extract|create)$/u.test(flags) || (/^-?[a-zA-Z]+$/u.test(flags) && /[xc]/u.test(flags) && !/t/u.test(flags));
  }
  // xargs: options with operands (-n 1, -I {}, -P 4, -L 2, -d x, -s N, -a f,
  // -E eof) are consumed with them — `xargs -I touch` names a placeholder
  // and runs nothing (Codex 2026-09-17 round 3 #13) — so the program after
  // them is the one judged. Limitation: xargs with EMPTY input runs its
  // program once with no arguments (GNU) or not at all (`-r`, BSD); the
  // input is not read here, so `printf '' | xargs touch` is credited as
  // the program would be.
  if (/^(?:\S*\/)?xargs$/iu.test(program)) {
    const args = words.slice(1);
    let i = 0;
    for (; i < args.length; i += 1) {
      const w = args[i] ?? "";
      if (w === "--") {
        i += 1;
        break;
      }
      if (!w.startsWith("-")) break;
      if (/^-[nIPLdsaE]$/u.test(w) || /^--(?:max-args|max-procs|max-lines|delimiter|arg-file|max-chars|eof|replace)$/u.test(w)) {
        if (i + 1 >= args.length) return false;
        i += 1;
      }
    }
    const programWords = args.slice(i);
    return programWords.length > 0 && mutatesSomething({ command: programWords.join(" ") });
  }
  // tee with nothing to write to writes nothing; /dev/null is nothing. The
  // redirections and their operands are consumed first: `< package.json`
  // is tee's input, not a file it writes.
  if (/^(?:\S*\/)?tee$/iu.test(program)) return withoutRedirections(words.slice(1)).some((w) => !w.startsWith("-") && w !== "/dev/null");
  // touch -c (--no-create) only updates timestamps of files that exist.
  // Options end at `--`: `touch -- -c` creates a file named `-c` (Codex
  // 2026-09-17 round 4 #6).
  if (/^(?:\S*\/)?touch$/iu.test(program)) {
    for (const w of words.slice(1)) {
      if (w === "--") break;
      if (/^(?:-[a-zA-Z]*c[a-zA-Z]*|--no-create)$/u.test(w)) return false;
    }
    return true;
  }
  if (INTERPRETER_PROGRAM_RE.test(program)) {
    // An inline body writes only if IT contains a write-shaped call; a
    // script file is unknown, not a write.
    const inline = /(?:^|\s)(?:-c|-e|--eval)\s+([\s\S]+)$/u.exec(rest);
    return inline !== null && INTERPRETER_WRITE_RE.test(inline[1] ?? "");
  }
  return MUTATING_PROGRAM_RE.test(program);
}

/**
 * Did the shell tool's own footer say exit 0? Its result is `$ <command>`,
 * then `Exit code: N | Duration: Nms`, then optional `--- stdout ---` /
 * `--- stderr ---` sections. A non-error result is not exit 0: with
 * `ok_exit_codes: [0, 1]` a failed `touch /missing/x` comes back without
 * `is_error` (Codex 2026-09-17 round 3 #10). The echo is exactly
 * `$ <command>\n`, so when the content starts with it the footer is the
 * first line of what remains — an echoed command carrying its own
 * "Exit code: 0" line AND a "--- stdout ---" line would otherwise forge
 * the boundary (Codex 2026-09-17 round 4 #3). The tool echoes the command
 * TRIMMED, so the prefix is built from the trimmed command — a trailing
 * newline on the forged command otherwise missed the echo and fell back
 * to the footer inside the echoed text (Codex 2026-09-17 round 5 #5). A
 * result that starts with `$ ` whose echo does not match the command (a
 * rewritten path, a truncated echo) is UNPROVEN: the footer cannot be
 * told from the echoed text, so it is not exit 0. Only a result carrying
 * no echo at all (a batch child) reads the LAST footer before the first
 * output marker. No footer proves nothing.
 */
function shellResultExitedZero(content: string, command: string | undefined): boolean {
  const echo = command === undefined ? undefined : `$ ${command.trim()}\n`;
  if (echo !== undefined && content.startsWith(echo)) {
    const footer = /^Exit code: (\d+) \| Duration: \d+ms[ \t]*(?=\n|$)/u.exec(content.slice(echo.length));
    return footer !== null && Number(footer[1]) === 0;
  }
  if (content.startsWith("$ ")) return false;
  const marker = content.search(/(?:^|\n)--- (?:stdout|stderr) ---(?:\n|$)/u);
  const head = marker === -1 ? content : content.slice(0, marker);
  let exit: number | undefined;
  for (const m of head.matchAll(/(?:^|\n)Exit code: (\d+) \| Duration: \d+ms[ \t]*(?=\n|$)/gu)) {
    exit = Number(m[1]);
  }
  return exit === 0;
}

/**
 * Did a write-capable tool succeed AFTER the rejection at (messageIndex,
 * blockIndex)? Tool names come from the assistant's tool_use blocks, matched
 * by id to the user's tool_result blocks.
 */
function writeSucceededAfter(
  session: Session,
  messageIndex: number,
  blockIndex: number,
  isWriteCapable: (toolName: string) => boolean,
): boolean {
  const useById = new Map<string, { name: string; input: Record<string, unknown> | undefined }>();
  for (const message of session.messages) {
    if (!message || message.role !== "assistant" || !Array.isArray(message.content)) continue;
    for (const block of message.content) {
      if (block && block.type === "tool_use" && typeof block.id === "string" && typeof block.name === "string") {
        const input = block.input && typeof block.input === "object" ? (block.input as Record<string, unknown>) : undefined;
        useById.set(block.id, { name: block.name, input });
      }
    }
  }
  for (let i = messageIndex; i < session.messages.length; i += 1) {
    const message = session.messages[i];
    if (!message || message.role !== "user" || !Array.isArray(message.content)) continue;
    const from = i === messageIndex ? blockIndex + 1 : 0;
    for (let j = from; j < message.content.length; j += 1) {
      const block = message.content[j];
      if (!block || block.type !== "tool_result" || typeof block.content !== "string") continue;
      if (block.is_error === true) continue;
      if (block.content.startsWith("Self-managed write review rejected")) continue;
      if (/^Error\b/u.test(block.content)) continue;
      const use = useById.get(block.tool_use_id);
      if (use === undefined || !isWriteCapable(use.name)) continue;
      // The shell inference below assumes exit 0; the footer must say so.
      if (use.name === "shell_exec") {
        const command = use.input?.["command"];
        if (!shellResultExitedZero(block.content, typeof command === "string" ? command : undefined)) continue;
      }
      if (!mutatesSomething(use.input)) continue;
      return true;
    }
  }
  return false;
}

export class SessionManager {
  /** Minimum interval between debounced memory persists per chat (5s). */
  private static readonly PERSIST_DEBOUNCE_MS = 5_000;
  private static readonly MAX_PERSISTED_MESSAGES = 50;
  private static readonly SESSION_EXPIRY_MS = 24 * 60 * 60 * 1000; // 24 hours

  readonly sessions = new Map<string, Session>();
  readonly sessionLocks = new Map<string, Promise<void>>();
  private readonly lastPersistTime = new Map<string, number>();
  private readonly deps: SessionManagerDeps;
  private staleSessionCleanupInterval: ReturnType<typeof setInterval> | undefined;

  constructor(deps: SessionManagerDeps) {
    this.deps = deps;

    // Clean up stale sessions on startup and every 6 hours
    this.cleanupStaleSessions();
    this.staleSessionCleanupInterval = setInterval(() => this.cleanupStaleSessions(), 6 * 60 * 60 * 1000);
  }

  /** Stop the periodic stale session cleanup. */
  dispose(): void {
    if (this.staleSessionCleanupInterval) {
      clearInterval(this.staleSessionCleanupInterval);
      this.staleSessionCleanupInterval = undefined;
    }
  }

  // ── Serialization ─────────────────────────────────────────────────────────

  static serializeSession(session: Session): string {
    const messages = session.messages.slice(-SessionManager.MAX_PERSISTED_MESSAGES);
    return JSON.stringify({
      messages,
      lastActivity: session.lastActivity.toISOString(),
      conversationScope: session.conversationScope,
      profileKey: session.profileKey,
      lastJournalSnapshot: session.lastJournalSnapshot,
      reflectionOverrideCount: session.reflectionOverrideCount,
      compactionSummary: session.compactionSummary,
    });
  }

  static deserializeSession(json: string): Session | null {
    try {
      const data = JSON.parse(json);
      const lastActivity = new Date(data.lastActivity);
      if (Date.now() - lastActivity.getTime() > SessionManager.SESSION_EXPIRY_MS) {
        return null; // expired
      }
      // Validate message structure to prevent injection via tampered session files
      const rawMessages = Array.isArray(data.messages) ? data.messages : [];
      const messages = rawMessages.filter(
        (m: unknown): m is ConversationMessage =>
          typeof m === "object" && m !== null &&
          "role" in m &&
          ((m as Record<string, unknown>).role === "user" || (m as Record<string, unknown>).role === "assistant") &&
          "content" in m &&
          (typeof (m as Record<string, unknown>).content === "string" ||
           (m as Record<string, unknown>).content === null ||
           Array.isArray((m as Record<string, unknown>).content)),
      );
      // Migration: legacy session files (pre-reflectionOverrideCount) default to 0.
      const rawOverrideCount = (data as Record<string, unknown>).reflectionOverrideCount;
      const reflectionOverrideCount =
        typeof rawOverrideCount === "number" &&
        Number.isFinite(rawOverrideCount) &&
        rawOverrideCount >= 0
          ? rawOverrideCount
          : 0;
      // Migration: legacy session files (pre-compactionSummary) restore as undefined.
      // Truncate (head+tail) an over-long restored summary to MAX_ROLLING_SUMMARY_CHARS
      // instead of discarding it — discarding loses ALL compacted history, including
      // the preserved "Original user request" header. The 512KB whole-file rejection
      // in restoreSessionFromDisk still guards against pathological files.
      const rawCompactionSummary = (data as Record<string, unknown>).compactionSummary;
      let compactionSummary: string | undefined;
      if (typeof rawCompactionSummary === "string" && rawCompactionSummary.length > 0) {
        compactionSummary = capRollingSummary(rawCompactionSummary);
        if (compactionSummary.length < rawCompactionSummary.length) {
          // Best-effort log — must never break a restore if the logger is not yet
          // initialized (deserializeSession is a static helper used in unit tests).
          try {
            getLogger().debug("Restored compaction summary truncated to rolling cap", {
              original: rawCompactionSummary.length,
              capped: MAX_ROLLING_SUMMARY_CHARS,
            });
          } catch { /* logger not initialized — non-fatal */ }
        }
      }
      return {
        messages,
        visibleMessages: [],
        lastActivity,
        conversationScope: data.conversationScope,
        profileKey: data.profileKey,
        lastJournalSnapshot: data.lastJournalSnapshot,
        reflectionOverrideCount,
        compactionSummary,
      };
    } catch {
      return null;
    }
  }

  // ── Disk persistence ──────────────────────────────────────────────────────

  private sessionFilePath(chatId: string): string {
    const safeName = chatId.replace(/[^a-zA-Z0-9_-]/g, "_");
    return join(this.deps.sessionsDir!, `${safeName}.json`);
  }

  private async persistSessionToDisk(chatId: string, session: Session): Promise<void> {
    const dir = this.deps.sessionsDir;
    if (!dir) return;
    if (!existsSync(dir)) {
      await mkdir(dir, { recursive: true, mode: 0o700 });
    }
    await writeFile(this.sessionFilePath(chatId), SessionManager.serializeSession(session), { encoding: "utf-8", mode: 0o600 });
  }

  private static readonly MAX_SESSION_FILE_BYTES = 512 * 1024; // 512KB safety cap

  private restoreSessionFromDisk(chatId: string): Session | null {
    if (!this.deps.sessionsDir) return null;
    try {
      const filePath = this.sessionFilePath(chatId);
      if (!existsSync(filePath)) return null;
      const stat = statSync(filePath);
      if (stat.size > SessionManager.MAX_SESSION_FILE_BYTES) {
        getLogger().warn("Session file too large, skipping restore", { chatId, size: stat.size });
        return null;
      }
      const json = readFileSync(filePath, "utf-8");
      return SessionManager.deserializeSession(json);
    } catch {
      return null;
    }
  }

  /**
   * Delete session files older than SESSION_EXPIRY_MS.
   * Call periodically (e.g., on startup) to prevent disk accumulation.
   */
  cleanupStaleSessions(): void {
    const dir = this.deps.sessionsDir;
    if (!dir || !existsSync(dir)) return;
    try {
      for (const file of readdirSync(dir)) {
        if (!file.endsWith(".json")) continue;
        try {
          const filePath = join(dir, file);
          const stat = statSync(filePath);
          if (Date.now() - stat.mtimeMs > SessionManager.SESSION_EXPIRY_MS) {
            unlinkSync(filePath);
          }
        } catch { /* skip individual file errors */ }
      }
    } catch {
      getLogger().debug("Session cleanup failed", { dir });
    }
  }

  // ── Accessor ─────────────────────────────────────────────────────────────

  /**
   * Expose lastPersistTime for the orchestrator's profile-touch debouncing.
   */
  get persistTimeMap(): Map<string, number> {
    return this.lastPersistTime;
  }

  // ── Session lifecycle ────────────────────────────────────────────────────

  getOrCreateSession(chatId: string): Session {
    let session = this.sessions.get(chatId);
    if (session) {
      // Move to end for LRU ordering (Map preserves insertion order)
      this.sessions.delete(chatId);
      this.sessions.set(chatId, session);
      return session;
    }

    // Try disk restore before creating fresh session
    if (this.deps.sessionsDir) {
      const restored = this.restoreSessionFromDisk(chatId);
      if (restored) {
        this.sessions.set(chatId, restored);
        return restored;
      }
    }

    // Evict oldest session if at capacity
    if (this.sessions.size >= MAX_SESSIONS) {
      const oldestKey = this.sessions.keys().next().value as string;
      const oldestSession = this.sessions.get(oldestKey);
      this.sessions.delete(oldestKey);
      this.sessionLocks.delete(oldestKey);
      this.deps.activeGoalTrees.delete(oldestSession?.conversationScope ?? oldestKey);
    }

    session = {
      messages: [],
      visibleMessages: [],
      lastActivity: new Date(),
      mixedParticipants: false,
    };
    this.sessions.set(chatId, session);
    return session;
  }

  /**
   * Trim session history to keep context manageable.
   * Trims at safe boundaries to avoid orphaning tool_use/tool_result pairs.
   * Returns the trimmed (removed) messages for persistence.
   */
  trimSession(session: Session, maxMessages: number): ConversationMessage[] {
    if (session.messages.length <= maxMessages) return [];

    const overflow = session.messages.length - maxMessages;
    /**
     * A surviving conversation must START on a message the provider accepts:
     * a user turn that is not an orphaned tool result. Anthropic and OpenAI
     * both reject a history whose first message is an assistant turn, or whose
     * `tool_result` has no preceding `tool_use` — with a 400, not a warning.
     */
    const isValidHead = (msg: ConversationMessage): boolean => {
      if (msg.role !== "user") return false;
      if (typeof msg.content === "string") return true;
      // Multimodal user turns (images/documents) are fine; a tool_result block
      // is not, because its matching tool_use has just been trimmed away.
      return !(Array.isArray(msg.content)
        && msg.content.some((b) => (b as { type?: string })?.type === "tool_result"));
    };

    const trimMessages = (count: number): ConversationMessage[] => {
      const allRemoved = session.messages.splice(0, count);
      // Repair the head after ANY trim. The safe-boundary path above already
      // lands on a valid user turn so this is a no-op there, but the hard-cap
      // fallbacks below cut at an arbitrary index and previously left the
      // session permanently un-sendable: the trim is persisted, so every later
      // request in that session repeated the same 400.
      while (session.messages.length > 0 && !isValidHead(session.messages[0]!)) {
        allRemoved.push(session.messages.shift()!);
      }
      if (allRemoved.length === 0) {
        return allRemoved;
      }
      if (session.visibleMessages?.length) {
        const removedSet = new Set(allRemoved);
        session.visibleMessages = session.visibleMessages.filter(
          (message) => !removedSet.has(message),
        );
      }
      return allRemoved;
    };

    // Find a safe trim boundary that does NOT orphan tool_call/tool_result pairs.
    // A safe boundary is a user message with plain string content (not a tool_result array)
    // that is NOT immediately preceded by an assistant message with tool_calls.
    let trimTo = 0;
    for (let i = overflow; i < session.messages.length; i++) {
      const msg = session.messages[i]!;

      // Must be a plain user message (string content, not tool_result array)
      if (msg.role !== "user") continue;
      if (typeof msg.content !== "string") continue;

      // Check the previous message — if it's an assistant with tool_calls,
      // this user message might be a tool_result response (content mismatch
      // but we need to be safe). Only trim if the previous is NOT a tool_call.
      if (i > 0) {
        const prev = session.messages[i - 1]!;
        if (prev.role === "assistant" && (prev as AssistantMessage).tool_calls?.length) {
          continue; // Skip — trimming here would orphan the tool_calls
        }
      }

      trimTo = i;
      break;
    }

    if (trimTo > 0) {
      return trimMessages(trimTo);
    }

    // Fallback: if no safe boundary found and session exceeds hard cap (2x max),
    // force trim at the oldest complete tool pair boundary to prevent unbounded growth
    const hardCap = maxMessages * 2;
    if (session.messages.length > hardCap) {
      getLogger().warn("Session exceeds hard cap, force-trimming", {
        size: session.messages.length,
        hardCap,
      });
      // Find the first complete pair boundary (user message after a tool_result)
      for (let i = 1; i < overflow; i++) {
        const msg = session.messages[i]!;
        const prev = session.messages[i - 1]!;
        if (msg.role === "user" && prev.role === "user") {
          return trimMessages(i);
        }
      }
      // Last resort: trim at overflow. trimMessages repairs the head, so this
      // no longer orphans a tool_result or leaves an assistant turn leading.
      return trimMessages(overflow);
    }

    return [];
  }

  // ── Visible transcript helpers ───────────────────────────────────────────

  private ensureVisibleMessages(session: Session): ConversationMessage[] {
    if (!session.visibleMessages) {
      session.visibleMessages = [];
    }
    return session.visibleMessages;
  }

  getVisibleTranscript(session: Session): ConversationMessage[] {
    return this.ensureVisibleMessages(session);
  }

  appendVisibleUserMessage(session: Session, content: string | MessageContent[]): void {
    const message: ConversationMessage = { role: "user", content };
    session.messages.push(message);
    this.ensureVisibleMessages(session).push(message);
  }

  appendVisibleAssistantMessage(session: Session, content: string): void {
    const sanitizedContent = stripVisibleProviderArtifacts(content);
    const message: ConversationMessage = { role: "assistant", content: sanitizedContent };
    session.messages.push(message);
    this.ensureVisibleMessages(session).push(message);
  }

  extractLastUserContent(session: Session): string | MessageContent[] | null {
    for (let i = session.messages.length - 1; i >= 0; i--) {
      const msg = session.messages[i]!;
      if (msg.role === "user") {
        return msg.content as string | MessageContent[] | null;
      }
    }
    return null;
  }

  extractLastUserMessage(session: Session): string {
    const content = this.extractLastUserContent(session);
    if (typeof content === "string") {
      return content;
    }
    if (Array.isArray(content)) {
      const textParts = content
        .filter((b): b is { type: "text"; text: string } => b.type === "text")
        .map((b) => b.text);
      if (textParts.length > 0) {
        return textParts.join(" ");
      }
    }
    return "";
  }

  // ── Send + record helpers ───────────────────────────────────────────────

  async sendVisibleAssistantText(
    chatId: string,
    session: Session,
    content: string,
  ): Promise<void> {
    const sanitizedContent = stripVisibleProviderArtifacts(content);
    this.appendVisibleAssistantMessage(session, sanitizedContent);
    await this.deps.channel.sendText(chatId, sanitizedContent);
  }

  async sendVisibleAssistantMarkdown(
    chatId: string,
    session: Session,
    content: string,
  ): Promise<void> {
    const sanitizedContent = stripVisibleProviderArtifacts(content);
    this.appendVisibleAssistantMessage(session, sanitizedContent);
    await this.deps.channel.sendMarkdown(chatId, sanitizedContent);
  }

  /**
   * Render a TRANSIENT system notice (e.g. a mid-run resilience status like
   * "provider is slow, retrying…") as a system pill rather than an assistant
   * answer. Unlike {@link sendVisibleAssistantMarkdown} this:
   *   1. Does NOT append the text to {@link Session.messages} — the notice is
   *      operational meta, not task content, and recording it would pollute the
   *      model's transcript/context (the failure SIGNAL the model needs reaches it
   *      through the system prompt's "Provider Health Awareness" section and the
   *      reflection prompt's PROVIDER HEALTH line, both fed by IterationHealthTracker).
   *   2. Routes to {@link SessionManagerDeps.channel.sendSystemMessage} when the
   *      channel implements it (web channel renders it as a distinct pill), and
   *      degrades gracefully to {@link SessionManagerDeps.channel.sendMarkdown}
   *      otherwise — byte-identical to {@link sendVisibleAssistantMarkdown}'s sink
   *      on non-pill channels, so the flag-off / no-pill case is behavior-preserving
   *      except for the (intentionally) dropped transcript append.
   *
   * Use this ONLY for genuinely transient status; terminal outcomes and
   * interactive prompts must stay on {@link sendVisibleAssistantMarkdown} so the
   * user (and the persisted transcript) retain the run's outcome.
   */
  async sendVisibleAssistantNotice(
    chatId: string,
    _session: Session,
    content: string,
  ): Promise<void> {
    const sanitizedContent = stripVisibleProviderArtifacts(content);
    // Intentionally NOT appended to session.messages — transient, not transcript.
    if (typeof this.deps.channel.sendSystemMessage === "function") {
      await this.deps.channel.sendSystemMessage(chatId, sanitizedContent);
      return;
    }
    // Fall back to the markdown sink (not sendText) so non-pill channels keep the
    // same rendering the resilience notice had before this change.
    await this.deps.channel.sendMarkdown(chatId, sanitizedContent);
  }

  // ── Persistence ──────────────────────────────────────────────────────────

  /**
   * Persist conversation messages to memory so the agent remembers them next session.
   * Debounced by default — pass `force: true` for trim evictions and session cleanup.
   */
  async persistSessionToMemory(
    chatId: string,
    messages: ConversationMessage[],
    force = false,
  ): Promise<void> {
    if (!this.deps.memoryManager) return;
    if (messages.length < 2) return;

    if (!force) {
      const now = Date.now();
      const lastTime = this.lastPersistTime.get(chatId) ?? 0;
      if (now - lastTime < SessionManager.PERSIST_DEBOUNCE_MS) return;
      this.lastPersistTime.set(chatId, now);
    }

    try {
      const summary = messages
        .map((m) => {
          if (typeof m.content === "string") return `[${m.role}] ${m.content}`;
          if (Array.isArray(m.content)) {
            const texts = (m.content as MessageContent[])
              .filter((b): b is { type: "text"; text: string } => b.type === "text")
              .map((b) => b.text);
            return texts.length > 0
              ? `[${m.role}] ${texts.join(" ")}`
              : `[${m.role}] [media message]`;
          }
          return `[${m.role}] [complex content]`;
        })
        .join("\n");

      if (summary) {
        // Sanitize before persisting — strip any leaked API keys/secrets
        const sanitized = redactSensitiveText(summary);
        // Extract first user message and last assistant message for structured storage
        const userMsg = messages.find((m) => m.role === "user");
        let assistantMsg: ConversationMessage | undefined;
        for (let i = messages.length - 1; i >= 0; i--) {
          if (messages[i]!.role === "assistant") {
            assistantMsg = messages[i];
            break;
          }
        }
        const extractText = (msg: ConversationMessage | undefined): string | undefined => {
          if (!msg) return undefined;
          if (typeof msg.content === "string") return msg.content.slice(0, 500);
          if (Array.isArray(msg.content)) {
            const texts = (msg.content as Array<{ type: string; text?: string }>)
              .filter((b) => b.type === "text" && b.text)
              .map((b) => b.text)
              .join(" ");
            return texts.slice(0, 500) || undefined;
          }
          return undefined;
        };
        const result = await this.deps.memoryManager.storeConversation(
          chatId as ChatId,
          sanitized,
          {
            userMessage: extractText(userMsg),
            assistantMessage: extractText(assistantMsg),
          },
        );
        if (result && typeof result === "object" && "kind" in result && result.kind === "err") {
          getLogger().warn("Memory storeConversation failed", {
            chatId,
            error: String((result as { error: unknown }).error),
          });
        }
      }
    } catch (error) {
      getLogger().warn("Memory persistence failed", {
        chatId,
        error: error instanceof Error ? error.message : String(error),
      });
    }

    // Fire-and-forget disk persistence
    if (this.deps.sessionsDir) {
      const sessionForDisk = this.sessions.get(chatId);
      if (sessionForDisk) {
        this.persistSessionToDisk(chatId, sessionForDisk).catch((err) => {
          getLogger().debug("Session disk persist failed", {
            chatId,
            error: err instanceof Error ? err.message : String(err),
          });
        });
      }
    }
  }

  persistExecutionMemory(scopeKey: string, executionJournal: ExecutionJournal): void {
    if (!this.deps.taskExecutionStore) {
      return;
    }
    try {
      this.deps.taskExecutionStore.updateExecutionSnapshot(scopeKey, executionJournal.snapshot());
    } catch (error) {
      getLogger().warn("Execution memory persistence failed", {
        scopeKey,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Create a MemoryRefresher if re-retrieval is enabled, seeded with initial content hashes.
   * Returns null when re-retrieval is disabled.
   *
   * `chatId` (Codex round 6 #15) scopes the refresher's recall to the chat it
   * serves; without it the refresher falls back to the chat id the loop
   * passes per `refresh()` call, so chat A's re-retrieval never recalls chat B.
   */
  createMemoryRefresher(
    initialContentHashes: string[],
    chatId?: string,
    /**
     * Who the run belongs to (item 3.9 / audit 05.cap / 13F4 / D66): in-run
     * re-retrieval is automatic recall, so it must be scoped to the person and
     * the project, not to the chat alone.
     */
    identity?: { readonly userId?: string; readonly projectId?: string },
  ): MemoryRefresher | null {
    if (!this.deps.reRetrievalConfig?.enabled) return null;
    const refresher = new MemoryRefresher(this.deps.reRetrievalConfig, {
      chatId,
      ...(identity?.userId ? { userId: identity.userId } : {}),
      ...(identity?.projectId ? { projectId: identity.projectId } : {}),
      memoryManager: this.deps.memoryManager,
      ragPipeline: this.deps.ragPipeline,
      instinctRetriever: this.deps.instinctRetriever ?? undefined,
      embeddingProvider: this.deps.embeddingProvider,
      eventBus: this.deps.eventEmitter ?? undefined,
    });
    if (initialContentHashes.length > 0) {
      refresher.seedContentHashes(initialContentHashes);
    }
    return refresher;
  }

  /**
   * Put trees back after a message that was neither "resume" nor "discard"
   * (2026-09-10). take() removed the offer from memory, so any other first
   * message silently dropped the interrupted trees: their rows stayed
   * `executing` in goal storage forever and the offer was never made again
   * until the next boot.
   */
  restorePendingResumeTrees(conversationScope: string, trees: GoalTree[]): void {
    if (trees.length === 0) return;
    const existing = this.deps.pendingResumeTrees.get(conversationScope) ?? [];
    this.deps.pendingResumeTrees.set(conversationScope, [...trees, ...existing.filter((t) => !trees.some((p) => p.rootId === t.rootId))]);
  }

  takePendingResumeTrees(conversationScope: string, chatId: string): GoalTree[] {
    const scoped = this.deps.pendingResumeTrees.get(conversationScope);
    if (scoped && scoped.length > 0) {
      this.deps.pendingResumeTrees.delete(conversationScope);
      return scoped;
    }

    if (conversationScope !== chatId) {
      const legacyChatScoped = this.deps.pendingResumeTrees.get(chatId);
      if (legacyChatScoped && legacyChatScoped.length > 0) {
        this.deps.pendingResumeTrees.delete(chatId);
        return legacyChatScoped;
      }
    }

    return [];
  }

  // ── Plan review / write-rejection visible text ──────────────────────────

  formatPlanReviewMessage(draft: string): string {
    return [
      "Plan review requested before execution.",
      "",
      draft.trim(),
      "",
      "Reply with your approval or requested changes before write-capable execution continues.",
    ].join("\n");
  }

  /**
   * When the model's end-turn draft is a low-signal ack AND the session carries a self-managed
   * write REJECTION (a tool_result "Self-managed write review rejected …") with no safer bounded
   * replacement produced in the same turn, surface WHY execution stopped. Restored + rewired onto
   * the v2 end-turn boundary (portDispatchEndTurn) — v1 checked it via the deleted checkPendingBlocks
   * inside the loops (cutover Step 5); the FLIP left it unsurfaced until now.
   */
  /** Rejections already reported, so one refusal cannot end several turns. */
  private readonly consumedWriteRejections = new Set<string>();

  getPendingSelfManagedWriteRejectionVisibleText(
    session: Session,
    draft: string | null | undefined,
    /**
     * Which tools can write. A successful write-capable tool result AFTER the
     * rejection is the "safer bounded replacement" the review asked for, and
     * the rejection is then resolved, not pending. Defaults to a name
     * heuristic when the caller has no tool metadata.
     */
    isWriteCapable: (toolName: string) => boolean = defaultIsWriteCapable,
  ): string | null {
    const normalizedDraft = stripInternalDecisionMarkers(draft ?? "").trim();
    // An empty draft is not an acknowledgement. The guard used to read "if there
    // IS a draft and it is not an ack, bail", so an empty one fell straight
    // through — and a bare DONE/CONTINUE reflection normalizes to empty, which
    // is a real boundary. The run was then told a rejection had stopped it when
    // nothing had.
    if (!normalizedDraft || !LOW_SIGNAL_EXECUTION_ACK_RE.test(normalizedDraft)) {
      return null;
    }

    for (let index = session.messages.length - 1; index >= 0; index -= 1) {
      const message = session.messages[index];
      if (!message || message.role !== "user" || !Array.isArray(message.content)) {
        continue;
      }

      for (let blockIndex = message.content.length - 1; blockIndex >= 0; blockIndex -= 1) {
        const block = message.content[blockIndex];
        if (!block || block.type !== "tool_result" || typeof block.content !== "string") {
          continue;
        }
        if (!block.content.startsWith("Self-managed write review rejected")) {
          continue;
        }
        // RESOLVED BY A LATER SUCCESSFUL WRITE. The scan walked backwards over
        // everything after the rejection, so a shell write that was refused
        // and then replaced by a successful dedicated-tool edit still ended
        // the turn as "stopped" — and, once "blocked" became a terminal
        // status, sent a finished task into a retry (Codex 2026-09-17 on
        // e450df2e #2).
        if (writeSucceededAfter(session, index, blockIndex, isWriteCapable)) {
          continue;
        }

        // Each rejection stops the run once. The scan walks the whole history
        // with no turn boundary, so without this a single old rejection ended
        // every later turn as well — measured as four "execution stopped"
        // reports in one run from far fewer refusals.
        const fingerprint = block.content.slice(0, 200);
        if (this.consumedWriteRejections.has(fingerprint)) continue;
        this.consumedWriteRejections.add(fingerprint);

        const match = block.content.match(
          /for '([^']+)':\s*(.+?)\.\s*Choose a safer bounded operation/iu,
        );
        const toolName = match?.[1] ?? "write-capable action";
        const reason = match?.[2]?.trim() ?? block.content.trim();
        return [
          `Execution stopped because the proposed '${toolName}' operation was rejected by autonomous safety review.`,
          "",
          `Reason: ${reason}.`,
          "",
          // The old closing line said "No safer bounded replacement was produced
          // in the same turn", which described a capability that does not exist:
          // nothing in the system can synthesize a replacement command, and the
          // review contract has no field to carry one. Saying what the run can
          // actually do is more use than reporting the absence of a machine that
          // was never built.
          "The reason above is the guidance you have. Propose a narrower command " +
            "that does only what the task needs, or use a dedicated tool instead of the shell.",
        ].join("\n");
      }
    }

    return null;
  }

  getPendingPlanReviewVisibleText(chatId: string): string | null {
    const gate = this.deps.interactionPolicy.get(chatId);
    if (gate?.kind !== "plan-review-required") {
      return null;
    }
    if (gate.planText?.trim()) {
      return this.formatPlanReviewMessage(gate.planText);
    }
    return [
      "Plan review requested before execution.",
      "",
      "A concrete plan still needs to be shown before write-capable execution continues.",
      "",
      "Reply with your approval or requested changes before write-capable execution continues.",
    ].join("\n");
  }


  formatBoundaryVisibleText(decision: InteractionBoundaryDecision): string | undefined {
    if (!decision.visibleText) {
      return undefined;
    }
    return decision.kind === "plan_review"
      ? this.formatPlanReviewMessage(decision.visibleText)
      : decision.visibleText;
  }

  // ── Cleanup ──────────────────────────────────────────────────────────────

  /**
   * Clean up expired sessions (call periodically).
   * Returns the list of expired chatIds so callers can clean up associated state.
   */
  cleanupSessions(maxAgeMs: number = 3600_000): string[] {
    const now = Date.now();
    const expired: string[] = [];
    for (const [chatId, session] of this.sessions) {
      if (now - session.lastActivity.getTime() > maxAgeMs) {
        // Skip sessions with active locks — they are currently being processed
        if (this.sessionLocks.has(chatId)) continue;

        // Session-end summarization (fire-and-forget)
        const visibleMessages = this.getVisibleTranscript(session);
        if (this.deps.sessionSummarizer && visibleMessages.length >= 2) {
          void this.deps.sessionSummarizer
            .summarizeAndUpdateProfile(session.profileKey ?? chatId, visibleMessages)
            .catch(() => {
              // Session summarization failure is non-fatal
            });
        }
        // Persist before cleanup (forced — session is being evicted)
        void this.persistSessionToMemory(chatId, visibleMessages.slice(-10), /* force */ true);
        this.lastPersistTime.delete(chatId);
        this.sessions.delete(chatId);
        this.deps.activeGoalTrees.delete(session.conversationScope ?? chatId);
        expired.push(chatId);
      }
    }
    return expired;
  }
}
