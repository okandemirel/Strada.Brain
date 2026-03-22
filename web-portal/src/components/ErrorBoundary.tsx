import { Component, type ErrorInfo, type ReactNode } from 'react'

interface Props {
  children: ReactNode
}

interface State {
  hasError: boolean
  error: Error | null
}

export default class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props)
    this.state = { hasError: false, error: null }
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('[ErrorBoundary] Uncaught render error:', error, info.componentStack)
  }

  handleReload = () => {
    window.location.reload()
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="flex flex-col items-center justify-center h-screen bg-bg text-text font-sans p-8 text-center">
          <h1 className="text-2xl mb-3 text-text font-bold">
            Something went wrong
          </h1>
          <p className="text-[0.95rem] text-text-tertiary max-w-[420px] mb-6">
            An unexpected error occurred while rendering the interface. You can try reloading the page.
          </p>
          {this.state.error && (
            <pre className="text-sm text-error bg-bg-tertiary px-4 py-3 rounded-md max-w-[500px] overflow-auto mb-6 whitespace-pre-wrap break-words">
              {this.state.error.message}
            </pre>
          )}
          <button
            onClick={this.handleReload}
            className="px-6 py-2.5 text-[0.95rem] bg-accent text-bg border-none rounded-md cursor-pointer font-semibold hover:bg-accent-hover transition-colors"
          >
            Reload
          </button>
        </div>
      )
    }

    return this.props.children
  }
}
