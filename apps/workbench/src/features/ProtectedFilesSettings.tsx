import { useState } from 'react';
import {
  DEFAULT_CREDENTIAL_FILES,
  matchPattern,
} from '../../../../src/file_patterns';
import { useRuntime } from '../app/context';
import { Button, Fold } from '../components/common';
import { t, tn } from '../i18n';

// Windows file names are not case sensitive, and src/approvals.ts matches a
// pattern case-insensitively there. The check below follows the machine this
// window runs on, so a pattern reads here as it does on this machine's runtime.
const insensitiveNames = () => !/Mac|Linux|Android/i.test(navigator.userAgent);
// Only the name counts, so a folder in front of it is dropped, as it is in the runtime.
const fileName = (value: string) => value.trim().split(/[/\\]/).at(-1) ?? '';

/**
 * Name-based file and command protections. Circle always protects a list of its
 * own; this page adds to it and says what a name would do before it is saved.
 */
export function ProtectedFilesSettings() {
  const { snapshot, runtime } = useRuntime();
  const patterns = snapshot.settings.credentialFiles;
  const [draft, setDraft] = useState('');
  const [problem, setProblem] = useState('');
  const [probe, setProbe] = useState('');
  const [shown, setShown] = useState(false);
  const save = (next: string[]) =>
    runtime.change((state) => {
      state.settings.credentialFiles = next;
    });
  const add = () => {
    const pattern = draft.trim();
    if (!pattern) return;
    // A pattern is matched against the name, so a folder in front of it matches
    // nothing: say so instead of quietly saving something that never fires.
    if (/[/\\]/.test(pattern)) {
      setProblem(t('a pattern is a file name, not a path: drop the folders'));
      return;
    }
    if (patterns.includes(pattern)) {
      setProblem(t('{pattern} is already on the list', { pattern }));
      return;
    }
    if (DEFAULT_CREDENTIAL_FILES.includes(pattern)) {
      setProblem(
        t('{pattern} is on the always protected list, so it needs no pattern', {
          pattern,
        }),
      );
      return;
    }
    save([...patterns, pattern]);
    setDraft('');
    setProblem('');
  };
  const checked = fileName(probe);
  const hit = checked
    ? [...DEFAULT_CREDENTIAL_FILES, ...patterns].find((pattern) =>
        matchPattern(pattern, checked, insensitiveNames()),
      )
    : undefined;
  return (
    <section className="settings-block">
      <h2>{t('protected files')}</h2>
      <p className="panel-note">
        {t(
          'File tools skip or refuse matching names, and shell commands that name one are denied. Commands that reach a file indirectly are not blocked. * is any run of characters and ? is one character, and only the name counts: write *.key, never secrets/*.key.',
        )}
      </p>
      <div className="pattern-add">
        <input
          className="input"
          aria-label={t('new file pattern')}
          placeholder={t('for example *.key')}
          spellCheck={false}
          value={draft}
          onChange={(event) => {
            setDraft(event.target.value);
            setProblem('');
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              add();
            }
          }}
        />
        <Button onClick={add} disabled={!draft.trim()}>
          {t('add')}
        </Button>
      </div>
      {problem && (
        <p className="field-problem" role="status">
          {problem}
        </p>
      )}
      {patterns.length ? (
        <ul className="pattern-list">
          {patterns.map((pattern) => (
            <li key={pattern}>
              <code>{pattern}</code>
              <Button
                onClick={() => save(patterns.filter((row) => row !== pattern))}
              >
                {t('remove {pattern}', { pattern })}
              </Button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="panel-note">{t('no extra patterns yet')}</p>
      )}
      <p className="panel-note">
        {tn(patterns.length, '{n} extra pattern', '{n} extra patterns')} ·{' '}
        {t(
          'Circle reads these when it starts, so restart the application for a change to take effect.',
        )}
      </p>
      <label className="field-label">
        {t('check a file name')}
        <input
          className="input"
          placeholder={t('for example deploy.key')}
          spellCheck={false}
          value={probe}
          onChange={(event) => setProbe(event.target.value)}
        />
      </label>
      {checked && (
        <p className="panel-note" role="status">
          {hit
            ? t('{name} is protected by {pattern}', {
                name: checked,
                pattern: hit,
              })
            : t('{name} is not protected', { name: checked })}
        </p>
      )}
      <Fold
        title={t('always protected · {n} patterns', {
          n: DEFAULT_CREDENTIAL_FILES.length,
        })}
        open={shown}
        onToggle={() => setShown(!shown)}
      >
        <p>
          {t(
            "Circle's own list. An extra pattern adds to it and can never take a name away from it.",
          )}
        </p>
        <div className="pattern-chips">
          {DEFAULT_CREDENTIAL_FILES.map((pattern) => (
            <code key={pattern}>{pattern}</code>
          ))}
        </div>
      </Fold>
    </section>
  );
}
