import { useState } from 'react';
import { useVaultStore } from '../../stores/vault-store';

export default function VaultSearchTab() {
  const { selected, searchResults, setSearchResults } = useVaultStore();
  const [text, setText] = useState('');
  const [loading, setLoading] = useState(false);

  const run = async () => {
    if (!selected || !text.trim()) return;
    setLoading(true);
    try {
      const res = await fetch(`/api/vaults/${encodeURIComponent(selected)}/search`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, topK: 20 }),
      });
      const data = await res.json();
      setSearchResults(data.hits ?? []);
    } finally { setLoading(false); }
  };

  if (!selected) return <div className="p-4 text-sm text-muted-foreground">Select a vault</div>;

  return (
    <div className="p-4 space-y-4">
      <div className="flex gap-2">
        <input
          className="flex-1 border rounded px-2 py-1"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') run(); }}
          placeholder="semantic + keyword query"
        />
        <button onClick={run} className="px-3 py-1 border rounded">{loading ? '...' : 'Search'}</button>
      </div>
      <ul className="space-y-2">
        {searchResults.map((h) => (
          <li key={h.chunk.chunkId} className="border rounded p-2">
            <div className="text-xs text-muted-foreground">
              {h.chunk.path}:{h.chunk.startLine}-{h.chunk.endLine} rrf={h.scores.rrf.toFixed(4)}
            </div>
            <pre className="text-xs whitespace-pre-wrap">{h.chunk.content}</pre>
          </li>
        ))}
      </ul>
    </div>
  );
}
