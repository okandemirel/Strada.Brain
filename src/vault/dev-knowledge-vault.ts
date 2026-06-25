import { UnityProjectVault } from './unity-project-vault.js';

/**
 * Dedicated, per-project "living" knowledge vault.
 *
 * Rooted at `<projectRoot>/.strada/knowledge/`, it accumulates dev-time
 * knowledge (task-completion notes, learned heuristics, clean-success verdicts)
 * so the agent improves incrementally across sessions. It reuses the entire
 * hardened {@link UnityProjectVault} engine (SQLite store, FTS, RRF fusion,
 * symbol/wikilink extraction, watcher, write-path sanitization) verbatim.
 *
 * Why a distinct `kind`: the code write-hook selector
 * (`Orchestrator.maybeFireVaultWriteHook`) binds to the FIRST
 * `kind === 'unity-project'` vault. A vanilla second UnityProjectVault would
 * also report `'unity-project'` and could be grabbed instead of the real code
 * vault — firing a reindex against the wrong root (which `afterWrite` then
 * silently rejects). The `'knowledge'` kind keeps that filter unambiguous and
 * makes the vault distinguishable in the portal/stats.
 */
export class DevKnowledgeVault extends UnityProjectVault {
  override readonly kind = 'knowledge' as const;
}
