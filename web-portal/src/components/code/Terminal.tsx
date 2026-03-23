import { useRef, useEffect } from 'react'
import { useCodeStore } from '../../stores/code-store'

export default function Terminal() {
  const output = useCodeStore((s) => s.terminalOutput)
  const bottomRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [output.length])

  return (
    <div className="h-full bg-bg-secondary text-text font-mono text-xs overflow-y-auto p-2">
      {output.length === 0 ? (
        <div className="text-text-tertiary">No terminal output</div>
      ) : (
        output.map((line, i) => (
          <div key={i} className="whitespace-pre-wrap leading-5">
            {line}
          </div>
        ))
      )}
      <div ref={bottomRef} />
    </div>
  )
}
