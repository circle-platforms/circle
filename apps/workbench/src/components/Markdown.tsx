import { useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Code } from 'lucide-react';
import { copyText } from '../host';
import { t } from '../i18n';
import { highlight } from './highlight';

const LANGUAGE_NAMES: Record<string, string> = {
  ts: 'TypeScript',
  tsx: 'TSX',
  js: 'JavaScript',
  jsx: 'JSX',
  py: 'Python',
  python: 'Python',
  rb: 'Ruby',
  go: 'Go',
  rs: 'Rust',
  sh: 'Shell',
  bash: 'Shell',
  zsh: 'Shell',
  md: 'Markdown',
  json: 'JSON',
  yml: 'YAML',
  yaml: 'YAML',
  html: 'HTML',
  css: 'CSS',
  sql: 'SQL',
};

function languageName(language?: string): string {
  if (!language) return t('text');
  return (
    LANGUAGE_NAMES[language.toLowerCase()] ??
    language.slice(0, 1).toUpperCase() + language.slice(1)
  );
}

function CodeBlock({ language, code }: { language?: string; code: string }) {
  const [copied, setCopied] = useState(false);
  const tokens = highlight(code, language);
  return (
    <div className="code-block">
      <div className="code-block-bar">
        <span className="code-lang">
          <Code size={12} aria-hidden="true" />
          {languageName(language)}
        </span>
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
