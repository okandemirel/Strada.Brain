import { visit, SKIP } from 'unist-util-visit'
import type { Plugin } from 'unified'
import type { Root, Text, Parent, PhrasingContent } from 'mdast'

/**
 * Custom remark plugins that bring Obsidian-flavoured inline syntax to the
 * portal's markdown renderer so notes look the same on the web as they do in
 * Obsidian instead of leaking raw `[[ ]]`, `== ==`, `%% %%` and `![[ ]]`.
 *
 * They operate on mdast text nodes (so fenced/inline code is untouched — those
 * are literal nodes without text children) and emit element "carriers": an
 * `emphasis` node whose `data.hName`/`hProperties` override the output tag, the
 * reliable mdast-util-to-hast mechanism for custom elements. The resulting
 * `<mark>` / `<span class="…">` survive rehype-sanitize (see markdown.ts).
 */

function text(value: string): Text {
  return { type: 'text', value }
}

function elementCarrier(hName: string, content: string, className?: string): PhrasingContent {
  return {
    type: 'emphasis',
    children: [text(content)],
    data: { hName, ...(className ? { hProperties: { className: [className] } } : {}) },
  }
}

function splitTextNodes(
  tree: Root,
  pattern: RegExp,
  build: (match: RegExpExecArray) => PhrasingContent | null,
): void {
  visit(tree, 'text', (node: Text, index, parent: Parent | undefined) => {
    if (!parent || index === undefined) return
    const value = node.value
    const re = new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`)
    const replacement: PhrasingContent[] = []
    let lastIndex = 0
    let matchCount = 0
    let match: RegExpExecArray | null
    while ((match = re.exec(value)) !== null) {
      matchCount++
      if (match.index > lastIndex) replacement.push(text(value.slice(lastIndex, match.index)))
      const built = build(match)
      if (built) replacement.push(built)
      lastIndex = match.index + match[0].length
      if (match[0].length === 0) re.lastIndex++
    }
    if (matchCount === 0) return
    if (lastIndex < value.length) replacement.push(text(value.slice(lastIndex)))
    parent.children.splice(index, 1, ...replacement)
    return [SKIP, index + replacement.length]
  })
}

/** Strip Obsidian comments `%%…%%` (inline) — they must never reach the reader. */
export const remarkObsidianComments: Plugin<[], Root> = () => (tree) => {
  splitTextNodes(tree, /%%[^\n]*?%%/g, () => null)
}

/** `==text==` → `<mark>text</mark>`. */
export const remarkObsidianHighlight: Plugin<[], Root> = () => (tree) => {
  splitTextNodes(tree, /==([^=\n]+)==/g, (m) => elementCarrier('mark', m[1] ?? ''))
}

/**
 * `[[Target|Alias]]` → styled wikilink span showing the alias; `![[target]]` →
 * a labelled embed placeholder (true transclusion needs vault file-serving,
 * which the web portal does not have — so we render a recognisable marker
 * rather than the raw `![[ ]]` text).
 */
export const remarkObsidianWikiLinks: Plugin<[], Root> = () => (tree) => {
  splitTextNodes(tree, /(!?)\[\[([^\]\n]+)\]\]/g, (m) => {
    const isEmbed = m[1] === '!'
    const inner = (m[2] ?? '').trim()
    const [rawTarget, rawAlias] = inner.split('|')
    const target = (rawTarget ?? '').trim()
    const alias = (rawAlias ?? rawTarget ?? '').trim()
    if (!target) return null
    if (isEmbed) return elementCarrier('span', `↪ ${alias || target}`, 'obsidian-embed')
    return elementCarrier('span', alias || target, 'obsidian-wikilink')
  })
}
