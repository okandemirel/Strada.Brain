import { describe, it, expect, beforeEach, vi } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '../../i18n';
import { useVaultStore } from '../../stores/vault-store';
import { VaultStatusBar } from './VaultStatusBar';

beforeEach(() => {
  useVaultStore.setState({
    vaults: [],
    selected: null,
    graphCache: {},
    searchResults: [],
    selectedSymbolId: null,
    activeFilePath: null,
    recentFiles: [],
    recentSymbols: [],
  });
});

describe('VaultStatusBar', () => {
  it('shows select-a-vault placeholder when nothing is selected', () => {
    render(<VaultStatusBar />);
    expect(screen.getByText(/select a vault/i)).toBeInTheDocument();
  });

  it('shows counts and reindex control when a vault is selected', () => {
    useVaultStore.setState({
      selected: 'v1',
      graphCache: {
        v1: {
          nodes: [
            { id: 'n1', type: 'text', text: '', x: 0, y: 0, width: 0, height: 0, file: 'a.ts' },
            { id: 'n2', type: 'text', text: '', x: 0, y: 0, width: 0, height: 0, file: 'b.ts' },
          ],
          edges: [],
        },
      },
    });
    render(<VaultStatusBar />);
    expect(screen.getByText(/2 symbols/i)).toBeInTheDocument();
    expect(screen.getByText(/2 files/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /reindex/i })).toBeInTheDocument();
  });

  it('surfaces reindex HTTP failures via the error indicator', async () => {
    // Stub fetch to return a non-ok response — the button must treat this as
    // a failure, not a silent success.
    const fetchMock = vi.fn(async () => ({ ok: false, status: 500 } as Response));
    (globalThis as { fetch: typeof fetch }).fetch = fetchMock as unknown as typeof fetch;

    useVaultStore.setState({
      selected: 'v1',
      graphCache: { v1: { nodes: [], edges: [] } },
    });

    render(<VaultStatusBar />);
    const btn = screen.getByRole('button', { name: /reindex/i });
    await act(async () => {
      await userEvent.click(btn);
    });

    await waitFor(() => {
      expect(screen.getByLabelText(/reindex failed/i)).toBeInTheDocument();
    });
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('/api/vaults/v1/sync'),
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('prefers authoritative /stats counts over graph-derived values', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ symbolCount: 42, fileCount: 7, lastIndexedAt: Date.now() }),
    } as Response));
    (globalThis as { fetch: typeof fetch }).fetch = fetchMock as unknown as typeof fetch;

    useVaultStore.setState({
      selected: 'v1',
      // Graph says 1 symbol / 1 file — /stats (42 / 7) must win.
      graphCache: {
        v1: {
          nodes: [{ id: 'n1', type: 'text', text: '', x: 0, y: 0, width: 0, height: 0, file: 'a.ts' }],
          edges: [],
        },
      },
    });

    render(<VaultStatusBar />);

    await waitFor(() => {
      expect(screen.getByText(/42 symbols/i)).toBeInTheDocument();
    });
    expect(screen.getByText(/7 files/i)).toBeInTheDocument();
  });
});
