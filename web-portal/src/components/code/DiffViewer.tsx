import { useMemo } from 'react'
import { useShiki, resolveLanguage } from './useShiki'
import { diffLines, type Change } from 'diff'

interface DiffViewerProps {
  original: string
  modified: string
  language: string
}

export default function DiffViewer({ original, modified, language }: DiffViewerProps) {
  const { highlighter, isLoading } = useShiki()

  const changes = useMemo(() => diffLines(original, modified), [original, modified])

  const renderedLines = useMemo(() => {
    if (!highlighter) return null
    const lang = resolveLanguage(language)
    const result: { text: string; type: 'added' | 'removed' | 'unchanged'; lineNum: number | null; tokens: { content: string; color?: string }[] }[] = []
    let oldLine = 1
    let newLine = 1

    changes.forEach((change: Change) => {
      const changeLines = change.value.replace(/\n$/, '').split('\n')
      changeLines.forEach((line) => {
        let tokens: { content: string; color?: string }[] = [{ content: line }]
        try {
          const t = highlighter.codeToTokens(line, { lang, theme: 'vitesse-dark' })
          if (t.tokens[0]) tokens = t.tokens[0]
        } catch { /* fallback to plain */ }

        if (change.added) {
          result.push({ text: line, type: 'added', lineNum: newLine++, tokens })
        } else if (change.removed) {
          result.push({ text: line, type: 'removed', lineNum: oldLine++, tokens })
        } else {
          result.push({ text: line, type: 'unchanged', lineNum: newLine, tokens })
          oldLine++
          newLine++
        }
      })
    })

    return result
  }, [highlighter, changes, language])

  if (isLoading || !renderedLines) {
    return (
      <div className="flex items-center justify-center h-full text-text-tertiary text-sm animate-pulse">
        Loading diff...
      </div>
    )
  }

  return (
    <div className="h-full overflow-auto font-mono text-sm leading-[20px] bg-[#121212]">
      <table className="border-collapse w-full">
        <tbody>
          {renderedLines.map((line, i) => (
            <tr
              key={i}
              className={
                line.type === 'added' ? 'bg-emerald-500/[0.08]' :
                line.type === 'removed' ? 'bg-red-500/[0.08]' : ''
              }
            >
              <td className={`select-none w-[1%] text-center text-xs px-1 ${
                line.type === 'added' ? 'text-emerald-400 border-l-2 border-emerald-500' :
                line.type === 'removed' ? 'text-red-400 border-l-2 border-red-500' :
                'text-transparent'
              }`}>
                {line.type === 'added' ? '+' : line.type === 'removed' ? '-' : ' '}
              </td>
              <td className="select-none text-right pr-4 pl-2 text-text-tertiary/50 text-xs w-[1%] whitespace-nowrap align-top">
                {line.lineNum}
              </td>
              <td className="pr-4 whitespace-pre overflow-visible">
                {line.tokens.map((token, j) => (
                  <span key={j} style={{ color: token.color }}>{token.content}</span>
                ))}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
