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

test('a session column keeps the composer inside the window', () => {
  // Each rule is the one that starts a line, not a descendant selector ending in it.
  const workbench = css.match(/^\.workbench \{[^}]*\}/m)?.[0] ?? '';
  assert.match(workbench, /grid-template-rows:\s*minmax\(0,\s*1fr\)/);
  assert.match(workbench, /overflow:\s*hidden/);
  // 100dvh is taller than a maximized Linux window, so the footer was clipped.
  assert.match(workbench, /height:\s*100%/);
  assert.doesNotMatch(workbench, /100dvh/);
  const side = css.match(/^\.desktop-sidebar \{[^}]*\}/m)?.[0] ?? '';
  assert.match(side, /min-height:\s*0/);
  assert.match(side, /overflow:\s*hidden/);
  const workspace = css.match(/^\.workspace \{[^}]*\}/m)?.[0] ?? '';
  assert.match(workspace, /overflow:\s*hidden/);
  assert.match(workspace, /min-height:\s*0/);
  const content = css.match(/^\.workspace-content \{[^}]*\}/m)?.[0] ?? '';
  assert.match(content, /min-height:\s*0/);
  assert.match(content, /overflow:\s*hidden/);
  const panel = css.indexOf('.workspace-content [data-panel]');
  const inner = css.indexOf('.workspace-content [data-panel] > div');
  assert.ok(panel > 0 && inner > panel);
  const panelBlock = css.slice(panel).match(/\{[^}]*\}/)?.[0] ?? '';
  const innerBlock = css.slice(inner).match(/\{[^}]*\}/)?.[0] ?? '';
  assert.match(panelBlock, /height:\s*100%\s*!important/);
  assert.match(panelBlock, /overflow:\s*hidden\s*!important/);
  assert.match(innerBlock, /height:\s*100%\s*!important/);
  assert.match(innerBlock, /overflow:\s*hidden\s*!important/);
  assert.match(innerBlock, /flex-direction:\s*column/);
  const conversation = css.match(/^\.conversation \{[^}]*\}/m)?.[0] ?? '';
  assert.match(conversation, /overflow:\s*hidden/);
  assert.match(conversation, /min-height:\s*0/);
  const mark = css.indexOf('The transcript scrolls; this stays.');
  const composerBlock =
    css.slice(mark).match(/\.composer-area \{[^}]*\}/)?.[0] ?? '';
  assert.match(composerBlock, /flex:\s*0 0 auto/);
});

// The owner's decision (2026-10-28): search, settings and hiding the sidebar are
// icons at the right end of the sidebar footer, and the top bar has no menu of its own.
test('search, settings and hide are icons at the end of the sidebar footer', () => {
  const sidebar = readFileSync(
    fileURLToPath(new URL('../src/components/Sidebar.tsx', import.meta.url)),
    'utf8',
  );
  const footer = sidebar.slice(
    sidebar.indexOf('<footer className="sidebar-footer">'),
  );
  const actions = footer.slice(footer.indexOf('sidebar-footer-actions'));
  assert.ok(
    footer.indexOf('connection-status') <
      footer.indexOf('sidebar-footer-actions'),
  );
  const search = actions.indexOf("label={t('search')}");
  const settings = actions.indexOf("label={t('settings')}");
  const hide = actions.indexOf("label={t('hide sidebar')}");
  assert.ok(search > 0 && settings > search, 'search, then settings');
  assert.ok(hide > settings, 'then hide the sidebar');
  assert.doesNotMatch(sidebar, /className="sidebar-search"/);
  const app = readFileSync(
    fileURLToPath(new URL('../src/app/App.tsx', import.meta.url)),
    'utf8',
  );
  assert.doesNotMatch(app, /aria-label=\{t\('more'\)\}/);
  assert.doesNotMatch(app, /t\('dark theme'\)/);
});

test('changes and the browser can take the full view', () => {
  const source = readFileSync(
    fileURLToPath(new URL('../src/plugins/builtins.tsx', import.meta.url)),
    'utf8',
  );
  const fullView = (id: string) => {
    const marker = `id: '${id}'`;
    let from = 0;
    while (from < source.length) {
      const at = source.indexOf(marker, from);
      if (at < 0) return false;
      const next = source.indexOf('id:', at + marker.length);
      const block = source.slice(at, next < 0 ? source.length : next);
      if (/fullView:\s*true/.test(block)) return true;
      from = at + marker.length;
    }
    return false;
  };
  assert.equal(fullView('changes'), true);
  assert.equal(fullView('browser'), true);
  assert.equal(fullView('files'), false);
});

test('the effort menu is not capped by the shared footbar menu', () => {
  const shared = css.indexOf('.footbar-menu {');
  const effort = css.indexOf('.footbar-menu.effort-menu');
  assert.ok(shared > 0 && effort > shared);
  const block = css.slice(effort).match(/\{[^}]*\}/)?.[0] ?? '';
  assert.match(block, /max-height:\s*none/);
  assert.match(block, /overflow:\s*visible/);
});
