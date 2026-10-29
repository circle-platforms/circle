import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { usePressAction } from '../src/components/ui';
import { t } from '../src/i18n';
import { applyTheme } from '../src/theme';
import '../src/styles/app.css';

applyTheme('dark');

function Fixture() {
  const [count, setCount] = useState(0);
  const press = usePressAction(() => setCount((value) => value + 1));
  return (
    <>
      <button className="sidebar-item" {...press}>
        {t('new session')}
      </button>
      <p className="elsewhere">elsewhere</p>
      <output data-count={count}>{count}</output>
    </>
  );
}

createRoot(document.getElementById('root')!).render(<Fixture />);
