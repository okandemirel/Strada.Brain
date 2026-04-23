import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { useVaultStore } from '../../stores/vault-store';

// Mock @xyflow/react: jsdom has no canvas/SVG layout engine. The mock renders
// labels as plain divs so `renders node labels` can assert on node text without
// crashing. Additional symbols (MiniMap, ReactFlowProvider, BaseEdge, Handle, …)
// are stubbed either as no-op components or passthroughs so module-level imports
// in GraphNode/GraphEdge/GraphMiniMap don't break. Custom nodeTypes/edgeTypes
// are never invoked in tests because the mocked ReactFlow doesn't call them.
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
  ReactFlowProvider: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
  Background: () => <div data-testid="background" />,
  BackgroundVariant: { Dots: 'dots', Lines: 'lines', Cross: 'cross' },
  Controls: () => <div data-testid="controls" />,
  MiniMap: () => <div data-testid="minimap" />,
  BaseEdge: () => null,
  EdgeLabelRenderer: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
  Handle: () => null,
  Position: { Top: 'top', Right: 'right', Bottom: 'bottom', Left: 'left' },
  getSmoothStepPath: () => ['M0,0', 0, 0],
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
