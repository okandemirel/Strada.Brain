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
        <div style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          height: '100vh',
          background: '#0a0a0f',
          color: '#e0e0e0',
          fontFamily: 'system-ui, -apple-system, sans-serif',
          padding: '2rem',
          textAlign: 'center',
        }}>
          <h1 style={{ fontSize: '1.5rem', marginBottom: '0.75rem', color: '#fff' }}>
            Something went wrong
          </h1>
          <p style={{ fontSize: '0.95rem', color: '#999', maxWidth: '420px', marginBottom: '1.5rem' }}>
            An unexpected error occurred while rendering the interface. You can try reloading the page.
          </p>
          {this.state.error && (
            <pre style={{
              fontSize: '0.8rem',
              color: '#f87171',
              background: '#1a1a24',
              padding: '0.75rem 1rem',
              borderRadius: '6px',
              maxWidth: '500px',
              overflow: 'auto',
              marginBottom: '1.5rem',
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
            }}>
              {this.state.error.message}
            </pre>
          )}
          <button
            onClick={this.handleReload}
            style={{
              padding: '0.6rem 1.5rem',
              fontSize: '0.95rem',
              background: '#00e5ff',
              color: '#0a0a0f',
              border: 'none',
              borderRadius: '6px',
              cursor: 'pointer',
              fontWeight: 600,
            }}
          >
            Reload
          </button>
        </div>
      )
    }

    return this.props.children
  }
}
