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
    <div className="placeholder-page">
      <div className="placeholder-icon">{ICONS[title]}</div>
      <h2>{title}</h2>
      <p>Coming in Phase 2</p>
    </div>
  )
}
