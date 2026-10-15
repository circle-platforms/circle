import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const css = readFileSync(
  fileURLToPath(new URL('../src/styles/app.css', import.meta.url)),
  'utf8',
);

test('hiding the sidebar does not leave a zero-width track', () => {
  const block =
    css.match(/\.workbench\.sidebar-collapsed\s*\{[^}]*\}/)?.[0] ?? '';
  assert.match(block, /grid-template-columns:\s*minmax\(0,\s*1fr\)/);
  assert.doesNotMatch(block, /grid-template-columns:\s*0\b/);
});

test('the effort menu is not capped by the shared footbar menu', () => {
  const shared = css.indexOf('.footbar-menu {');
  const effort = css.indexOf('.footbar-menu.effort-menu');
  assert.ok(shared > 0 && effort > shared);
  const block = css.slice(effort).match(/\{[^}]*\}/)?.[0] ?? '';
  assert.match(block, /max-height:\s*none/);
  assert.match(block, /overflow:\s*visible/);
});
