import { useState, useEffect, useCallback } from 'react';
import { useVaultStore, type CanvasJson } from '../stores/vault-store';
import { VaultForceGraph } from './vaults/graph/VaultForceGraph';

function SimpleVaultGraph() {
  const selected = useVaultStore((s) => s.selected);
  const [canvas, setCanvas] = useState<CanvasJson | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchCanvas = useCallback(async () => {
    if (!selected) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/vaults/${encodeURIComponent(selected)}/canvas`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setCanvas(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load');
    } finally {
      setLoading(false);
    }
  }, [selected]);

  const regenerateCanvas = useCallback(async () => {
    if (!selected) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/vaults/${encodeURIComponent(selected)}/regenerate-canvas`, {
        method: 'POST',
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      // Yeniden fetch et
      await fetchCanvas();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to regenerate');
    } finally {
      setLoading(false);
    }
  }, [selected, fetchCanvas]);

  useEffect(() => {
    fetchCanvas();
  }, [fetchCanvas]);

  if (!selected) {
    return (
      <div className="flex items-center justify-center h-full text-[var(--color-text-tertiary)]">
        Soldaki listeden bir vault seçin
      </div>
    );
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full text-[var(--color-text-tertiary)]">
        Yükleniyor...
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-4">
        <div className="text-[var(--color-error)]">Hata: {error}</div>
        <button
          onClick={fetchCanvas}
          className="px-4 py-2 bg-[var(--color-accent)] text-[var(--color-on-accent)] rounded hover:opacity-90 transition-opacity"
        >
          Tekrar Dene
        </button>
      </div>
    );
  }

  if (!canvas || !canvas.nodes || canvas.nodes.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-4">
        <div className="text-[var(--color-text-tertiary)]">Graph verisi bulunamadı</div>
        <button
          onClick={regenerateCanvas}
          className="px-4 py-2 bg-[var(--color-accent)] text-[var(--color-on-accent)] rounded hover:opacity-90 transition-opacity"
        >
          Graph Oluştur
        </button>
      </div>
    );
  }

  return <VaultForceGraph canvas={canvas} />;
}

export default function VaultsPage() {
  const vaults = useVaultStore((s) => s.vaults);
  const selected = useVaultStore((s) => s.selected);
  const select = useVaultStore((s) => s.select);
  const setVaults = useVaultStore((s) => s.setVaults);

  // Vault listesini fetch et
  useEffect(() => {
    fetch('/api/vaults')
      .then((r) => r.json())
      .then((data) => setVaults(data.items ?? []))
      .catch(() => setVaults([]));
  }, [setVaults]);

  return (
    <div className="h-full flex bg-[var(--color-bg)] text-[var(--color-text)]">
      {/* Sol panel - Vault Listesi */}
      <div className="w-64 border-r border-[var(--color-border-subtle)] flex flex-col bg-[var(--color-bg-secondary)]">
        <div className="p-3 border-b border-[var(--color-border-subtle)] font-semibold text-sm text-[var(--color-text-secondary)]">
          Vaults
        </div>
        <div className="flex-1 overflow-auto">
          {vaults.length === 0 ? (
            <div className="p-3 text-[var(--color-text-tertiary)] text-sm">Vault bulunamadı</div>
          ) : (
            vaults.map((v) => (
              <button
                key={v.id}
                onClick={() => select(v.id)}
                className={`w-full text-left px-3 py-2 text-sm hover:bg-[var(--color-surface-hover)] transition-colors ${
                  selected === v.id ? 'bg-[var(--color-surface-hover)] text-[var(--color-accent)]' : 'text-[var(--color-text-secondary)]'
                }`}
              >
                <div className="font-medium truncate">{v.id}</div>
                <div className="text-xs text-[var(--color-text-tertiary)]">{v.kind}</div>
              </button>
            ))
          )}
        </div>
      </div>

      {/* Ana içerik - Graph */}
      <div className="flex-1 min-w-0">
        <SimpleVaultGraph />
      </div>
    </div>
  );
}
