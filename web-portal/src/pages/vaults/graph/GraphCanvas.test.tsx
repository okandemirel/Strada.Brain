import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { useVaultStore } from '../../../stores/vault-store';
import type { CanvasJson } from '../../../stores/vault-store';

// Mock react-force-graph-2d
let capturedProps: Record<string, unknown> = {};

vi.mock('react-force-graph-2d', () => ({
  default: function MockForceGraph2D(props: Record<string, unknown>) {
    capturedProps = props;
    return (
      <div data-testid="force-graph-2d">
        <div data-testid="node-count">{(props.graphData as { nodes: unknown[] })?.nodes?.length ?? 0}</div>
        <div data-testid="link-count">{(props.graphData as { links: unknown[] })?.links?.length ?? 0}</div>
      </div>
    );
  },
}));

import GraphCanvas from './GraphCanvas';

function makeGraph(): CanvasJson {
  return {
    nodes: [
      { id: 'a', type: 'text', text: '**class** Foo', x: 0, y: 0, width: 100, height: 60, file: 'a.ts' },
      { id: 'b', type: 'text', text: '**method** Bar', x: 0, y: 0, width: 100, height: 60, file: 'b.ts' },
      { id: 'c', type: 'text', text: '**method** Baz', x: 0, y: 0, width: 100, height: 60, file: 'c.ts' },
      { id: 'd', type: 'text', text: '**field** Qux', x: 0, y: 0, width: 100, height: 60, file: 'd.ts' },
    ],
    edges: [
      { id: 'e1', fromNode: 'a', toNode: 'b', label: 'calls' },
      { id: 'e2', fromNode: 'a', toNode: 'c', label: 'calls' },
      { id: 'e3', fromNode: 'b', toNode: 'c', label: 'uses' },
    ],
  };
}

describe('GraphCanvas', () => {
  beforeEach(() => {
    capturedProps = {};
    useVaultStore.setState({
      selectedSymbolId: null,
      selected: 'v1',
      vaults: [{ id: 'v1', kind: 'unity-project' }],
      searchResults: [],
      graphCache: {},
      activeFilePath: null,
    });
  });

  it('renders graph with correct node and link counts', () => {
    render(<GraphCanvas graph={makeGraph()} />);
    expect(screen.getByTestId('graph-canvas')).toBeInTheDocument();
    expect(screen.getByText(/4 nodes/)).toBeInTheDocument();
    expect(screen.getByText(/3 links/)).toBeInTheDocument();
  });

  it('toggles orphan nodes visibility', () => {
    render(<GraphCanvas graph={makeGraph()} />);
    const settingsBtn = screen.getByTitle('Display settings');
    fireEvent.click(settingsBtn);

    const orphanCheckbox = screen.getByLabelText('Show orphan nodes');
    expect(orphanCheckbox).toBeChecked();

    fireEvent.click(orphanCheckbox);
    expect(orphanCheckbox).not.toBeChecked();
  });

  it('enters local graph mode on double-click and exits on Escape', async () => {
    render(<GraphCanvas graph={makeGraph()} />);

    // Select a node first (single click simulation)
    const nodeA = { id: 'a', label: 'Foo', kind: 'class', color: '#888', val: 1, file: 'a.ts', line: null };
    const onNodeClick = capturedProps.onNodeClick as (node: typeof nodeA) => void;

    act(() => {
      onNodeClick(nodeA);
    });

    await waitFor(() => {
      expect(useVaultStore.getState().selectedSymbolId).toBe('a');
    });

    // Enter local graph mode via settings button
    const settingsBtn = screen.getByTitle('Display settings');
    fireEvent.click(settingsBtn);

    const localGraphBtn = screen.getByText('Local Graph');
    fireEvent.click(localGraphBtn);

    await waitFor(() => {
      expect(screen.getByText(/Local view/)).toBeInTheDocument();
    });

    // In local mode with center 'a', we should see nodes a, b, c (neighbors) and links between them
    expect(screen.getByText(/3 nodes/)).toBeInTheDocument();
    expect(screen.getByText(/3 links/)).toBeInTheDocument();

    // Exit via Escape
    fireEvent.keyDown(window, { key: 'Escape' });

    await waitFor(() => {
      expect(screen.queryByText(/Local view/)).not.toBeInTheDocument();
    });

    expect(screen.getByText(/4 nodes/)).toBeInTheDocument();
    expect(screen.getByText(/3 links/)).toBeInTheDocument();
  });

  it('exits local graph mode when Full Graph is clicked', async () => {
    render(<GraphCanvas graph={makeGraph()} />);

    const nodeA = { id: 'a', label: 'Foo', kind: 'class', color: '#888', val: 1, file: 'a.ts', line: null };
    const onNodeClick = capturedProps.onNodeClick as (node: typeof nodeA) => void;
    act(() => {
      onNodeClick(nodeA);
    });

    await waitFor(() => {
      expect(useVaultStore.getState().selectedSymbolId).toBe('a');
    });

    const settingsBtn = screen.getByTitle('Display settings');
    fireEvent.click(settingsBtn);
    fireEvent.click(screen.getByText('Local Graph'));

    await waitFor(() => {
      expect(screen.getByText(/Local view/)).toBeInTheDocument();
    });

    // Dropdown is still open from the previous interaction
    fireEvent.click(screen.getByText('Full Graph'));

    await waitFor(() => {
      expect(screen.queryByText(/Local view/)).not.toBeInTheDocument();
    });
  });

  it('shows tooltip on node hover', async () => {
    render(<GraphCanvas graph={makeGraph()} />);

    const nodeA = { id: 'a', label: 'Foo', kind: 'class', color: '#888', val: 1, file: 'a.ts', line: null };
    const onNodeHover = capturedProps.onNodeHover as (node: typeof nodeA | null) => void;

    // Trigger mouse move to set position state
    fireEvent.mouseMove(screen.getByTestId('graph-canvas'));

    act(() => {
      onNodeHover(nodeA);
    });

    await waitFor(() => {
      expect(screen.getByText('Foo')).toBeInTheDocument();
    });
    expect(screen.getByText('class')).toBeInTheDocument();
    expect(screen.getByText(/a\.ts/)).toBeInTheDocument();
  });

  it('passes correct physics props', () => {
    render(<GraphCanvas graph={makeGraph()} />);
    expect(capturedProps.warmupTicks).toBe(60);
    expect(capturedProps.cooldownTicks).toBe(30);
    expect(capturedProps.nodeRelSize).toBe(4);
  });
});
