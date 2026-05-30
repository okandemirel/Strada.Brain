import ReactMarkdown from 'react-markdown';
import { REMARK_PLUGINS, REHYPE_PLUGINS } from '@/lib/markdown';

export default function MarkdownPreview({ source }: { source: string }) {
  return (
    <div className="prose prose-sm max-w-none">
      <ReactMarkdown remarkPlugins={REMARK_PLUGINS} rehypePlugins={REHYPE_PLUGINS}>
        {source}
      </ReactMarkdown>
    </div>
  );
}
