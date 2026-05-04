import { useState, useEffect, useCallback } from 'react';
import { useVaultStore } from '../stores/vault-store';
import { VaultForceGraph } from './vaults/graph/VaultForceGraph';

function SimpleVaultGraph() {
  const selected = useVaultStore((s) => s.selected);
  const [canvas, setCanvas] = useState<{ nodes: any[]; edges: any[] } | null>(null);
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
      <div className="flex items-center justify-center h-full text-gray-500">
        Soldaki listeden bir vault seçin
      </div>
    );
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full text-gray-500">
        Yükleniyor...
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-4">
        <div className="text-red-500">Hata: {error}</div>
        <button
          onClick={fetchCanvas}
          className="px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700"
        >
          Tekrar Dene
        </button>
      </div>
    );
  }

  if (!canvas || !canvas.nodes || canvas.nodes.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-4">
        <div className="text-gray-500">Graph verisi bulunamadı</div>
        <button
          onClick={regenerateCanvas}
          className="px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700"
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
    <div className="h-full flex bg-gray-900 text-white">
      {/* Sol panel - Vault Listesi */}
      <div className="w-64 border-r border-gray-700 flex flex-col">
        <div className="p-3 border-b border-gray-700 font-semibold text-sm">
          Vaults
        </div>
        <div className="flex-1 overflow-auto">
          {vaults.length === 0 ? (
            <div className="p-3 text-gray-500 text-sm">Vault bulunamadı</div>
          ) : (
            vaults.map((v) => (
              <button
                key={v.id}
                onClick={() => select(v.id)}
                className={`w-full text-left px-3 py-2 text-sm hover:bg-gray-800 transition-colors ${
                  selected === v.id ? 'bg-gray-800 text-blue-400' : 'text-gray-300'
                }`}
              >
                <div className="font-medium truncate">{v.id}</div>
                <div className="text-xs text-gray-500">{v.kind}</div>
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
