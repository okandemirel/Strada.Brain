import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { useVaultStore } from '../stores/vault-store';
import VaultsPage from './VaultsPage';

beforeEach(() => {
  useVaultStore.setState({ vaults: [], selected: null, searchResults: [] });
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({ json: async () => ({ items: [] }) }) as unknown as Response),
  );
});

describe('VaultsPage', () => {
  it('shows empty state with no vaults', () => {
    render(<MemoryRouter><VaultsPage /></MemoryRouter>);
    expect(screen.getByText(/no vaults/i)).toBeInTheDocument();
  });

  it('lists registered vaults', () => {
    useVaultStore.setState({
      vaults: [{ id: 'unity:abc', kind: 'unity-project' }],
      selected: null,
      searchResults: [],
    });
    render(<MemoryRouter><VaultsPage /></MemoryRouter>);
    expect(screen.getByText(/unity:abc/)).toBeInTheDocument();
  });
});
