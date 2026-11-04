import { Check, Copy } from 'lucide-react';
import { memo, useState, type ReactNode } from 'react';
import ReactMarkdown from 'react-markdown';
import rehypeHighlight from 'rehype-highlight';
import remarkGfm from 'remark-gfm';
import { cx } from '@/components/common/ui';

const CITE = /\[(S\d+(?:\s*,\s*S\d+)*)\]/g;

/** Turn [S1] / [S1, S2] into internal links rendered as citation chips. */
export function linkCitations(text: string): string {
  return text.replace(CITE, (_, ids: string) => ids.split(/\s*,\s*/).map((id) => `[${id}](#cite-${id})`).join(''));
}

function CodeBlock({ children }: { children: ReactNode }) {
  const [copied, setCopied] = useState(false);
  const getText = (n: ReactNode): string =>
    typeof n === 'string' ? n : Array.isArray(n) ? n.map(getText).join('') : n && typeof n === 'object' && 'props' in n ? getText((n as { props: { children: ReactNode } }).props.children) : '';
  return (
    <div className="group relative">
      <button
        aria-label="Copy code"
        className="absolute right-1.5 top-1.5 rounded border border-border bg-bg p-1 text-muted opacity-0 transition-opacity group-hover:opacity-100 focus:opacity-100"
        onClick={() => navigator.clipboard.writeText(getText(children)).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1200); })}
      >
        {copied ? <Check className="size-3" /> : <Copy className="size-3" />}
      </button>
      <pre>{children}</pre>
    </div>
  );
}

export const Markdown = memo(function Markdown({ text, validIds, onCite }: { text: string; validIds?: Set<string>; onCite?: (id: string) => void }) {
  return (
    <div className="prose-chat">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[[rehypeHighlight, { detect: true, ignoreMissing: true }]]}
        components={{
          pre: ({ children }) => <CodeBlock>{children}</CodeBlock>,
          a: ({ href, children }) => {
            if (href?.startsWith('#cite-')) {
              const id = href.slice(6);
              const valid = !validIds || validIds.has(id);
              return (
                <button
                  type="button"
                  onClick={() => valid && onCite?.(id)}
                  title={valid ? `Source ${id}` : 'This citation does not match any provided source'}
                  className={cx('mx-0.5 inline-flex h-4 items-center rounded px-1 align-text-top text-[0.65rem] font-semibold no-underline',
                    valid ? 'bg-accent/15 text-accent' : 'bg-bad/15 text-bad line-through')}
                >
                  {id}
                </button>
              );
            }
            const safe = href && /^https?:/i.test(href) ? href : undefined;
            return <a href={safe} target="_blank" rel="noopener noreferrer">{children}</a>;
          },
          img: ({ alt }) => <span className="text-muted">[image: {alt}]</span>,
        }}
      >
        {linkCitations(text)}
      </ReactMarkdown>
    </div>
  );
});
