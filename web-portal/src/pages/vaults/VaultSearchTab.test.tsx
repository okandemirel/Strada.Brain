import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useVaultStore } from '../../stores/vault-store'
import VaultSearchTab from './VaultSearchTab'

const hit = (path: string) => ({
  chunk: { chunkId: `${path}#1`, path, startLine: 1, endLine: 2, content: 'code' },
  scores: { rrf: 0.5 },
})

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => { resolve = r })
  return { promise, resolve }
}

// WEB-22: a slow answer for vault A was written under vault B, and an error
// answer was parsed as `{hits: undefined}` and shown as "No matches".
describe('VaultSearchTab responses (WEB-22)', () => {
  const fetchMock = vi.fn()

  beforeEach(() => {
    fetchMock.mockReset()
    vi.stubGlobal('fetch', fetchMock)
    useVaultStore.setState({ selected: 'vault-a', searchResults: [] })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    useVaultStore.setState({ selected: null, searchResults: [] })
  })

  it('drops the answer to a search for a vault the user has since left', async () => {
    const answer = deferred<Response>()
    fetchMock.mockReturnValueOnce(answer.promise)
    const user = userEvent.setup()
    render(<VaultSearchTab />)

    await user.type(screen.getByRole('textbox'), 'Foo{Enter}')
    act(() => { useVaultStore.setState({ selected: 'vault-b' }) })
    await act(async () => {
      answer.resolve(new Response(JSON.stringify({ hits: [hit('a/Foo.cs')] }), { status: 200 }))
    })

    expect(useVaultStore.getState().searchResults).toEqual([])
  })

  it('reports a failed search instead of "no matches"', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ error: 'boom' }), { status: 500 }))
    const user = userEvent.setup()
    render(<VaultSearchTab />)

    await user.type(screen.getByRole('textbox'), 'Foo{Enter}')

    expect(await screen.findByText('Search failed. Try again.')).toBeInTheDocument()
    expect(screen.queryByText(/no matches/i)).toBeNull()
  })

  it('shows the hits of a search that succeeds (guard)', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ hits: [hit('a/Foo.cs')] }), { status: 200 }))
    const user = userEvent.setup()
    render(<VaultSearchTab />)

    await user.type(screen.getByRole('textbox'), 'Foo{Enter}')

    expect(await screen.findByText('a/Foo.cs:1-2')).toBeInTheDocument()
  })
})
