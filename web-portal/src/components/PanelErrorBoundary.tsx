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

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error(
      `[PanelErrorBoundary${this.props.panelName ? `:${this.props.panelName}` : ''}] Uncaught render error:`,
      error,
      info.componentStack,
    )
  }

  handleRetry = () => {
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
