import { t } from '../i18n';
import './markdown.css';
import ReactMarkdown, { defaultUrlTransform } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { useSources, sourceLocation } from './SourceNavigation';
import { remarkSourceLinks } from '../model/markdown-source-links';
export function Markdown({ text }: { text: string }) {
  const sources = useSources();
  return (
    <div className="markdown">
      <ReactMarkdown
        remarkPlugins={sources ? [remarkGfm, remarkSourceLinks] : [remarkGfm]}
        urlTransform={(url) =>
          sourceLocation(url) ? url : defaultUrlTransform(url)
        }
        components={{
          table: ({ children }) => (
            <div
              className="markdown-table-scroll"
              role="region"
              aria-label={t('response table')}
              tabIndex={0}
            >
              <table>{children}</table>
            </div>
          ),
          a: ({ children, href }) => (
            <a
              href={href}
              target="_blank"
              rel="noreferrer"
              onClick={(event) => {
                const target = href && sourceLocation(href);
                if (target && sources) {
                  event.preventDefault();
                  sources.openFile(target.path, target.line, target.column);
                }
              }}
            >
              {children}
            </a>
          ),
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}
