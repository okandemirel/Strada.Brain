import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act, render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import '../i18n';
import { useVaultStore } from '../stores/vault-store';
import VaultsPage from './VaultsPage';

// Mock @xyflow/react so the lazy-imported Graph tab never crashes on jsdom.
vi.mock('@xyflow/react', () => ({
  ReactFlow: () => <div data-testid="reactflow" />,
  ReactFlowProvider: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
  Background: () => <div data-testid="background" />,
  BackgroundVariant: { Dots: 'dots' },
  Controls: () => <div data-testid="controls" />,
  MiniMap: () => <div data-testid="minimap" />,
  BaseEdge: () => null,
  EdgeLabelRenderer: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
  Handle: () => null,
  Position: { Top: 'top', Right: 'right', Bottom: 'bottom', Left: 'left' },
  getSmoothStepPath: () => ['M0,0', 0, 0],
}));

function resetStore() {
  useVaultStore.setState({
    vaults: [],
    selected: null,
    searchResults: [],
    graphCache: {},
    selectedSymbolId: null,
    activeFilePath: null,
    activeTab: 'files',
    activeRightTab: 'backlinks',
    leftPanelOpen: true,
    rightPanelOpen: true,
    commandPaletteOpen: false,
    recentFiles: [],
    recentSymbols: [],
  });
}

beforeEach(() => {
  resetStore();
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({ ok: true, json: async () => ({ items: [] }) }) as unknown as Response),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('VaultsPage', () => {
  it('shows empty state with no vaults', () => {
    render(<MemoryRouter><VaultsPage /></MemoryRouter>);
    // The "No vaults registered" copy comes from vault.json:vaultList.empty.
    expect(screen.getByText(/no vaults/i)).toBeInTheDocument();
  });

  it('lists registered vaults', () => {
    useVaultStore.setState({
      vaults: [{ id: 'unity:abc', kind: 'unity-project' }],
    });
    render(<MemoryRouter><VaultsPage /></MemoryRouter>);
    expect(screen.getByText(/unity:abc/)).toBeInTheDocument();
  });

  it('opens command palette on Cmd/Ctrl+P', () => {
    render(<MemoryRouter><VaultsPage /></MemoryRouter>);
    expect(useVaultStore.getState().commandPaletteOpen).toBe(false);
    act(() => {
      fireEvent.keyDown(window, { key: 'p', metaKey: true });
    });
    expect(useVaultStore.getState().commandPaletteOpen).toBe(true);
  });

  it('toggles left panel on Cmd/Ctrl+B', () => {
    render(<MemoryRouter><VaultsPage /></MemoryRouter>);
    expect(useVaultStore.getState().leftPanelOpen).toBe(true);
    act(() => {
      fireEvent.keyDown(window, { key: 'b', ctrlKey: true });
    });
    expect(useVaultStore.getState().leftPanelOpen).toBe(false);
  });

  it('switches tabs via Cmd/Ctrl+1..3', () => {
    render(<MemoryRouter><VaultsPage /></MemoryRouter>);
    act(() => { fireEvent.keyDown(window, { key: '2', metaKey: true }); });
    expect(useVaultStore.getState().activeTab).toBe('search');
    act(() => { fireEvent.keyDown(window, { key: '3', metaKey: true }); });
    expect(useVaultStore.getState().activeTab).toBe('graph');
  });
});
