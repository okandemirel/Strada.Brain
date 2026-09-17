/**
 * Shared retrieval filters — ONE layer for every retrieval path.
 *
 * Plan 0-B.9 (audit 05.cap + Codex #18) / 3.9 (3.11: 05.cap / 13F4 / D66):
 * the HNSW path honoured `chatId / type / tier / domain` while the TF-IDF
 * fallback only looked at `mode: "chat"` / `mode: "type"`, so a provider
 * outage silently widened every filtered query. Both paths (and the legacy
 * FileMemoryManager) now call `matchesRetrievalFilters`, so the fallback
 * returns exactly the filtered set the vector path would have returned.
 *
 * Identity scope (plan 3.9): `retrieve` takes `{ userId?, chatId?, projectId? }`.
 * An entry is out of scope when it carries a DIFFERENT identity for a key the
 * scope names. An entry that carries NO userId/projectId for that key stays in.
 * Project knowledge (`type: "project"`) is never personal recall: it is only
 * returned when the caller asks for the type explicitly or the scope names
 * its projectId.
 *
 * Chat ownership (Codex round 6 #16): chatId "default"/missing means UNKNOWN
 * ownership (an imported legacy conversation, a row written before chat ids
 * existed) — it used to be treated as shared and returned to every scoped
 * chat. Now only an entry marked explicitly shared (`shared: true` or
 * `metadata.shared === true`) crosses chats; an unowned entry is returned
 * only when no chat scope is given or the scope's chatId is itself "default".
 *
 * No `quarantineUnownedEntries()` backfill: the rule is evaluated at read
 * time, so no row has to change for it to hold; unowned rows stay reachable
 * through unscoped queries and the "default" scope; and a backfill could only
 * stamp an owner it does not know — exactly the leak #16 forbids. An
 * explicit share is a deliberate write (`shared: true`), never a migration.
 */

import type {
  MemoryEntryType,
  MemoryImportance,
  MemoryScope,
  RetrievalOptions,
} from "./memory.interface.js";

/** The chatId storeEntry assigns when a caller passes none — treated as "no chat". */
export const UNSCOPED_CHAT_ID = "default";

/** Project-knowledge entry type — excluded from personal recall (plan 3.9). */
export const PROJECT_MEMORY_TYPE: MemoryEntryType = "project";

/**
 * Structural view of an entry for filtering — both MemoryEntry (file backend)
 * and UnifiedMemoryEntry (AgentDB) satisfy it without a cast.
 */
