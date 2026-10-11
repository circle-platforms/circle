import { cpSync, existsSync, mkdirSync } from 'node:fs';
mkdirSync('dist/prompts', { recursive: true });
cpSync('src/prompts', 'dist/prompts', {
  recursive: true,
  filter: (path) => !path.endsWith('.ts'),
});
cpSync('src/data', 'dist/data', { recursive: true });
// Extensions that ship with Circle are copied as written; Node loads extension.ts itself.
if (existsSync('src/extensions'))
  cpSync('src/extensions', 'dist/extensions', { recursive: true });
