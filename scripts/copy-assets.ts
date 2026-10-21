import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
// What the compiled program reads beside itself, into dist/ or the folder given (a test's).
const out = process.argv[2] || 'dist';
mkdirSync(join(out, 'prompts'), { recursive: true });
cpSync('src/prompts', join(out, 'prompts'), {
  recursive: true,
  filter: (path) => !path.endsWith('.ts'),
});
cpSync('src/data', join(out, 'data'), { recursive: true });
// The skills that ship with Circle; skills.ts looks for them beside itself.
cpSync('src/builtin_skills', join(out, 'builtin_skills'), { recursive: true });
// Extensions that ship with Circle are copied as written; Node loads extension.ts itself.
// The folder is replaced, so one that Circle no longer ships does not stay behind from an
// earlier build, where it would still be found and could be packaged.
rmSync(join(out, 'extensions'), { recursive: true, force: true });
if (existsSync('src/extensions'))
  cpSync('src/extensions', join(out, 'extensions'), { recursive: true });
