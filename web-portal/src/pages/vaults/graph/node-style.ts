import type { SymbolKind } from '../../../stores/vault-store';
import {
  Box,
  Circle,
  FileText,
  Folder,
  FunctionSquare,
  GitBranch,
  Hash,
  StickyNote,
  type LucideIcon,
} from 'lucide-react';

export interface KindStyle {
  /** Display label in the filter panel / tooltip. */
  label: string;
  /** Base accent color — CSS color string, works in dark and light themes. */
  color: string;
  /** Lucide icon for node header + filter checkbox. */
  icon: LucideIcon;
  /** Default node size rank (0..1) — GraphNode scales 160..260px width on this. */
  sizeRank: number;
}

// Color palette tuned for both dark and light themes. Prefer CSS vars where
// an existing design token already exists (accent / warning / success); falls
// back to hex values chosen against a mid-gray backdrop.
const KIND_STYLES: Record<SymbolKind, KindStyle> = {
  namespace: { label: 'Namespace', color: '#a78bfa', icon: Folder, sizeRank: 1.0 },
  class:     { label: 'Class',     color: '#00e5ff', icon: Box, sizeRank: 0.85 },
  interface: { label: 'Interface', color: '#34d399', icon: GitBranch, sizeRank: 0.8 },
  method:    { label: 'Method',    color: '#fbbf24', icon: FunctionSquare, sizeRank: 0.55 },
  function:  { label: 'Function',  color: '#fb923c', icon: FunctionSquare, sizeRank: 0.55 },
  field:     { label: 'Field',     color: '#f472b6', icon: Hash, sizeRank: 0.4 },
  note:      { label: 'Note',      color: '#9ca3af', icon: StickyNote, sizeRank: 0.45 },
};

const FALLBACK_STYLE: KindStyle = {
  label: 'Symbol', color: '#9ca3af', icon: Circle, sizeRank: 0.5,
};

const FILE_STYLE: KindStyle = {
  label: 'File', color: '#60a5fa', icon: FileText, sizeRank: 0.6,
};

/** Resolve a kind string (possibly loose/unknown) to a KindStyle. */
export function getKindStyle(kind: string | undefined | null): KindStyle {
  if (!kind) return FALLBACK_STYLE;
  if (kind === 'file') return FILE_STYLE;
  return (KIND_STYLES as Record<string, KindStyle>)[kind] ?? FALLBACK_STYLE;
}

export const KIND_STYLE_MAP: Readonly<Record<SymbolKind, KindStyle>> = KIND_STYLES;

/** Strip markdown emphasis markers used in backend canvas text. */
export function stripMarkdown(text: string): string {
  return text.replace(/\*\*/g, '').replace(/\*/g, '');
}

/** Parse `**kind** name\n\n*file:line*` backend text into structured parts. */
export function parseNodeText(text: string): { kind: string | null; name: string; file: string | null; line: number | null } {
  const stripped = stripMarkdown(text);
  const [head = '', tail = ''] = stripped.split('\n\n');
  const headMatch = head.match(/^(\S+)\s+(.+)$/);
  const kind = headMatch?.[1] ?? null;
  const name = headMatch?.[2] ?? head;
  const tailMatch = tail.match(/^(.+):(\d+)$/);
  const file = tailMatch?.[1] ?? null;
  const line = tailMatch ? Number(tailMatch[2]) : null;
  return { kind, name, file, line };
}
