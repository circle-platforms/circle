import {
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import { SearchInput } from '../components/common';
import { t } from '../i18n';
import { matchesSettingsSection } from '../model/settings-navigation';
import './navigation-settings.css';

export interface SettingsNavGroup {
  id: string;
  label: string;
  sections: { id: string; label: string; keywords: string }[];
}

/**
 * The settings dialog's body: the groups listed at the left under their headings,
 * and the chosen one at the right. The search box narrows the list without
 * opening anything, and enter opens its first match.
 */
export function SettingsLayout({
  groups,
  active,
  onSelect,
  children,
}: {
  groups: readonly SettingsNavGroup[];
  active: string;
  onSelect: (id: string) => void;
  children: ReactNode;
}) {
  const prefix = useId();
  const [query, setQuery] = useState('');
  const list = useRef<HTMLDivElement>(null);
  const pane = useRef<HTMLDivElement>(null);
  const shown = groups
    .map((group) => ({
      ...group,
      sections: group.sections.filter((section) =>
        matchesSettingsSection(query, section.label, section.keywords),
      ),
    }))
    .filter((group) => group.sections.length);
  const first = shown[0]?.sections[0];
  const label = groups
    .flatMap((group) => group.sections)
    .find((section) => section.id === active)?.label;
  // A group opens at its top, not where the last one was scrolled to, and its
  // name is in view in the list, as it may not be after an address opened it.
  useEffect(() => {
    pane.current?.scrollTo?.({ top: 0 });
    list.current
      ?.querySelector('[aria-current="page"]')
      ?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
  }, [active]);
  const buttons = () => [
    ...(list.current?.querySelectorAll<HTMLButtonElement>('button') ?? []),
  ];
  const step = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    const all = buttons();
    const at = all.indexOf(document.activeElement as HTMLButtonElement);
    const next = all[at + (event.key === 'ArrowDown' ? 1 : -1)];
    if (at < 0 || !next) return;
    event.preventDefault();
    next.focus();
  };
  return (
    <div className="settings-layout">
      <nav className="settings-index" aria-label={t('settings sections')}>
        <SearchInput
          autoFocus
          label={t('search settings')}
          value={query}
          onChange={setQuery}
          inputProps={{
            onKeyDown: (event) => {
              if (event.key === 'Escape' && query) {
                event.preventDefault();
                event.stopPropagation();
                setQuery('');
              } else if (event.key === 'Enter' && first) {
                event.preventDefault();
                onSelect(first.id);
              } else if (event.key === 'ArrowDown') {
                event.preventDefault();
                buttons()[0]?.focus();
              }
            },
          }}
        />
        <div className="settings-index-list" ref={list} onKeyDown={step}>
          {shown.map((group) => (
            <div
              className="settings-group"
              key={group.id}
              role="group"
              aria-labelledby={`${prefix}-${group.id}`}
            >
              <p className="settings-group-label" id={`${prefix}-${group.id}`}>
                {group.label}
              </p>
              {group.sections.map((section) => (
                <button
                  key={section.id}
                  type="button"
                  aria-current={active === section.id ? 'page' : undefined}
                  onClick={() => onSelect(section.id)}
                >
                  {section.label}
                </button>
              ))}
            </div>
          ))}
          {!shown.length && (
            <p className="muted" role="status">
              {t('no matching settings')}
            </p>
          )}
        </div>
      </nav>
      <div
        className="settings-sections"
        ref={pane}
        role="region"
        aria-label={label}
      >
        {children}
      </div>
    </div>
  );
}
