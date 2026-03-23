import { lazy, Suspense } from 'react'

const DiffEditor = lazy(() => import('@monaco-editor/react').then((m) => ({ default: m.DiffEditor })))

interface DiffViewerProps {
  original: string
  modified: string
  language: string
}

export default function DiffViewer({ original, modified, language }: DiffViewerProps) {
  return (
    <Suspense
      fallback={
        <div className="flex items-center justify-center h-full text-text-tertiary text-sm">Loading diff...</div>
      }
    >
      <DiffEditor
        original={original}
        modified={modified}
        language={language}
        theme="vs-dark"
        options={{ readOnly: true, renderSideBySide: true }}
      />
    </Suspense>
  )
}
