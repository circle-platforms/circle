import { useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { copyText } from '../host';
import { t } from '../i18n';
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
  return (
    <div className="markdown">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ children, href }) => (
            <a href={href} target="_blank" rel="noreferrer">
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
