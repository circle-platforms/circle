import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const css = readFileSync(
  fileURLToPath(new URL('../src/styles/app.css', import.meta.url)),
  'utf8',
);
const sessionCss = readFileSync(
  fileURLToPath(
    new URL('../src/styles/session-management.css', import.meta.url),
  ),
  'utf8',
);

test('hiding the sidebar does not leave a zero-width track', () => {
  const block =
    css.match(/\.workbench\.sidebar-collapsed\s*\{[^}]*\}/)?.[0] ?? '';
  assert.match(block, /grid-template-columns:\s*minmax\(0,\s*1fr\)/);
  assert.doesNotMatch(block, /grid-template-columns:\s*0\b/);
});

test('the rename field keeps the menu slot beside the row highlight', () => {
  const field =
    css.match(/\.session-row > \.session-rename\s*\{[^}]*\}/)?.[0] ?? '';
  assert.match(field, /width:\s*auto/);
  assert.match(field, /min-width:\s*0/);
  assert.doesNotMatch(field, /width:\s*100%/);
  const button =
    sessionCss.match(/\.session-row > \.icon-button\s*\{[^}]*\}/)?.[0] ?? '';
  const gap = sessionCss.match(/\.session-menu-gap\s*\{[^}]*\}/)?.[0] ?? '';
  assert.match(button, /width:\s*24px/);
  assert.match(gap, /flex:\s*0 0 24px/);
  assert.match(gap, /width:\s*24px/);
});

test('an empty variable or secret row does not highlight on hover', () => {
  const hover = css.indexOf('.variable-table tbody tr:hover');
  const empty = css.indexOf('.variable-table tbody tr.variable-empty-row');
  assert.ok(hover > 0 && empty > hover);
  const block = css.slice(empty).match(/\{[^}]*\}/)?.[0] ?? '';
  assert.match(block, /background:\s*transparent/);
  assert.match(block, /cursor:\s*default/);
  const table = readFileSync(
    fileURLToPath(
      new URL('../src/features/VariablesSettings.tsx', import.meta.url),
    ),
    'utf8',
  );
  assert.match(table, /<tr className="variable-empty-row">/);
});

test('the effort menu is not capped by the shared footbar menu', () => {
  const shared = css.indexOf('.footbar-menu {');
  const effort = css.indexOf('.footbar-menu.effort-menu');
  assert.ok(shared > 0 && effort > shared);
  const block = css.slice(effort).match(/\{[^}]*\}/)?.[0] ?? '';
  assert.match(block, /max-height:\s*none/);
  assert.match(block, /overflow:\s*visible/);
});
