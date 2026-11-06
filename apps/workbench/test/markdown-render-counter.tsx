// The real parser under the name Markdown imports it by, counting how often it runs.
import type { ComponentProps } from 'react';
import ReactMarkdown from '../node_modules/react-markdown/index.js';
export { defaultUrlTransform } from '../node_modules/react-markdown/index.js';

export default function Counted(props: ComponentProps<typeof ReactMarkdown>) {
  window.markdownParses++;
  return <ReactMarkdown {...props} />;
}
