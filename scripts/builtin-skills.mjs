import { cp, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));

export async function copyBuiltinSkills(out) {
  const skills = join(out, 'builtin_skills');
  await rm(skills, { recursive: true, force: true });
  await cp(join(root, 'src/builtin_skills'), skills, { recursive: true });
  await cp(join(root, 'docs'), join(skills, 'circle-help/references/docs'), {
    recursive: true,
  });
}
