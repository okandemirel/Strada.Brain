import { Component, type ErrorInfo, type ReactNode } from 'react'
import i18n from '../i18n'

interface Props {
  children: ReactNode
  panelName?: string
}

interface State {
  hasError: boolean
  error: Error | null
}

/**
 * Lightweight error boundary scoped to a single workspace panel.
 * Unlike the top-level ErrorBoundary (which shows a full-screen crash page),
 * this renders an inline fallback so the rest of the app remains usable.
 */
export default class PanelErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props)
    this.state = { hasError: false, error: null }
  }

  // A lazy chunk failed to load — almost always a STALE bundle (the page was
  // open across a new deploy, so its index.html references chunk hashes that no
  // longer exist). A full page reload fetches the current index + chunks.
  static readonly CHUNK_ERROR =
    /dynamically imported module|module script failed|Failed to fetch dynamically|Loading chunk/i

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error(
      `[PanelErrorBoundary${this.props.panelName ? `:${this.props.panelName}` : ''}] Uncaught render error:`,
      error,
      info.componentStack,
    )
    // Auto-heal stale chunks with a single full reload (guarded against loops:
    // only reload if we haven't already done so in the last 10s).
    if (PanelErrorBoundary.CHUNK_ERROR.test(error.message)) {
      try {
        const key = 'panel-chunk-reload-at'
        const last = Number(window.sessionStorage.getItem(key) ?? '0')
        const now = Date.now()
        if (now - last > 10_000) {
          window.sessionStorage.setItem(key, String(now))
          window.location.reload()
        }
      } catch {
        /* sessionStorage unavailable — fall through to the inline error UI */
      }
    }
  }

  handleRetry = () => {
    // For a stale-chunk error, retrying the import is futile (the chunk is gone)
    // — do a full page reload instead so the current bundle is fetched.
    if (this.state.error && PanelErrorBoundary.CHUNK_ERROR.test(this.state.error.message)) {
      window.location.reload()
      return
    }
    this.setState({ hasError: false, error: null })
  }

  render() {
    if (this.state.hasError) {
      const t = i18n.t.bind(i18n)
      return (
        <div className="flex flex-col items-center justify-center h-full gap-3 p-6 text-center">
          <p className="text-sm font-medium text-text-secondary">
            {t('errors.panelCrash')}
          </p>
          {this.state.error && (
            <pre className="text-xs text-error bg-bg-tertiary px-3 py-2 rounded-md max-w-[400px] overflow-auto whitespace-pre-wrap break-words">
              {this.state.error.message}
            </pre>
          )}
          <button
            onClick={this.handleRetry}
            className="mt-1 px-4 py-1.5 text-sm bg-accent text-bg border-none rounded-md cursor-pointer font-medium hover:bg-accent-hover transition-colors"
          >
            {t('errors.panelRetry')}
          </button>
        </div>
      )
    }

    return this.props.children
  }
}
