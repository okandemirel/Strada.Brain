import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import '../../i18n';
import { useVaultStore } from '../../stores/vault-store';
import { RightPanel } from './RightPanel';

beforeEach(() => {
  useVaultStore.setState({
    vaults: [],
    selected: null,
    activeRightTab: 'backlinks',
    selectedSymbolId: null,
    graphCache: {},
    searchResults: [],
    activeFilePath: null,
    recentFiles: [],
    recentSymbols: [],
  });
});

describe('RightPanel', () => {
  it('renders three tabs', () => {
    render(<RightPanel />);
    expect(screen.getAllByRole('tab')).toHaveLength(3);
  });

  it('shows "select a vault" empty hint when no vault is selected', () => {
    render(<RightPanel />);
    expect(screen.getByText(/select a vault/i)).toBeInTheDocument();
  });

  it('shows right-panel empty state when vault is set but no symbol selected', () => {
    useVaultStore.setState({ selected: 'v1' });
    render(<RightPanel />);
    expect(screen.getByText(/select a symbol/i)).toBeInTheDocument();
  });

  it('shows backlinks for the open note and navigates to a source note on click', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        wikilinks: [{ fromNote: 'b.md', target: 'notes/a.md', resolved: true }],
        callers: [],
      }),
    });
    vi.stubGlobal('fetch', fetchMock);
    useVaultStore.setState({
      selected: 'v1',
      activeFilePath: 'notes/a.md',
      selectedSymbolId: null,
      activeRightTab: 'backlinks',
    });

    render(<RightPanel />);

    const row = await screen.findByText('b.md');
    // The backlinks fetch hit the encoded note-path route.
    expect(fetchMock.mock.calls[0]![0]).toContain('/notes/notes%2Fa.md/backlinks');

    fireEvent.click(row);
    expect(useVaultStore.getState().activeFilePath).toBe('b.md');
    expect(useVaultStore.getState().activeTab).toBe('files');
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});
