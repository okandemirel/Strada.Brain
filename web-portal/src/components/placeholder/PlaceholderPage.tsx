interface Props {
  title: string
}

const ICONS: Record<string, string> = {
  Config: '\u2699\uFE0F',
  Tools: '\uD83D\uDD27',
  Channels: '\uD83D\uDCE1',
  Sessions: '\uD83D\uDC65',
  Logs: '\uD83D\uDCDC',
  Identity: '\uD83E\uDDEC',
  Personality: '\uD83C\uDFAD',
  Memory: '\uD83E\uDDE0',
}

export default function PlaceholderPage({ title }: Props) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center text-text-secondary gap-3">
      <div className="text-5xl mb-2">{ICONS[title]}</div>
      <h2 className="text-text text-2xl font-bold tracking-tight">{title}</h2>
      <p className="text-[15px] text-text-tertiary">Coming in Phase 2</p>
    </div>
  )
}
