import { Tooltip } from 'radix-ui';
import { createRoot } from 'react-dom/client';
import { useEffect, useState } from 'react';
import { SettingsNavigation } from '../src/features/SettingsNavigation';
import { t, setLanguage } from '../src/i18n';
import { applyTheme } from '../src/theme';
import '../src/styles/app.css';
const params = new URLSearchParams(location.search);
setLanguage(params.get('language') === 'zh-CN' ? 'zh-CN' : 'en');
applyTheme(params.get('theme') === 'dark' ? 'dark' : 'light');
const effects = { mounts: 0, unmounts: 0, changes: 0, escaped: 0 };
Object.assign(window, { settingsEffects: effects });
function Form() {
  const [value, setValue] = useState('unsubmitted settings draft');
  useEffect(() => {
    effects.mounts++;
    return () => {
      effects.unmounts++;
    };
  }, []);
  return (
    <section className="settings-block">
      <h2>{t('protected files')}</h2>
      <label className="field-label" htmlFor="settings-local-draft">
        {t('additional file patterns')}
      </label>
      <textarea
        id="settings-local-draft"
        value={value}
        onChange={(event) => {
          effects.changes++;
          setValue(event.target.value);
        }}
      />
      <input
        type="password"
        defaultValue="secret-token-must-not-be-indexed"
        aria-label="synthetic credential"
      />
    </section>
  );
}
function Fixture() {
  return (
    <div
      className="page settings-page"
      onKeyDown={(event) => {
        if (event.key === 'Escape') effects.escaped++;
      }}
    >
      <h1>{t('settings')}</h1>
      <SettingsNavigation>
        <section className="settings-block first">
          <h2>{t('appearance')}</h2>
          <div className="setting-row">
            <span>{t('theme')}</span>
            <button>{t('light')}</button>
          </div>
        </section>
        <Form />
        <section className="settings-block" style={{ minHeight: 350 }}>
          <h2>{t('keyboard')}</h2>
          <button>{t('view shortcuts')}</button>
        </section>
      </SettingsNavigation>
    </div>
  );
}
createRoot(document.getElementById('root')!).render(
  <Tooltip.Provider>
    <Fixture />
  </Tooltip.Provider>,
);
