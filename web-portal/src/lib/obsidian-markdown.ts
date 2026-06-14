import { visit, SKIP } from 'unist-util-visit'
import type { Plugin } from 'unified'
import type {
  Root, Text, Parent, PhrasingContent, Blockquote, Paragraph, Table, TableRow, TableCell,
} from 'mdast'

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

function elementCarrier(
  hName: string,
  content: string,
  className?: string,
  extraProps?: Record<string, unknown>,
): PhrasingContent {
  const hProperties = {
    ...(className ? { className: [className] } : {}),
    ...(extraProps ?? {}),
  }
  return {
    type: 'emphasis',
    children: [text(content)],
    data: {
      hName,
      ...(Object.keys(hProperties).length > 0 ? { hProperties } : {}),
    },
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
    // Carry the resolved target so the viewer can navigate on click. The
    // attribute is inert (no URL/handler) — a delegated click handler reads it.
    return elementCarrier('span', alias || target, 'obsidian-wikilink', { dataWikilinkTarget: target })
  })
}

/**
 * Obsidian callouts: a blockquote whose first line is `[!type] …` becomes a
 * styled `<div class="obsidian-callout callout-{type}">` with a title row,
 * instead of rendering the raw `[!type]` text inside a plain blockquote.
 * (Styling lives in globals.css so it doesn't depend on Tailwind class
 * scanning of this .ts file.)
 */
export const remarkObsidianCallouts: Plugin<[], Root> = () => (tree) => {
  visit(tree, 'blockquote', (node: Blockquote) => {
    const firstPara = node.children[0]
    if (!firstPara || firstPara.type !== 'paragraph') return
    const firstText = firstPara.children[0]
    if (!firstText || firstText.type !== 'text') return
    const marker = /^\[!(\w+)\]([+-]?)[ \t]*/.exec(firstText.value)
    if (!marker) return
    const type = (marker[1] ?? 'note').toLowerCase()
    // Strip only the `[!type]` marker; any custom title text stays in the body.
    firstText.value = firstText.value.slice(marker[0].length)
    const titleBlock: Paragraph = {
      type: 'paragraph',
      children: [text(type)],
      data: { hName: 'div', hProperties: { className: ['callout-title'] } },
    }
    node.children.unshift(titleBlock)
    node.data = {
      hName: 'div',
      hProperties: { className: ['obsidian-callout', `callout-${type}`] },
    }
  })
}

function parseSimpleFrontmatter(src: string): Array<{ key: string; value: string }> {
  const rows: Array<{ key: string; value: string }> = []
  for (const rawLine of src.split('\n')) {
    // Skip blanks, comments, list items and nested (indented) lines — this is a
    // lightweight key:value view, not a full YAML parser.
    if (!rawLine.trim() || rawLine.trimStart().startsWith('#') || rawLine.trimStart().startsWith('-') || /^\s/.test(rawLine)) {
      continue
    }
    const colon = rawLine.indexOf(':')
    if (colon <= 0) continue
    const key = rawLine.slice(0, colon).trim()
    let value = rawLine.slice(colon + 1).trim()
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    }
    rows.push({ key, value })
  }
  return rows
}

function cell(value: string): TableCell {
  return { type: 'tableCell', children: [text(value)] }
}

/**
 * Frontmatter handling. remark-frontmatter parses the leading `---…---` block
 * into a `yaml` node (so it is no longer dumped as a raw `hr`/heading mess).
 * This transform turns that node into a small Property/Value table, echoing
 * Obsidian's "properties" panel. Empty/unparseable frontmatter is just removed.
 */
export const remarkFrontmatterProperties: Plugin<[], Root> = () => (tree) => {
  const idx = tree.children.findIndex((n) => (n as { type: string }).type === 'yaml')
  if (idx === -1) return
  const yamlNode = tree.children[idx] as unknown as { value?: string }
  const rows = parseSimpleFrontmatter(yamlNode.value ?? '')
  if (rows.length === 0) {
    tree.children.splice(idx, 1)
    return
  }
  const header: TableRow = { type: 'tableRow', children: [cell('Property'), cell('Value')] }
  const body: TableRow[] = rows.map((r) => ({ type: 'tableRow', children: [cell(r.key), cell(r.value)] }))
  const table: Table = { type: 'table', align: [null, null], children: [header, ...body] }
  tree.children.splice(idx, 1, table as unknown as Root['children'][number])
}
