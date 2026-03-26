import { useMemo } from 'react'
import { diffLines, type Change } from 'diff'
import { useShiki, resolveLanguage } from './useShiki'

interface DiffViewerProps {
  original: string
  modified: string
  language: string
}

type Token = { content: string; color?: string }
type SideType = 'added' | 'removed' | 'unchanged' | 'empty'

interface DiffCell {
  lineNumber: number | null
  type: SideType
  tokens: Token[]
}

interface DiffRow {
  left: DiffCell
  right: DiffCell
}

function splitLines(value: string): string[] {
  const trimmed = value.replace(/\n$/, '')
  if (trimmed.length === 0) return ['']
  return trimmed.split('\n')
}

function emptyCell(): DiffCell {
  return { lineNumber: null, type: 'empty', tokens: [{ content: ' ' }] }
}

function cellClasses(type: SideType): string {
  switch (type) {
    case 'added':
      return 'bg-emerald-500/[0.08]'
    case 'removed':
      return 'bg-rose-500/[0.08]'
    case 'unchanged':
      return 'bg-transparent'
    default:
      return 'bg-white/[0.02]'
  }
}

function lineMarker(type: SideType): string {
  if (type === 'added') return '+'
  if (type === 'removed') return '-'
  return ' '
}

export default function DiffViewer({ original, modified, language }: DiffViewerProps) {
  const { highlighter, isLoading } = useShiki()

  const changes = useMemo(() => diffLines(original, modified), [original, modified])

  const diffData = useMemo(() => {
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

    const rows: DiffRow[] = []
    let oldLine = 1
    let newLine = 1
    let addedCount = 0
    let removedCount = 0

    for (let index = 0; index < changes.length; index += 1) {
      const change = changes[index] as Change
      const next = changes[index + 1] as Change | undefined

      if (change.removed && next?.added) {
        const removedLines = splitLines(change.value)
        const addedLines = splitLines(next.value)
        const rowCount = Math.max(removedLines.length, addedLines.length)

        for (let rowIndex = 0; rowIndex < rowCount; rowIndex += 1) {
          const removedLine = removedLines[rowIndex]
          const addedLine = addedLines[rowIndex]
          const isUnchangedPair =
            removedLine !== undefined &&
            addedLine !== undefined &&
            removedLine === addedLine

          if (isUnchangedPair) {
            rows.push({
              left: {
                lineNumber: oldLine++,
                type: 'unchanged',
                tokens: renderTokens(removedLine),
              },
              right: {
                lineNumber: newLine++,
                type: 'unchanged',
                tokens: renderTokens(addedLine),
              },
            })
            continue
          }

          if (removedLine !== undefined) removedCount += 1
          if (addedLine !== undefined) addedCount += 1

          rows.push({
            left: removedLine !== undefined
              ? {
                  lineNumber: oldLine++,
                  type: 'removed',
                  tokens: renderTokens(removedLine),
                }
              : emptyCell(),
            right: addedLine !== undefined
              ? {
                  lineNumber: newLine++,
                  type: 'added',
                  tokens: renderTokens(addedLine),
                }
              : emptyCell(),
          })
        }

        index += 1
        continue
      }

      if (change.added) {
        const addedLines = splitLines(change.value)
        addedCount += addedLines.length
        addedLines.forEach((line) => {
          rows.push({
            left: emptyCell(),
            right: {
              lineNumber: newLine++,
              type: 'added',
              tokens: renderTokens(line),
            },
          })
        })
        continue
      }

      if (change.removed) {
        const removedLines = splitLines(change.value)
        removedCount += removedLines.length
        removedLines.forEach((line) => {
          rows.push({
            left: {
              lineNumber: oldLine++,
              type: 'removed',
              tokens: renderTokens(line),
            },
            right: emptyCell(),
          })
        })
        continue
      }

      splitLines(change.value).forEach((line) => {
        rows.push({
          left: {
            lineNumber: oldLine,
            type: 'unchanged',
            tokens: renderTokens(line),
          },
          right: {
            lineNumber: newLine,
            type: 'unchanged',
            tokens: renderTokens(line),
          },
        })
        oldLine += 1
        newLine += 1
      })
    }

    return { rows, addedCount, removedCount }
  }, [changes, highlighter, language])

  if (isLoading || !diffData) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-text-tertiary animate-pulse">
        Loading diff...
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col overflow-hidden bg-[#0c1018]">
      <div className="grid grid-cols-2 border-b border-white/6 bg-white/[0.03]">
        <div className="border-r border-white/6 px-4 py-3">
          <div className="text-[10px] font-semibold uppercase tracking-[0.22em] text-text-tertiary">
            Original
          </div>
          <div className="mt-1 text-xs text-rose-300">-{diffData.removedCount} removed lines</div>
        </div>
        <div className="px-4 py-3">
          <div className="text-[10px] font-semibold uppercase tracking-[0.22em] text-text-tertiary">
            Modified
          </div>
          <div className="mt-1 text-xs text-emerald-300">+{diffData.addedCount} added lines</div>
        </div>
      </div>

      <div className="flex-1 overflow-auto">
        <div className="min-w-[920px] font-mono text-sm leading-[20px]">
          {diffData.rows.map((row, index) => (
            <div
              key={`${index}-${row.left.lineNumber}-${row.right.lineNumber}`}
              className="grid grid-cols-[56px_minmax(0,1fr)_56px_minmax(0,1fr)] border-b border-white/[0.03]"
            >
              <div
                className={`select-none border-r border-white/[0.04] px-2 py-1 text-right text-xs text-text-tertiary/55 ${cellClasses(row.left.type)}`}
              >
                {row.left.lineNumber ?? ''}
              </div>
              <div
                className={`border-r border-white/[0.04] px-3 py-1 whitespace-pre overflow-hidden ${cellClasses(row.left.type)}`}
              >
                <span className="mr-3 inline-block w-3 select-none text-text-tertiary/35">
                  {lineMarker(row.left.type)}
                </span>
                {row.left.tokens.map((token, tokenIndex) => (
                  <span key={tokenIndex} style={{ color: token.color }}>
                    {token.content}
                  </span>
                ))}
              </div>

              <div
                className={`select-none border-r border-white/[0.04] px-2 py-1 text-right text-xs text-text-tertiary/55 ${cellClasses(row.right.type)}`}
              >
                {row.right.lineNumber ?? ''}
              </div>
              <div className={`px-3 py-1 whitespace-pre overflow-hidden ${cellClasses(row.right.type)}`}>
                <span className="mr-3 inline-block w-3 select-none text-text-tertiary/35">
                  {lineMarker(row.right.type)}
                </span>
                {row.right.tokens.map((token, tokenIndex) => (
                  <span key={tokenIndex} style={{ color: token.color }}>
                    {token.content}
                  </span>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
