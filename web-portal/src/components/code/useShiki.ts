import { useState, useEffect } from 'react'
import { createHighlighterCore, type HighlighterCore } from 'shiki/core'
import { createJavaScriptRegexEngine } from 'shiki/engine/javascript'

type Highlighter = HighlighterCore

let highlighterPromise: Promise<Highlighter> | null = null
let cachedHighlighter: Highlighter | null = null

function getHighlighter(): Promise<Highlighter> {
  if (cachedHighlighter) return Promise.resolve(cachedHighlighter)
  if (!highlighterPromise) {
    highlighterPromise = createHighlighterCore({
      engine: createJavaScriptRegexEngine(),
      themes: [import('shiki/themes/vitesse-dark.mjs')],
      langs: [
        import('shiki/langs/csharp.mjs'),
        import('shiki/langs/typescript.mjs'),
        import('shiki/langs/javascript.mjs'),
        import('shiki/langs/json.mjs'),
        import('shiki/langs/xml.mjs'),
        import('shiki/langs/markdown.mjs'),
        import('shiki/langs/yaml.mjs'),
        import('shiki/langs/html.mjs'),
        import('shiki/langs/css.mjs'),
      ],
    }).then((h) => {
      cachedHighlighter = h
      return h
    })
  }
  return highlighterPromise
}

export function useShiki() {
  const [highlighter, setHighlighter] = useState<Highlighter | null>(cachedHighlighter)
  const [isLoading, setIsLoading] = useState(!cachedHighlighter)

  useEffect(() => {
    // If already cached, initial state handles it — no effect needed
    if (cachedHighlighter) return
    let cancelled = false
    getHighlighter().then((h) => {
      if (!cancelled) {
        setHighlighter(h)
        setIsLoading(false)
      }
    })
    return () => { cancelled = true }
  }, [])

  return { highlighter, isLoading }
}

export function resolveLanguage(lang: string): string {
  const map: Record<string, string> = {
    cs: 'csharp', csharp: 'csharp',
    ts: 'typescript', typescript: 'typescript',
    js: 'javascript', javascript: 'javascript',
    json: 'json', xml: 'xml',
    md: 'markdown', markdown: 'markdown',
    yaml: 'yaml', yml: 'yaml',
    html: 'html', css: 'css',
  }
  return map[lang.toLowerCase()] ?? 'plaintext'
}
