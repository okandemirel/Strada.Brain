import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { useVaultStore } from '../../stores/vault-store';

// Mock ReactFlow: jsdom has no canvas/SVG layout engine; render labels as plain divs
// so `fetches canvas and renders node labels` can assert on node text without crashing.
interface MockFlowNode { id: string; data?: { label?: string } }
vi.mock('@xyflow/react', () => ({
  ReactFlow: ({ nodes, edges, children }: { nodes: MockFlowNode[]; edges: unknown[]; children?: React.ReactNode }) => (
    <div data-testid="reactflow">
      <span data-testid="node-count">{nodes.length}</span>
      <span data-testid="edge-count">{edges.length}</span>
      {nodes.map((n) => (
        <div key={n.id} data-testid={`node-${n.id}`}>{n.data?.label}</div>
      ))}
      {children}
    </div>
  ),
  Background: () => <div data-testid="background" />,
  Controls: () => <div data-testid="controls" />,
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
