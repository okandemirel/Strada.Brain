import { useMemo } from 'react'
import { diffLines, type Change } from 'diff'
import { useShiki, resolveLanguage } from './useShiki'
import { type Token, splitLines, makeTokenRenderer } from './diff-shared'

interface InlineDiffViewerProps {
  original: string
  modified: string
  language: string
}

type LineType = 'added' | 'removed' | 'unchanged'

interface DiffLine {
  type: LineType
  oldLineNumber: number | null
  newLineNumber: number | null
  tokens: Token[]
}

function lineBg(type: LineType): string {
  switch (type) {
    case 'added':
      return 'bg-emerald-500/[0.10]'
    case 'removed':
      return 'bg-rose-500/[0.10]'
    default:
      return ''
  }
}

function gutterBg(type: LineType): string {
  switch (type) {
    case 'added':
      return 'bg-emerald-500/[0.15]'
    case 'removed':
      return 'bg-rose-500/[0.15]'
    default:
      return 'bg-[#0e0e12]'
  }
}

function markerChar(type: LineType): string {
  if (type === 'added') return '+'
  if (type === 'removed') return '-'
  return ' '
}

function markerColor(type: LineType): string {
  if (type === 'added') return 'text-emerald-400'
  if (type === 'removed') return 'text-rose-400'
  return 'text-transparent'
}

export default function InlineDiffViewer({ original, modified, language }: InlineDiffViewerProps) {
  const { highlighter, isLoading } = useShiki()

  const lines = useMemo(() => {
    if (!highlighter) return null

    const renderTokens = makeTokenRenderer(highlighter, resolveLanguage(language))
    const result: DiffLine[] = []
    let oldLine = 1
    let newLine = 1

    for (const change of diffLines(original, modified) as Change[]) {
      const rawLines = splitLines(change.value)

      if (change.removed) {
        for (const raw of rawLines) {
          result.push({ type: 'removed', oldLineNumber: oldLine++, newLineNumber: null, tokens: renderTokens(raw) })
        }
      } else if (change.added) {
        for (const raw of rawLines) {
          result.push({ type: 'added', oldLineNumber: null, newLineNumber: newLine++, tokens: renderTokens(raw) })
        }
      } else {
        for (const raw of rawLines) {
          result.push({ type: 'unchanged', oldLineNumber: oldLine, newLineNumber: newLine, tokens: renderTokens(raw) })
          oldLine += 1
          newLine += 1
        }
      }
    }

    return result
  }, [original, modified, highlighter, language])

  if (isLoading || !lines) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-text-tertiary animate-pulse">
        Loading diff...
      </div>
    )
  }

  return (
    <div className="h-full overflow-auto bg-[#121212] font-mono text-sm leading-[20px]">
      <table className="border-collapse w-full">
        <tbody>
          {lines.map((line, i) => (
            <tr key={i} className={`group ${lineBg(line.type)}`}>
              <td
                className={`select-none text-right pr-1.5 pl-3 text-text-tertiary/40 text-xs w-[1%] whitespace-nowrap align-top sticky left-0 ${gutterBg(line.type)}`}
              >
                {line.oldLineNumber ?? ''}
              </td>
              <td
                className={`select-none text-right pr-2 pl-1.5 text-text-tertiary/40 text-xs w-[1%] whitespace-nowrap align-top sticky left-[44px] border-r border-white/[0.04] ${gutterBg(line.type)}`}
              >
                {line.newLineNumber ?? ''}
              </td>
              <td className={`select-none w-[18px] text-center align-top ${markerColor(line.type)}`}>
                {markerChar(line.type)}
              </td>
              <td className="pr-4 whitespace-pre overflow-visible">
                {line.tokens.map((token, j) => (
                  <span key={j} style={{ color: token.color }}>
                    {token.content}
                  </span>
                ))}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
