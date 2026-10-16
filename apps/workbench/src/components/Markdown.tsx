import { useState } from 'react';
import { t } from '../i18n';
import './markdown.css';
import ReactMarkdown, { defaultUrlTransform } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { useSources, sourceLocation } from './SourceNavigation';
import { remarkSourceLinks } from '../model/markdown-source-links';
import { copyText } from '../host';
import { highlight } from './highlight';
function CodeBlock({ language, code }: { language?: string; code: string }) {
  const [copied, setCopied] = useState(false);
  const tokens = highlight(code, language);
  return (
    <div className="code-block">
      <div className="code-block-bar">
        <span>{language || t('text')}</span>
        <button
          type="button"
          onClick={() => {
            void copyText(code).then(
              () => {
                setCopied(true);
                setTimeout(() => setCopied(false), 1200);
              },
              () => {},
            );
          }}
        >
          {copied ? t('copied') : t('copy')}
        </button>
      </div>
      <pre>
        <code>
          {tokens.map((token, index) =>
            token.kind === 'plain' ? (
              <span key={index}>{token.text}</span>
            ) : (
              <span key={index} className={`token-${token.kind}`}>
                {token.text}
              </span>
            ),
          )}
        </code>
      </pre>
    </div>
  );
}

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
          pre: ({ children }) => <>{children}</>,
          code: ({ className, children }) => {
            const code = String(children).replace(/\n$/, '');
            const language = /language-([\w+-]+)/.exec(className ?? '')?.[1];
            if (language || code.includes('\n'))
              return <CodeBlock language={language} code={code} />;
            return <code className="inline-code">{code}</code>;
          },
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}
