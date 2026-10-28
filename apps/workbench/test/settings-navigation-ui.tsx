import { Tooltip } from 'radix-ui';
import { createRoot } from 'react-dom/client';
import { useState } from 'react';
import { SettingsLayout } from '../src/features/SettingsLayout';
import { t, setLanguage } from '../src/i18n';
import { applyTheme } from '../src/theme';
import '../src/styles/app.css';
const params = new URLSearchParams(location.search);
setLanguage(params.get('language') === 'zh-CN' ? 'zh-CN' : 'en');
applyTheme(params.get('theme') === 'dark' ? 'dark' : 'light');
const effects = { selected: [] as string[], escaped: 0 };
Object.assign(window, { settingsEffects: effects });
// Three headings, four groups: the shape of the real dialog, without its runtime.
const groups = () => [
  {
    id: 'general',
    label: t('general'),
    sections: [
      {
        id: 'appearance',
        label: t('appearance'),
        keywords: [t('theme'), t('text size'), t('language')].join(' '),
      },
      {
        id: 'shortcuts',
        label: t('shortcuts'),
        keywords: t('view shortcuts'),
      },
    ],
  },
  {
    id: 'capabilities',
    label: t('capabilities'),
    sections: [
      { id: 'skills', label: t('skills'), keywords: '' },
      {
        id: 'extensions',
        label: t('extensions'),
        keywords: [t('interface components'), 'GitHub'].join(' '),
      },
    ],
  },
  {
    id: 'safety',
    label: t('permissions & safety'),
    sections: [
      {
        id: 'files',
        label: t('file access'),
        keywords: t('protected files'),
      },
    ],
  },
];
function Fixture() {
  const [active, setActive] = useState('appearance');
  return (
    <div
      className="dialog-content settings-dialog"
      onKeyDown={(event) => {
        if (event.key === 'Escape') effects.escaped++;
      }}
    >
      <div className="dialog-heading">
        <h2>{t('settings')}</h2>
      </div>
      <SettingsLayout
        groups={groups()}
        active={active}
        onSelect={(id) => {
          effects.selected.push(id);
          setActive(id);
        }}
      >
        {/* A long page, to see that a new group starts at its top. */}
        <section className="page" key={active} data-group={active}>
          <header className="page-heading">
            <div>
              <h1>{active}</h1>
            </div>
          </header>
          <input
            aria-label="synthetic credential"
            defaultValue="secret-token"
          />
          <div style={{ height: 1600 }} />
        </section>
      </SettingsLayout>
    </div>
  );
}
createRoot(document.getElementById('root')!).render(
  <Tooltip.Provider>
    <Fixture />
  </Tooltip.Provider>,
);
