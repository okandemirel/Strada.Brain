import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
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
});
