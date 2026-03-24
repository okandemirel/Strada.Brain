import { useMemo, useRef, useEffect, useState, useCallback } from 'react'
import { useShiki, resolveLanguage } from './useShiki'

interface CodeViewerProps {
  content: string
  language: string
  changedLines?: Set<number>
}

export default function CodeViewer({ content, language, changedLines }: CodeViewerProps) {
  const { highlighter, isLoading } = useShiki()
  const scrollRef = useRef<HTMLDivElement>(null)
  const [searchOpen, setSearchOpen] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [activeMatch, setActiveMatch] = useState(0)

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'f') {
        e.preventDefault()
        setSearchOpen(true)
      }
      if (e.key === 'Escape') setSearchOpen(false)
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [])

  const lines = useMemo(() => content.split('\n'), [content])

  const highlightedLines = useMemo(() => {
    if (!highlighter) return null
    const lang = resolveLanguage(language)
    try {
      const tokens = highlighter.codeToTokens(content, { lang, theme: 'vitesse-dark' })
      return tokens.tokens
    } catch {
      return null
    }
  }, [highlighter, content, language])

  const matches = useMemo(() => {
    if (!searchQuery) return []
    const result: { line: number; start: number; end: number }[] = []
    const query = searchQuery.toLowerCase()
    lines.forEach((line, i) => {
      let idx = 0
      const lower = line.toLowerCase()
      while ((idx = lower.indexOf(query, idx)) !== -1) {
        result.push({ line: i, start: idx, end: idx + query.length })
        idx += query.length
      }
    })
    return result
  }, [lines, searchQuery])

  const navigateMatch = useCallback((dir: 1 | -1) => {
    if (matches.length === 0) return
    setActiveMatch((prev) => (prev + dir + matches.length) % matches.length)
  }, [matches.length])

  useEffect(() => {
    if (matches.length === 0 || !scrollRef.current) return
    const match = matches[activeMatch]
    if (!match) return
    const lineEl = scrollRef.current.querySelector(`[data-line="${match.line}"]`)
    lineEl?.scrollIntoView({ block: 'center', behavior: 'smooth' })
  }, [activeMatch, matches])

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-full text-text-tertiary text-sm animate-pulse">
        Loading syntax highlighter...
      </div>
    )
  }

  return (
    <div className="relative h-full flex flex-col bg-[#121212]">
      {searchOpen && (
        <div className="absolute top-2 right-4 z-10 flex items-center gap-1.5 px-3 py-1.5 bg-bg-secondary/90 backdrop-blur-xl border border-white/10 rounded-lg shadow-lg">
          <input
            autoFocus
            value={searchQuery}
            onChange={(e) => { setSearchQuery(e.target.value); setActiveMatch(0) }}
            placeholder="Search..."
            className="bg-transparent text-xs text-text outline-none w-40 placeholder:text-text-tertiary"
          />
          {matches.length > 0 && (
            <span className="text-[10px] text-text-tertiary whitespace-nowrap">
              {activeMatch + 1}/{matches.length}
            </span>
          )}
          <button onClick={() => navigateMatch(-1)} className="text-text-tertiary hover:text-text text-xs px-1">&uarr;</button>
          <button onClick={() => navigateMatch(1)} className="text-text-tertiary hover:text-text text-xs px-1">&darr;</button>
          <button onClick={() => setSearchOpen(false)} className="text-text-tertiary hover:text-text text-xs px-1">&times;</button>
        </div>
      )}

      <div ref={scrollRef} className="flex-1 overflow-auto font-mono text-sm leading-[20px]">
        <table className="border-collapse w-full">
          <tbody>
            {lines.map((line, i) => {
              const isChanged = changedLines?.has(i + 1)
              const tokens = highlightedLines?.[i]

              return (
                <tr
                  key={i}
                  data-line={i}
                  className={`group hover:bg-white/[0.03] ${isChanged ? 'bg-[rgba(0,229,255,0.06)] transition-colors duration-1000' : ''}`}
                >
                  <td className="select-none text-right pr-4 pl-4 text-text-tertiary/50 text-xs w-[1%] whitespace-nowrap align-top sticky left-0 bg-[#0e0e12]">
                    {i + 1}
                  </td>
                  <td className="pr-4 whitespace-pre overflow-visible">
                    {tokens ? (
                      <span>
                        {tokens.map((token, j) => (
                          <span key={j} style={{ color: token.color }}>{token.content}</span>
                        ))}
                      </span>
                    ) : (
                      <span className="text-text">{line}</span>
                    )}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}
