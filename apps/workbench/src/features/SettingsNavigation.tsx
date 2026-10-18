import {
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { SearchInput } from '../components/common';
import { t } from '../i18n';
import { matchesSettingsSection } from '../model/settings-navigation';
import './navigation-settings.css';

interface Section {
  id: string;
  label: string;
  keywords: string;
}

/** A local index: finding a setting never remounts its form or saves a value. */
export function SettingsNavigation({ children }: { children: ReactNode }) {
  const prefix = useId();
  const content = useRef<HTMLDivElement>(null);
  const targets = useRef(new Map<string, HTMLElement>());
  const headingIds = useRef(new WeakMap<HTMLElement, string>());
  const nextHeadingId = useRef(0);
  const [sections, setSections] = useState<Section[]>([]);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState('');
  // Read the headings that are actually present, including native-only sections.
  // Keep form state and resource effects mounted while filtering the index.
  useLayoutEffect(() => {
    const found: Section[] = [];
    const nextTargets = new Map<string, HTMLElement>();
    for (const heading of content.current?.querySelectorAll<HTMLElement>(
      '.settings-block > h2',
    ) ?? []) {
      const id =
        headingIds.current.get(heading) ??
        `${prefix}-section-${nextHeadingId.current++}`;
      headingIds.current.set(heading, id);
      const label = heading.textContent?.trim() ?? '';
      if (!label) continue;
      heading.id = id;
      heading.tabIndex = -1;
      nextTargets.set(id, heading);
      const labels = heading.parentElement?.querySelectorAll(
        '.setting-row > span:first-child, .field-label, .toggle',
      );
      found.push({
        id,
        label,
        // Search labels, never credential values, model output or file contents.
        keywords: [...(labels ?? [])]
          .map((label) => label.firstChild?.textContent ?? '')
          .join(' '),
      });
    }
    targets.current = nextTargets;
    setSections((previous) =>
      JSON.stringify(previous) === JSON.stringify(found) ? previous : found,
    );
  });
  const shown = sections.filter((section) =>
    matchesSettingsSection(query, section.label, section.keywords),
  );
  const go = (id: string) => {
    const heading = targets.current.get(id);
    if (!heading) return;
    setActive(id);
    heading.focus({ preventScroll: true });
    heading.scrollIntoView({ block: 'start' });
  };
  return (
    <div className="settings-layout">
      <nav className="settings-index" aria-label={t('settings sections')}>
        <SearchInput
          label={t('search settings')}
          value={query}
          onChange={setQuery}
          inputProps={{
            onKeyDown: (event) => {
              if (event.key === 'Escape' && query) {
                event.preventDefault();
                event.stopPropagation();
                setQuery('');
              } else if (event.key === 'Enter' && shown[0]) {
                event.preventDefault();
                go(shown[0].id);
              }
            },
          }}
        />
        <div className="settings-index-list">
          {shown.map((section) => (
            <button
              key={section.id}
              type="button"
              aria-current={active === section.id ? 'location' : undefined}
              onClick={() => go(section.id)}
            >
              {section.label}
            </button>
          ))}
          {!shown.length && (
            <p className="muted" role="status">
              {t('no matching settings')}
            </p>
          )}
        </div>
      </nav>
      <div className="settings-sections" ref={content}>
        {children}
      </div>
    </div>
  );
}
