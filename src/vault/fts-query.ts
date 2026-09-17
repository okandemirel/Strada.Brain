/**
 * Shared FTS5 query helpers used by both vault implementations
 * (ObsidianVault + UnityProjectVault). Kept in one leaf module so the
 * sanitization/tokenization logic cannot drift between the two vaults.
 */

/**
 * Typed error thrown when a vault query is invalid (e.g. empty FTS query).
 * Route handlers should catch and translate to HTTP 400.
 */
export class VaultQueryError extends Error {
  readonly code: string;
  constructor(message: string, code = 'invalid_query') {
    super(message);
    this.name = 'VaultQueryError';
    this.code = code;
  }
}

/**
 * Sanitize an arbitrary user query into a safe FTS5 MATCH expression.
 *
 * - Strips FTS5 special operators AND boolean keywords so user input cannot
 *   inject live query syntax.
 * - Throws {@link VaultQueryError} (`empty_query`) when nothing survives
 *   sanitization, so the route layer returns a 4xx instead of silently
 *   running `""` (which yields no/garbage matches).
 */
export function escapeFtsQuery(q: string): string {
  const stripped = q.replace(/["*:()^+\-]/g, ' ').replace(/\b(NOT|AND|OR|NEAR)\b/g, ' ').trim();
  if (!stripped) {
    throw new VaultQueryError('Vault query is empty after sanitization', 'empty_query');
  }
  // Tokenize on whitespace and quote EACH token individually, joining with the
  // FTS5 `OR` operator. Quoting the WHOLE string as one phrase (`"a b c"`) only
  // matched docs containing that exact contiguous word sequence — so a normal
  // multi-word natural-language question returned 0 rows for nearly every real
  // query. Per-token OR makes the query match ANY term (BM25-ranked), and keeps
  // FTS5 operators inside user input INERT (a token like "OR"/"NEAR"/"*" becomes
  // a quoted literal — the only live operator is the joiner we add), so this is
  // injection-safe. We also OR the full quoted phrase to BOOST exact-phrase docs.
  //
  // `stripped` is already non-empty and .trim()-ed, so the split always yields
  // at least one token — no further empty-guard is needed here.
  const tokens = stripped.split(/\s+/);
  const terms = [...tokens, ...compoundVariants(tokens)];
  const orTokens = terms.map((t) => `"${t}"`).join(' OR ');
  return `(${orTokens}) OR "${stripped}"`;
}

/**
 * The compound identifiers adjacent words could spell (plan 6.7 / D44's
 * measure).
 *
 * The index already stores a camel-split copy of every chunk, so "Update Buff"
 * MATCHES the chunk that defines `UpdateBuff` — but so does every chunk that
 * merely says "update" or "buff" somewhere, and in a real codebase those are
 * everywhere. Measured on the pinned benchmark: the exact-identifier family
 * scored nDCG@10 1.0000 while the same symbols typed as a human types them
 * scored 0.1028, with 22 of 60 queries returning nothing relevant in the top
 * ten. Adding the concatenation gives BM25 the rare token it needs to rank the
 * definition first, without dropping any of the loose matches.
 *
 * Runs of two to four adjacent tokens, ASCII-identifier-shaped only (a
 * concatenation of words that cannot be an identifier is noise).
 */
export function compoundVariants(tokens: readonly string[]): string[] {
  const IDENTIFIER_WORD = /^[A-Za-z_$][\w$]*$/u;
  const out: string[] = [];
  for (let start = 0; start < tokens.length; start++) {
    if (!IDENTIFIER_WORD.test(tokens[start]!)) continue;
    let compound = tokens[start]!;
    for (let end = start + 1; end < Math.min(tokens.length, start + 4); end++) {
      const next = tokens[end]!;
      if (!IDENTIFIER_WORD.test(next)) break;
      compound += next;
      if (!out.includes(compound)) out.push(compound);
    }
  }
  return out;
}
