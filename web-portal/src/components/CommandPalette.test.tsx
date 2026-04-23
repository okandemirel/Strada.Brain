import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import '../i18n';
import { useVaultStore } from '../stores/vault-store';
import { CommandPalette } from './CommandPalette';

beforeEach(() => {
  useVaultStore.setState({
    vaults: [],
    selected: null,
    commandPaletteOpen: true,
    activeTab: 'files',
    recentFiles: [],
    recentSymbols: [],
  });
});

describe('CommandPalette', () => {
  it('renders the input and command list when open', () => {
    render(<CommandPalette />);
    expect(screen.getByPlaceholderText(/type a command/i)).toBeInTheDocument();
    expect(screen.getByText(/Go to Files/i)).toBeInTheDocument();
    expect(screen.getByText(/Go to Search/i)).toBeInTheDocument();
    expect(screen.getByText(/Go to Graph/i)).toBeInTheDocument();
  });

  it('filters commands via query input', () => {
    render(<CommandPalette />);
    const input = screen.getByPlaceholderText(/type a command/i);
    fireEvent.change(input, { target: { value: 'graph' } });
    expect(screen.getByText(/Go to Graph/i)).toBeInTheDocument();
    // Non-matching should disappear
    expect(screen.queryByText(/Go to Files/i)).toBeNull();
  });

  it('closes on Escape and keeps store in sync', () => {
    render(<CommandPalette />);
    const input = screen.getByPlaceholderText(/type a command/i);
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(useVaultStore.getState().commandPaletteOpen).toBe(false);
  });
});
