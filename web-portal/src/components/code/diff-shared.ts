import type { HighlighterCore } from 'shiki/core'

export type Token = { content: string; color?: string }

export function splitLines(value: string): string[] {
  const trimmed = value.replace(/\n$/, '')
  if (trimmed.length === 0) return ['']
  return trimmed.split('\n')
}

export function makeTokenRenderer(
  highlighter: HighlighterCore,
  lang: string,
): (line: string) => Token[] {
  return (line: string): Token[] => {
    try {
      const tokenized = highlighter.codeToTokens(line, { lang, theme: 'vitesse-dark' })
      return tokenized.tokens[0]?.length ? tokenized.tokens[0] : [{ content: line || ' ' }]
    } catch {
      return [{ content: line || ' ' }]
    }
  }
}
