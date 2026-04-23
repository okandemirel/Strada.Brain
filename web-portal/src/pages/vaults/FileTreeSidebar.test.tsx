import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import '../../i18n';
import { useVaultStore } from '../../stores/vault-store';
import { FileTreeSidebar } from './FileTreeSidebar';

function resetStore() {
  useVaultStore.setState({
    vaults: [],
    selected: 'v1',
    activeFilePath: null,
    activeTab: 'files',
    graphCache: {},
    searchResults: [],
    selectedSymbolId: null,
    recentFiles: [],
    recentSymbols: [],
  });
}

const fetchMock = vi.fn();

beforeEach(() => {
  resetStore();
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('FileTreeSidebar', () => {
  it('renders empty state when vault has no files', async () => {
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ items: [] }) });
    render(<FileTreeSidebar />);
    await waitFor(() => expect(screen.getByText(/no files yet/i)).toBeInTheDocument());
  });

  it('renders nested folder tree two levels deep', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        items: [
          { path: 'src/a/file1.ts', lang: 'typescript' },
          { path: 'src/a/file2.ts', lang: 'typescript' },
          { path: 'docs/readme.md', lang: 'markdown' },
        ],
      }),
    });
    render(<FileTreeSidebar />);
    // Top-level folders
    await waitFor(() => {
      expect(screen.getByText('src')).toBeInTheDocument();
      expect(screen.getByText('docs')).toBeInTheDocument();
    });
    // Nested file visible via default-open on depth 0
    expect(screen.getByText('a')).toBeInTheDocument();
  });

  it('shows select-vault hint when nothing is selected', () => {
    useVaultStore.setState({ selected: null });
    render(<FileTreeSidebar />);
    expect(screen.getByText(/select a vault/i)).toBeInTheDocument();
  });
});
