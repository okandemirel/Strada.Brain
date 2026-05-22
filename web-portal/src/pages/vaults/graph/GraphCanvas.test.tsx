import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { useVaultStore } from '../../../stores/vault-store';
import type { CanvasJson } from '../../../stores/vault-store';

// Mock useTheme
vi.mock('../../../hooks/useTheme', () => ({
  useTheme: () => ({ theme: 'dark', toggleTheme: vi.fn() }),
}));

// Mock getComputedStyle for CSS vars
const originalGetComputedStyle = window.getComputedStyle;
// @ts-expect-error overriding for tests
window.getComputedStyle = (elt: Element) => {
  const style = originalGetComputedStyle(elt);
  return {
    ...style,
    getPropertyValue: (prop: string) => {
      const map: Record<string, string> = {
        '--graph-bg': '#0a0a0f',
        '--graph-edge': 'rgba(255,255,255,0.35)',
        '--graph-edge-active': '#00e5ff',
        '--graph-node-border': 'rgba(255,255,255,0.12)',
        '--graph-node-border-hover': 'rgba(255,255,255,0.35)',
        '--graph-node-selected-ring': '#00e5ff',
        '--graph-label': '#a0a0b0',
        '--graph-label-detail': '#6a6a7a',
        '--graph-panel-bg': 'rgba(16,16,22,0.92)',
        '--graph-panel-border': '#1f1f2f',
        '--color-text': '#e8e8ed',
        '--color-text-secondary': '#a0a0b0',
        '--color-text-tertiary': '#6a6a7a',
      };
      return map[prop] ?? '';
    },
  };
};

// Mock react-force-graph-2d
let capturedProps: Record<string, unknown> = {};
let graphDataProps: unknown[] = [];

vi.mock('react-force-graph-2d', () => ({
  default: function MockForceGraph2D(props: Record<string, unknown>) {
    capturedProps = props;
    graphDataProps.push(props.graphData);
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
    graphDataProps = [];
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
    // Match the visible stats line (not the sr-only a11y "N nodes in graph"
    // text). Using a stricter pattern that requires the `·` separator.
    expect(screen.getByText(/4 nodes · 3 links/)).toBeInTheDocument();
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
    expect(screen.getByText(/3 nodes · 3 links/)).toBeInTheDocument();

    // Exit via Escape (dispatch from the canvas wrapper since the global
    // Escape listener was consolidated into useGraphKeyboard).
    fireEvent.keyDown(screen.getByTestId('graph-canvas'), { key: 'Escape' });

    await waitFor(() => {
      expect(screen.queryByText(/Local view/)).not.toBeInTheDocument();
    });

    expect(screen.getByText(/4 nodes · 3 links/)).toBeInTheDocument();
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
      // The a11y treeitem also renders "Foo"; match the tooltip variant by
      // its specific Tailwind class (font-medium + text-white/80).
      const tooltipTitle = screen
        .getAllByText('Foo')
        .find((el) => el.className.includes('font-medium'));
      expect(tooltipTitle).toBeDefined();
    });
    expect(screen.getByText('class')).toBeInTheDocument();
    expect(screen.getByText(/a\.ts/)).toBeInTheDocument();
  });

  it('passes correct physics props', () => {
    render(<GraphCanvas graph={makeGraph()} />);
    expect(capturedProps.warmupTicks).toBe(100);
    expect(capturedProps.cooldownTicks).toBe(50);
    expect(capturedProps.nodeRelSize).toBe(4);
  });

  it('renders zoom in, zoom out, and fit controls', () => {
    render(<GraphCanvas graph={makeGraph()} />);
    expect(screen.getByTitle('Zoom in')).toBeInTheDocument();
    expect(screen.getByTitle('Zoom out')).toBeInTheDocument();
    expect(screen.getByText('Fit')).toBeInTheDocument();
  });

  it('keeps force graph data identity stable across local UI rerenders', async () => {
    render(<GraphCanvas graph={makeGraph()} />);
    const initialGraphData = graphDataProps[0];

    fireEvent.mouseMove(screen.getByTestId('graph-canvas'), { clientX: 24, clientY: 40 });

    await waitFor(() => {
      expect(graphDataProps.length).toBeGreaterThan(1);
    });
    expect(graphDataProps.at(-1)).toBe(initialGraphData);
  });
});
