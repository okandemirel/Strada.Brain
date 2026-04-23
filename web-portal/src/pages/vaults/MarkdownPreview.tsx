import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import rehypeSanitize from 'rehype-sanitize';

const REMARK_PLUGINS = [remarkGfm];
const REHYPE_PLUGINS = [rehypeHighlight, rehypeSanitize];

export default function MarkdownPreview({ source }: { source: string }) {
  return (
    <div className="prose prose-sm max-w-none">
      <ReactMarkdown remarkPlugins={REMARK_PLUGINS} rehypePlugins={REHYPE_PLUGINS}>
        {source}
      </ReactMarkdown>
    </div>
  );
}
