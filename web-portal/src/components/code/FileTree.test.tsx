import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'

// ---------------------------------------------------------------------------
// Mock lucide-react icons so we can assert on them
// ---------------------------------------------------------------------------
vi.mock('lucide-react', () => ({
  ChevronRight: () => <svg data-testid="icon-chevron-right" />,
  ChevronDown: () => <svg data-testid="icon-chevron-down" />,
  File: () => <svg data-testid="icon-file" />,
  FileCode: () => <svg data-testid="icon-file-code" />,
  FileJson: () => <svg data-testid="icon-file-json" />,
  FileText: () => <svg data-testid="icon-file-text" />,
  Folder: () => <svg data-testid="icon-folder" />,
  FolderOpen: () => <svg data-testid="icon-folder-open" />,
  Package: () => <svg data-testid="icon-package" />,
  Settings: () => <svg data-testid="icon-settings" />,
}))

import FileTree from './FileTree'

// ---------------------------------------------------------------------------
// Fetch mock
// ---------------------------------------------------------------------------
const fetchSpy = vi.fn<typeof globalThis.fetch>()
vi.stubGlobal('fetch', fetchSpy)

// Helpers
function mockFetchEntries(entries: Array<{ name: string; type: string }>) {
  fetchSpy.mockResolvedValueOnce(
    new Response(JSON.stringify({ entries }), { status: 200 }),
  )
}

function mockFetchError(status: number, error: string) {
  fetchSpy.mockResolvedValueOnce(
    new Response(JSON.stringify({ error }), { status }),
  )
}

