export default function EmptyState() {
  const isFirstRun = localStorage.getItem('strada-firstRun') === '1'

  return (
    <div className="empty-state">
      <div className="empty-state-logo">
        <img src="/strada-brain-icon.png" alt="Strada.Brain" width="64" height="64" />
      </div>
      <h2>Strada.Brain</h2>
      <p>
        {isFirstRun
          ? 'Setting up your workspace...'
          : 'AI-powered Unity development assistant. Send a message to get started.'}
      </p>
    </div>
  )
}
