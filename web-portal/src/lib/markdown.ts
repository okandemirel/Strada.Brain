import remarkGfm from 'remark-gfm'
import rehypeHighlight from 'rehype-highlight'
import rehypeSanitize from 'rehype-sanitize'

/**
 * Shared markdown plugin stack used by every markdown surface in the portal
 * (chat messages, vault note previews). Consolidated here so feature/parity
 * fixes apply consistently everywhere instead of drifting between copies.
 */
export const REMARK_PLUGINS = [remarkGfm]

/**
 * rehype-sanitize MUST run BEFORE rehype-highlight.
 *
 * rehype-highlight wraps code tokens in `<span class="hljs-…">`. If sanitize
 * ran last it would strip those classes (the schema doesn't allow them),
 * silently killing all syntax highlighting. Running sanitize first cleans the
 * markdown-derived tree, then highlight decorates the already-safe code with
 * its trusted spans, which survive because nothing sanitizes them afterwards.
 */
export const REHYPE_PLUGINS = [rehypeSanitize, rehypeHighlight]
