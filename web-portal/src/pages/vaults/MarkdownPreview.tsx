import type { MouseEvent } from 'react';
import ReactMarkdown from 'react-markdown';
import { REMARK_PLUGINS, REHYPE_PLUGINS } from '@/lib/markdown';

interface MarkdownPreviewProps {
  source: string;
  /** Invoked with the raw wikilink target when a `[[...]]` link is clicked. */
  onWikilink?: (target: string) => void;
}

export default function MarkdownPreview({ source, onWikilink }: MarkdownPreviewProps) {
  // Click delegation: wikilinks render as inert spans carrying
  // `data-wikilink-target` (sanitize-safe). One handler on the wrapper resolves
  // the clicked span instead of attaching a handler per rendered node.
  const handleClick = onWikilink
    ? (e: MouseEvent<HTMLDivElement>) => {
        const el = (e.target as HTMLElement).closest('[data-wikilink-target]');
        const target = el?.getAttribute('data-wikilink-target');
        if (target) {
          e.preventDefault();
          onWikilink(target);
        }
      }
    : undefined;

  return (
    <div className="prose prose-sm max-w-none" onClick={handleClick}>
      <ReactMarkdown remarkPlugins={REMARK_PLUGINS} rehypePlugins={REHYPE_PLUGINS}>
        {source}
      </ReactMarkdown>
    </div>
  );
}
