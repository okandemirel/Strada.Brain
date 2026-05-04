import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { useVaultStore } from '../stores/vault-store';
import VaultsPage from './VaultsPage';

const fetchMock = vi.fn();
(globalThis as { fetch: typeof fetch }).fetch = fetchMock as unknown as typeof fetch;

describe('VaultsPage', () => {
  beforeEach(() => {
    fetchMock.mockReset();
    useVaultStore.setState({
      vaults: [],
      selected: null,
      activeTab: 'files',
      graphCache: {},
      searchResults: [],
      activeFilePath: null,
      selectedSymbolId: null,
    });
  });

  it('renders vault list', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ items: [{ id: 'v1', kind: 'self' }] }),
    });
    render(
      <MemoryRouter>
        <VaultsPage />
      </MemoryRouter>
    );
    await waitFor(() => expect(screen.getByText('v1')).toBeInTheDocument());
  });

  it('shows empty message when no vault selected', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ items: [{ id: 'v1', kind: 'self' }] }),
    });
    render(
      <MemoryRouter>
        <VaultsPage />
      </MemoryRouter>
    );
    await waitFor(() =>
      expect(screen.getByText(/soldaki listeden bir vault seçin/i)).toBeInTheDocument()
    );
  });
});
