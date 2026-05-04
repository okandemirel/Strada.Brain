import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { useVaultStore } from '../../stores/vault-store';

// Mock react-force-graph-2d: jsdom has no canvas support. The mock renders
// a simple div so tests can assert on presence without crashing.
vi.mock('react-force-graph-2d', () => ({
  default: ({ graphData }: { graphData: { nodes: Array<{ id: string; label: string }> } }) => (
    <div data-testid="force-graph">
      <span data-testid="node-count">{graphData.nodes.length}</span>
      {graphData.nodes.map((n) => (
        <div key={n.id} data-testid={`node-${n.id}`}>{n.label}</div>
      ))}
    </div>
  ),
}));

import VaultGraphTab from './VaultGraphTab';

const fetchMock = vi.fn();
(globalThis as { fetch: typeof fetch }).fetch = fetchMock as unknown as typeof fetch;

describe('VaultGraphTab', () => {
  beforeEach(() => {
    fetchMock.mockReset();
    useVaultStore.setState({
      selected: 'v1',
      vaults: [{ id: 'v1', kind: 'unity-project' }],
      searchResults: [],
      graphCache: {},
      activeFilePath: null,
      selectedSymbolId: null,
    });
  });

  it('shows empty state when no vault selected', () => {
    useVaultStore.setState({ selected: null, graphCache: {} });
    render(<VaultGraphTab />);
    expect(screen.getByText(/select a vault/i)).toBeInTheDocument();
  });

  it('fetches canvas and renders node labels', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        nodes: [{ id: 'a', type: 'text', text: '**class** Foo', x: 0, y: 0, width: 100, height: 60, file: 'a.ts' }],
        edges: [],
      }),
    });
    render(<VaultGraphTab />);
    await waitFor(() => expect(screen.getByText(/Foo/)).toBeInTheDocument());
  });

  it('shows empty-state message when canvas has no nodes', async () => {
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ nodes: [], edges: [] }) });
    render(<VaultGraphTab />);
    await waitFor(() => expect(screen.getByText(/no symbols/i)).toBeInTheDocument());
  });
});
