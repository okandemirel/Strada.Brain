import { useMemo } from 'react'
import { diffLines, type Change } from 'diff'
import { useShiki, resolveLanguage } from './useShiki'

interface InlineDiffViewerProps {
  original: string
  modified: string
  language: string
}

type LineType = 'added' | 'removed' | 'unchanged'
type Token = { content: string; color?: string }

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

function splitLines(value: string): string[] {
  const trimmed = value.replace(/\n$/, '')
  if (trimmed.length === 0) return ['']
  return trimmed.split('\n')
}

export default function InlineDiffViewer({ original, modified, language }: InlineDiffViewerProps) {
  const { highlighter, isLoading } = useShiki()

  const changes = useMemo(() => diffLines(original, modified), [original, modified])

  const diffLines_ = useMemo(() => {
    if (!highlighter) return null

    const lang = resolveLanguage(language)
    const renderTokens = (line: string): Token[] => {
      try {
        const tokenized = highlighter.codeToTokens(line, { lang, theme: 'vitesse-dark' })
        return tokenized.tokens[0]?.length ? tokenized.tokens[0] : [{ content: line || ' ' }]
      } catch {
        return [{ content: line || ' ' }]
      }
    }

    const lines: DiffLine[] = []
    let oldLine = 1
    let newLine = 1
    let addedCount = 0
    let removedCount = 0

    for (const change of changes as Change[]) {
      const rawLines = splitLines(change.value)

      if (change.removed) {
        removedCount += rawLines.length
        for (const raw of rawLines) {
          lines.push({
            type: 'removed',
            oldLineNumber: oldLine++,
            newLineNumber: null,
            tokens: renderTokens(raw),
          })
        }
      } else if (change.added) {
        addedCount += rawLines.length
        for (const raw of rawLines) {
          lines.push({
            type: 'added',
            oldLineNumber: null,
            newLineNumber: newLine++,
            tokens: renderTokens(raw),
          })
        }
      } else {
        for (const raw of rawLines) {
          lines.push({
            type: 'unchanged',
            oldLineNumber: oldLine,
            newLineNumber: newLine,
            tokens: renderTokens(raw),
          })
          oldLine += 1
          newLine += 1
        }
      }
    }

    return { lines, addedCount, removedCount }
  }, [changes, highlighter, language])

  if (isLoading || !diffLines_) {
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
          {diffLines_.lines.map((line, i) => (
            <tr key={i} className={`group ${lineBg(line.type)}`}>
              {/* Old line number */}
              <td
                className={`select-none text-right pr-1.5 pl-3 text-text-tertiary/40 text-xs w-[1%] whitespace-nowrap align-top sticky left-0 ${gutterBg(line.type)}`}
              >
                {line.oldLineNumber ?? ''}
              </td>
              {/* New line number */}
              <td
                className={`select-none text-right pr-2 pl-1.5 text-text-tertiary/40 text-xs w-[1%] whitespace-nowrap align-top sticky left-[44px] border-r border-white/[0.04] ${gutterBg(line.type)}`}
              >
                {line.newLineNumber ?? ''}
              </td>
              {/* Marker */}
              <td className={`select-none w-[18px] text-center align-top ${markerColor(line.type)}`}>
                {markerChar(line.type)}
              </td>
              {/* Content */}
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
