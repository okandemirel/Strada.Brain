import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'

const mockUseShiki = vi.fn()

vi.mock('./useShiki', () => ({
  useShiki: () => mockUseShiki(),
  resolveLanguage: (language: string) => language,
}))

import DiffViewer from './DiffViewer'

describe('DiffViewer', () => {
  beforeEach(() => {
    mockUseShiki.mockReset()
    mockUseShiki.mockReturnValue({
      isLoading: false,
      highlighter: {
        codeToTokens: (code: string) => ({
          tokens: [[{ content: code || ' ' }]],
        }),
      },
    })
  })

  it('shows loading state while syntax highlighter is preparing', () => {
    mockUseShiki.mockReturnValue({
      isLoading: true,
      highlighter: null,
    })

    render(<DiffViewer original="const a = 1" modified="const a = 2" language="typescript" />)

    expect(screen.getByText('Loading diff...')).toBeInTheDocument()
  })

  it('renders split headers for original and modified panes', () => {
    render(<DiffViewer original="const a = 1" modified="const a = 2" language="typescript" />)

    expect(screen.getByText('Original')).toBeInTheDocument()
    expect(screen.getByText('Modified')).toBeInTheDocument()
  })

  it('shows added and removed line counts', () => {
    render(
      <DiffViewer
        original={`const a = 1\nconst b = 2`}
        modified={`const a = 2\nconst b = 2\nconst c = 3`}
        language="typescript"
      />,
    )

    expect(screen.getByText('-1 removed lines')).toBeInTheDocument()
    expect(screen.getByText('+2 added lines')).toBeInTheDocument()
  })

  it('renders both original and modified code content', () => {
    render(
      <DiffViewer
        original={`const value = 1\nconsole.log(value)`}
        modified={`const value = 2\nconsole.log(value)`}
        language="typescript"
      />,
    )

    expect(screen.getByText('const value = 1')).toBeInTheDocument()
    expect(screen.getByText('const value = 2')).toBeInTheDocument()
  })
})
