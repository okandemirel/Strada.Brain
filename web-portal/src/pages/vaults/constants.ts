/**
 * Vault-scope UI constants.
 *
 * Single source of truth for magic numbers that used to live inline across the
 * vault workspace. Anything that is (a) a UX threshold, (b) a cache/history
 * cap, or (c) a layout budget should live here so QA can tune one file.
 *
 * Adding a new vault constant? Prefer documenting *why* the value was picked.
 */

// ---------------------------------------------------------------------------
// Layout / viewport thresholds
// ---------------------------------------------------------------------------

/** Below this viewport width (px) the right panel auto-collapses on mount. */
export const TABLET_BREAKPOINT_PX = 1100;

// ---------------------------------------------------------------------------
// Recent-items caches (vault-store)
// ---------------------------------------------------------------------------

/** Cap for recently-opened file paths and recently-selected symbol ids. */
export const MAX_RECENT = 10;

/** How many recent items the command palette surfaces in its "Recent" group. */
export const MAX_RECENT_COMMANDS = 5;

// ---------------------------------------------------------------------------
// Graph rendering
// ---------------------------------------------------------------------------

/**
 * Hard cap above which the synchronous force layout is skipped — the main
 * thread would otherwise freeze for multiple seconds on very large graphs.
 */
export const FORCE_LAYOUT_NODE_CAP = 1500;

// ---------------------------------------------------------------------------
// File tree hover preview
// ---------------------------------------------------------------------------

/** Open-delay (ms) for file-preview hover cards — tuned for intentionality. */
export const HOVER_CARD_OPEN_DELAY_MS = 350;

/** Maximum characters loaded into the hover preview (keeps payload small). */
export const HOVER_CARD_PREVIEW_CHARS = 200;

// ---------------------------------------------------------------------------
// Graph cache (vault-store)
// ---------------------------------------------------------------------------

/**
 * LRU cap for the in-memory graph cache. When the user visits a new vault and
 * the cache already holds this many entries, the oldest entry is dropped.
 * Prevents unbounded memory growth for users who page through many vaults in
 * a single session. 5 is a pragmatic middle ground — large enough that
 * real-world navigation never evicts a vault the user is still working with.
 */
export const GRAPH_CACHE_MAX_VAULTS = 5;

// ---------------------------------------------------------------------------
// Right-panel outline rendering
// ---------------------------------------------------------------------------

/** Maximum number of file-group sections rendered in the outline tab. */
export const OUTLINE_MAX_GROUPS = 40;

/** Maximum number of symbols rendered per file-group in the outline tab. */
export const OUTLINE_MAX_ITEMS = 50;