export interface FilterableEntry {
  readonly type: MemoryEntryType;
  readonly tags: readonly string[];
  readonly importance: MemoryImportance;
  readonly archived: boolean;
  readonly createdAt: number;
  readonly chatId?: string;
  readonly userId?: string;
  readonly projectId?: string;
  /** Explicitly shared across chats (Codex round 6 #16) — also metadata.shared. */
  readonly shared?: boolean;
  readonly domain?: string;
  readonly tier?: string;
  readonly importanceScore?: number;
  readonly expiresAt?: number;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

/** Every filter any retrieval path understands, flattened. */
export interface RetrievalFilters {
  readonly chatId?: string;
  readonly type?: MemoryEntryType;
  readonly types?: readonly MemoryEntryType[];
  readonly tier?: string;
  readonly domain?: string;
  readonly minImportance?: number;
  readonly includeExpired?: boolean;
  readonly tags?: readonly string[];
  readonly importance?: readonly MemoryImportance[];
  readonly includeArchived?: boolean;
  readonly after?: number;
  readonly before?: number;
  readonly scope?: MemoryScope;
}

/** Options shape accepted by every retrieval entry point (RetrievalOptions or UnifiedMemoryQuery). */
export type RetrievalFilterSource = RetrievalOptions | (RetrievalFilters & { readonly mode?: string });

function readOpt<T>(options: object, key: string): T | undefined {
  return (options as Record<string, unknown>)[key] as T | undefined;
}

/**
 * Normalize RetrievalOptions (discriminated on `mode`) and UnifiedMemoryQuery
 * (flat) into one RetrievalFilters. `mode: "chat"` contributes chatId,
 * `mode: "type"` contributes types, and every flat field is read as-is.
 */
export function toRetrievalFilters(options: RetrievalFilterSource): RetrievalFilters {
  const mode = readOpt<string>(options, "mode");
  const chatId = readOpt<string>(options, "chatId");
  const types = readOpt<readonly MemoryEntryType[]>(options, "types");
  return {
    // chatId is a filter in every mode that carries one (UnifiedMemoryQuery.chatId
    // and ChatRetrievalOptions.chatId) — mode "chat" used to be the only reader.
    chatId: chatId ?? undefined,
    type: readOpt<MemoryEntryType>(options, "type"),
    types: mode === "type" || types ? types : undefined,
    tier: readOpt<string>(options, "tier"),
    domain: readOpt<string>(options, "domain"),
    minImportance: readOpt<number>(options, "minImportance"),
    includeExpired: readOpt<boolean>(options, "includeExpired"),
    tags: readOpt<readonly string[]>(options, "tags"),
    importance: readOpt<readonly MemoryImportance[]>(options, "importance"),
    includeArchived: readOpt<boolean>(options, "includeArchived"),
    after: readOpt<number>(options, "after"),
    before: readOpt<number>(options, "before"),
    scope: readOpt<MemoryScope>(options, "scope"),
  };
}

/** True when any filter that narrows the candidate set is active. */
export function hasActiveFilters(filters: RetrievalFilters): boolean {
  return (
    filters.chatId !== undefined ||
    filters.type !== undefined ||
    (filters.types !== undefined && filters.types.length > 0) ||
    filters.tier !== undefined ||
    filters.domain !== undefined ||
    filters.minImportance !== undefined ||
    (filters.tags !== undefined && filters.tags.length > 0) ||
    (filters.importance !== undefined && filters.importance.length > 0) ||
    filters.includeArchived === false ||
    filters.after !== undefined ||
    filters.before !== undefined ||
    filters.scope !== undefined
  );
}

function entryIdentity(entry: FilterableEntry, key: "userId" | "projectId"): string | undefined {
  const direct = entry[key];
  if (typeof direct === "string" && direct.length > 0) return direct;
  const fromMeta = entry.metadata?.[key];
  return typeof fromMeta === "string" && fromMeta.length > 0 ? fromMeta : undefined;
}

/** True when the entry was deliberately shared with every chat (Codex round 6 #16). */
export function isExplicitlyShared(entry: FilterableEntry): boolean {
  return entry.shared === true || entry.metadata?.["shared"] === true;
}

/** True when nobody recorded which chat owns the entry (chatId "default" or missing). */
export function isUnownedByChat(entry: FilterableEntry): boolean {
  return entry.chatId === undefined || entry.chatId === UNSCOPED_CHAT_ID;
}

/**
 * Identity scope check (plan 3.9). A userId/projectId the entry does not carry
 * is not a mismatch; a DIFFERENT value is. For chatId (Codex round 6 #16) an
 * unowned entry matches only the "default" scope unless explicitly shared.
 */
export function matchesScope(entry: FilterableEntry, scope: MemoryScope | undefined): boolean {
  if (!scope) return true;
  if (isExplicitlyShared(entry)) return true;
  if (scope.chatId !== undefined) {
    const scopeChat = String(scope.chatId);
    if (isUnownedByChat(entry)) {
      if (scopeChat !== UNSCOPED_CHAT_ID) return false;
    } else if (entry.chatId !== scopeChat) {
      return false;
    }
  }
  if (scope.userId !== undefined) {
    const entryUser = entryIdentity(entry, "userId");
    if (entryUser !== undefined && entryUser !== String(scope.userId)) return false;
  }
  if (scope.projectId !== undefined) {
    const entryProject = entryIdentity(entry, "projectId");
    if (entryProject !== undefined && entryProject !== String(scope.projectId)) return false;
  }
  return true;
}

/**
 * Project knowledge is a distinct type and never personal recall: it is
 * returned only when asked for by type, or when the scope names its project.
 */
function projectTypeAllowed(entry: FilterableEntry, filters: RetrievalFilters): boolean {
  if (entry.type !== PROJECT_MEMORY_TYPE) return true;
  if (filters.type === PROJECT_MEMORY_TYPE) return true;
  if (filters.types?.includes(PROJECT_MEMORY_TYPE)) return true;
  const scopedProject = filters.scope?.projectId;
  if (scopedProject !== undefined) {
    const entryProject = entryIdentity(entry, "projectId");
    return entryProject !== undefined && entryProject === String(scopedProject);
  }
  return false;
}

/**
 * The one filter every retrieval path applies (vector, TF-IDF fallback, file
 * backend). `now` is injectable so expiry is testable.
 */
export function matchesRetrievalFilters(
  entry: FilterableEntry,
  filters: RetrievalFilters,
  now: number = Date.now(),
): boolean {
  if (filters.chatId !== undefined && entry.chatId !== undefined && entry.chatId !== filters.chatId) {
    return false;
  }
  if (filters.type !== undefined && entry.type !== filters.type) return false;
  if (filters.types !== undefined && filters.types.length > 0 && !filters.types.includes(entry.type)) {
    return false;
  }
  if (filters.tier !== undefined && entry.tier !== filters.tier) return false;
  if (filters.domain !== undefined && entry.domain !== filters.domain) return false;
  if (
    filters.minImportance !== undefined &&
    (entry.importanceScore ?? 0) < filters.minImportance
  ) {
    return false;
  }
  if (!filters.includeExpired && entry.expiresAt !== undefined && now > entry.expiresAt) return false;
  if (filters.tags && filters.tags.length > 0 && !filters.tags.every((tag) => entry.tags.includes(tag))) {
    return false;
  }
  if (filters.importance && filters.importance.length > 0 && !filters.importance.includes(entry.importance)) {
    return false;
  }
  if (filters.includeArchived === false && entry.archived) return false;
  if (filters.after !== undefined && entry.createdAt < filters.after) return false;
  if (filters.before !== undefined && entry.createdAt > filters.before) return false;
  if (!projectTypeAllowed(entry, filters)) return false;
  return matchesScope(entry, filters.scope);
}
