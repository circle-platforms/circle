import { useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Code } from 'lucide-react';
import { splitAutolink } from '../../../../src/autolink.ts';
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

// GFM autolinks run on through fullwidth punctuation. Stop at it, and leave
// the following characters as text.
type MarkdownNode = {
  type?: string;
  url?: string;
  value?: string;
  children?: MarkdownNode[];
};
function remarkFullwidthAutolinks() {
  const walk = (node: MarkdownNode) => {
    const children = node.children;
    if (!children) return;
    for (let index = 0; index < children.length; index++) {
      const child = children[index]!;
      if (
        child.type === 'link' &&
        child.children?.length === 1 &&
        child.children[0]?.type === 'text'
      ) {
        const shown = String(child.children[0].value ?? '');
        const href = String(child.url ?? '');
        if (
          shown &&
          (shown === href ||
            href === `http://${shown}` ||
            href === `https://${shown}`)
        ) {
          const { url, rest } = splitAutolink(shown);
          if (rest) {
            child.children[0].value = url;
            child.url = shown.startsWith('www.') ? `http://${url}` : url;
            const next = children[index + 1];
            if (next?.type === 'text')
              next.value = rest + String(next.value ?? '');
            else children.splice(index + 1, 0, { type: 'text', value: rest });
          }
        }
      }
      walk(child);
    }
  };
  return (tree: MarkdownNode) => walk(tree);
}
export function Markdown({ text }: { text: string }) {
  return (
    <div className="markdown">
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkFullwidthAutolinks]}
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
