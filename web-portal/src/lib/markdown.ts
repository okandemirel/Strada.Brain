import type { PluggableList } from 'unified'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import rehypeHighlight from 'rehype-highlight'
import rehypeKatex from 'rehype-katex'
import rehypeSanitize, { defaultSchema } from 'rehype-sanitize'
import {
  remarkObsidianComments,
  remarkObsidianHighlight,
  remarkObsidianWikiLinks,
} from './obsidian-markdown'
import 'katex/dist/katex.min.css'

/**
 * Shared markdown plugin stack used by every markdown surface in the portal
 * (chat messages, vault note previews). Consolidated here so feature/parity
 * fixes apply consistently everywhere instead of drifting between copies.
 */
export const REMARK_PLUGINS: PluggableList = [
  remarkGfm,
  remarkMath,
  remarkObsidianComments,
  remarkObsidianHighlight,
  remarkObsidianWikiLinks,
]

/**
 * Sanitize schema extension.
 *
 * rehype-sanitize runs FIRST (see REHYPE_PLUGINS) so untrusted markdown is
 * cleaned before the trusted transformers decorate it. We must, however,
 * preserve the wrappers remark-math emits — `<span class="math math-inline">`
 * and `<div class="math math-display">` — so that rehype-katex (which runs
 * afterwards) can find and render them. Allowing `className` on these inline
 * containers keeps math markers, hljs code classes and our own internal-link /
 * callout classes intact. className alone is not an injection vector — no
 * `style`/`on*` attributes are permitted by the default schema.
 */
const sanitizeSchema = {
  ...defaultSchema,
  // <mark> (our ==highlight== output) is not in the default allow-list.
  tagNames: [...(defaultSchema.tagNames ?? []), 'mark'],
  attributes: {
    ...defaultSchema.attributes,
    span: [...(defaultSchema.attributes?.span ?? []), 'className'],
    div: [...(defaultSchema.attributes?.div ?? []), 'className'],
    code: [...(defaultSchema.attributes?.code ?? []), 'className'],
    pre: [...(defaultSchema.attributes?.pre ?? []), 'className'],
  },
}

/**
 * Order matters:
 *  1. rehype-sanitize — clean untrusted content first (raw HTML is already
 *     disabled by react-markdown; this strips dangerous attributes/URLs and
 *     keeps the math/code class markers via the schema above).
 *  2. rehype-katex — render `$…$` / `$$…$$` math (trusted output, not
 *     re-sanitized).
 *  3. rehype-highlight — add `hljs-*` spans to code (trusted output). If this
 *     ran before sanitize its classes would be stripped, killing highlighting.
 */
export const REHYPE_PLUGINS: PluggableList = [
  [rehypeSanitize, sanitizeSchema],
  rehypeKatex,
  rehypeHighlight,
]
