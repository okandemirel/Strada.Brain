import { useEffect, useState } from 'react';
import { useVaultStore } from '../../stores/vault-store';
import MarkdownPreview from './MarkdownPreview';

interface TreeEntry { path: string; lang: string; }

export default function VaultFilesTab() {
  const selected = useVaultStore((s) => s.selected);
  const [files, setFiles] = useState<TreeEntry[]>([]);
  const [path, setPath] = useState<string | null>(null);
  const [body, setBody] = useState<string>('');

  useEffect(() => {
    if (!selected) return;
    fetch(`/api/vaults/${encodeURIComponent(selected)}/tree`)
      .then((r) => r.json()).then((d) => setFiles(d.items ?? [])).catch(() => setFiles([]));
  }, [selected]);

  useEffect(() => {
    if (!selected || !path) return;
    fetch(`/api/vaults/${encodeURIComponent(selected)}/file?path=${encodeURIComponent(path)}`)
      .then((r) => r.json()).then((d) => setBody(d.body ?? '')).catch(() => setBody(''));
  }, [selected, path]);

  if (!selected) return <div className="p-4 text-sm text-muted-foreground">Select a vault</div>;

  return (
    <div className="grid grid-cols-[300px_1fr] h-full">
      <ul className="border-r overflow-auto">
        {files.map((f) => (
          <li key={f.path}>
            <button
              className={`w-full text-left px-2 py-1 text-sm ${path === f.path ? 'bg-accent' : ''}`}
              onClick={() => setPath(f.path)}
            >
              {f.path}
            </button>
          </li>
        ))}
      </ul>
      <div className="overflow-auto p-4">
        {path
          ? (path.endsWith('.md')
              ? <MarkdownPreview source={body} />
              : <pre className="text-xs whitespace-pre-wrap">{body}</pre>)
          : <div className="text-sm text-muted-foreground">Pick a file</div>}
      </div>
    </div>
  );
}