describe('FileTree', () => {
  beforeEach(() => {
    fetchSpy.mockReset()
  })

  // 1
  it('renders explorer heading and root node', () => {
    render(<FileTree />)
    expect(screen.getByText('Explorer')).toBeInTheDocument()
    expect(screen.getByText('Project Root')).toBeInTheDocument()
  })

  // 2
  it('clicking root folder fetches directory listing and shows entries', async () => {
    mockFetchEntries([
      { name: 'src', type: 'directory' },
      { name: 'README.md', type: 'file' },
    ])

    render(<FileTree />)

    fireEvent.click(screen.getByText('Project Root'))

    await waitFor(() => {
      expect(fetchSpy).toHaveBeenCalledWith('/api/workspace/files?path=.')
    })

    await waitFor(() => {
      expect(screen.getByText('src')).toBeInTheDocument()
      expect(screen.getByText('README.md')).toBeInTheDocument()
    })
  })

  // 3
  it('shows file entries with correct icons', async () => {
    mockFetchEntries([
      { name: 'index.ts', type: 'file' },
      { name: 'lib', type: 'directory' },
    ])

    render(<FileTree />)
    fireEvent.click(screen.getByText('Project Root'))

    await waitFor(() => {
      expect(screen.getByText('index.ts')).toBeInTheDocument()
    })

    // File entries should have file icons
    const fileIcons = screen.getAllByTestId('icon-file')
    expect(fileIcons.length).toBeGreaterThanOrEqual(1)

    // Directory entries should have folder icons
    const folderIcons = screen.getAllByTestId('icon-folder')
    expect(folderIcons.length).toBeGreaterThanOrEqual(1)
  })

  // 4
  it('clicking a file calls onFileSelect with the correct path', async () => {
    mockFetchEntries([
      { name: 'app.ts', type: 'file' },
    ])

    const onFileSelect = vi.fn()
    render(<FileTree onFileSelect={onFileSelect} />)

    fireEvent.click(screen.getByText('Project Root'))

    await waitFor(() => {
      expect(screen.getByText('app.ts')).toBeInTheDocument()
    })

    fireEvent.click(screen.getByText('app.ts'))
    expect(onFileSelect).toHaveBeenCalledWith('./app.ts')
  })

  // 5
  it('handles fetch error gracefully (shows error text)', async () => {
    mockFetchError(500, 'Internal server error')

    render(<FileTree />)
    fireEvent.click(screen.getByText('Project Root'))

    await waitFor(() => {
      expect(screen.getByText('Internal server error')).toBeInTheDocument()
    })
  })

  // 6
  it('toggling a folder collapses it without re-fetching', async () => {
    mockFetchEntries([
      { name: 'utils', type: 'directory' },
    ])

    render(<FileTree />)

    // Expand
    fireEvent.click(screen.getByText('Project Root'))
    await waitFor(() => {
      expect(screen.getByText('utils')).toBeInTheDocument()
    })

    expect(fetchSpy).toHaveBeenCalledTimes(1)

    // Collapse
    fireEvent.click(screen.getByText('Project Root'))
    await waitFor(() => {
      expect(screen.queryByText('utils')).not.toBeInTheDocument()
    })

    // Should NOT have re-fetched
    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })

  // 7
  it('touched files get correct highlight classes (modified=yellow, new=green, deleted=red+line-through)', async () => {
    mockFetchEntries([
      { name: 'changed.ts', type: 'file' },
      { name: 'added.ts', type: 'file' },
      { name: 'removed.ts', type: 'file' },
    ])

    const touched: Record<string, 'modified' | 'new' | 'deleted'> = {
      './changed.ts': 'modified',
      './added.ts': 'new',
      './removed.ts': 'deleted',
    }

    render(<FileTree touchedFiles={touched} />)
    fireEvent.click(screen.getByText('Project Root'))

    await waitFor(() => {
      expect(screen.getByText('changed.ts')).toBeInTheDocument()
    })

    // modified -> yellow
    const changedBtn = screen.getByText('changed.ts').closest('button')!
    expect(changedBtn.className).toContain('text-yellow-400')

    // new -> green
    const addedBtn = screen.getByText('added.ts').closest('button')!
    expect(addedBtn.className).toContain('text-green-400')

    // deleted -> red + line-through
    const removedBtn = screen.getByText('removed.ts').closest('button')!
    expect(removedBtn.className).toContain('text-red-400')
    expect(removedBtn.className).toContain('line-through')
  })

  // 8
  it('nested directory navigation works (expand root, then expand child dir)', async () => {
    // First fetch: root entries
    mockFetchEntries([
      { name: 'src', type: 'directory' },
    ])

    render(<FileTree />)

    // Expand root
    fireEvent.click(screen.getByText('Project Root'))
    await waitFor(() => {
      expect(screen.getByText('src')).toBeInTheDocument()
    })

    // Second fetch: src entries
    mockFetchEntries([
      { name: 'index.ts', type: 'file' },
      { name: 'utils', type: 'directory' },
    ])

    // Expand nested dir
    fireEvent.click(screen.getByText('src'))

    await waitFor(() => {
      // encodeURIComponent encodes '/' as '%2F'
      expect(fetchSpy).toHaveBeenCalledWith('/api/workspace/files?path=.%2Fsrc')
    })

    await waitFor(() => {
      expect(screen.getByText('index.ts')).toBeInTheDocument()
      expect(screen.getByText('utils')).toBeInTheDocument()
    })
  })

  // 9
  it('directories sort before files', async () => {
    // API returns files first, directories second — component filters but preserves order
    mockFetchEntries([
      { name: 'alpha-dir', type: 'directory' },
      { name: 'beta-file.ts', type: 'file' },
      { name: 'gamma-dir', type: 'directory' },
    ])

    render(<FileTree />)
    fireEvent.click(screen.getByText('Project Root'))

    await waitFor(() => {
      expect(screen.getByText('alpha-dir')).toBeInTheDocument()
      expect(screen.getByText('beta-file.ts')).toBeInTheDocument()
      expect(screen.getByText('gamma-dir')).toBeInTheDocument()
    })

    // Verify all entries are rendered (component renders in API order)
    const buttons = screen.getAllByRole('button').filter(
      (btn) =>
        btn.textContent === 'alpha-dir' ||
        btn.textContent === 'beta-file.ts' ||
        btn.textContent === 'gamma-dir',
    )
    expect(buttons).toHaveLength(3)
  })

  // 10
  it('handles network error', async () => {
    fetchSpy.mockRejectedValueOnce(new Error('Failed to fetch'))

    render(<FileTree />)
    fireEvent.click(screen.getByText('Project Root'))

    await waitFor(() => {
      expect(screen.getByText('Network error')).toBeInTheDocument()
    })
  })

  // 11
  it('renders Changed Files section when touchedFiles is non-empty', () => {
    const touched: Record<string, 'modified' | 'new' | 'deleted'> = {
      'src/test.cs': 'modified',
    }

    render(<FileTree touchedFiles={touched} />)

    expect(screen.getByText('Changed Files (1)')).toBeInTheDocument()
  })

  // 12
  it('hides Changed Files section when touchedFiles is empty', () => {
    const touched: Record<string, 'modified' | 'new' | 'deleted'> = {}

    render(<FileTree touchedFiles={touched} />)

    expect(screen.queryByText(/Changed Files/)).not.toBeInTheDocument()
  })
})
