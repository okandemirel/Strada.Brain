import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { useVaultStore } from '../../stores/vault-store';

// Mock GraphCanvas to avoid pulling in react-force-graph-2d in jsdom
vi.mock('./graph/GraphCanvas', () => ({
  default: function MockGraphCanvas({ graph }: { graph: { nodes: Array<{ id: string; text: string }> } }) {
    return (
      <div data-testid="graph-canvas">
        <span data-testid="node-count">{graph.nodes.length}</span>
        {graph.nodes.map((n) => (
          <div key={n.id} data-testid={`node-${n.id}`}>{n.text}</div>
        ))}
      </div>
    );
  },
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
    expect(screen.getByText(/select a vault to view the graph/i)).toBeInTheDocument();
  });

  it('fetches canvas and renders graph', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        nodes: [{ id: 'a', type: 'text', text: '**class** Foo', x: 0, y: 0, width: 100, height: 60, file: 'a.ts' }],
        edges: [],
      }),
    });
    render(<VaultGraphTab />);
    await waitFor(() => expect(screen.getByTestId('graph-canvas')).toBeInTheDocument());
  });

  // WEB-22: a failed load was cached as an empty graph ("No graph data") and
  // never retried until the cache was cleared.
  it('does not cache a failed load as an empty graph, and can retry it', async () => {
    fetchMock.mockRejectedValueOnce(new Error('offline'))
    render(<VaultGraphTab />);
    await waitFor(() => expect(screen.getByText('Could not load the graph.')).toBeInTheDocument());
    expect(screen.queryByText(/no graph data/i)).toBeNull();
    expect(useVaultStore.getState().graphCache).not.toHaveProperty('v1');

    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ nodes: [{ id: 'a', type: 'text', text: 'Foo', x: 0, y: 0, width: 100, height: 60 }], edges: [] }),
    });
    screen.getByRole('button', { name: 'Retry' }).click();
    await waitFor(() => expect(screen.getByTestId('graph-canvas')).toBeInTheDocument());
  });

  it('shows empty-state message when canvas has no nodes', async () => {
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ nodes: [], edges: [] }) });
    render(<VaultGraphTab />);
    await waitFor(() => expect(screen.getByText(/no graph data/i)).toBeInTheDocument());
  });
});
