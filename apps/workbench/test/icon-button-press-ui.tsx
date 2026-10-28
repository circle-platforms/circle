import { Tooltip } from 'radix-ui';
import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { IconButton } from '../src/components/ui';
import { setLanguage, t } from '../src/i18n';
import { applyTheme } from '../src/theme';
import '../src/styles/app.css';

const params = new URLSearchParams(location.search);
setLanguage(params.get('language') === 'zh-CN' ? 'zh-CN' : 'en');
applyTheme(params.get('theme') === 'light' ? 'light' : 'dark');

function Fixture() {
  const [visible, setVisible] = useState(true);
  const [tip, setTip] = useState(true);
  const [count, setCount] = useState(0);
  const keepOpen = params.has('keep');
  return (
    <Tooltip.Provider>
      <div hidden={!visible}>
        <IconButton
          label={t('open in a window')}
          tipOpen={tip}
          onClick={() => {
            setCount((value) => value + 1);
            if (!keepOpen) {
              setVisible(false);
              setTip(false);
            }
          }}
        >
          open
        </IconButton>
      </div>
      <button onClick={() => setVisible(true)}>show drawer</button>
      <output data-count={count}>{count}</output>
    </Tooltip.Provider>
  );
}

createRoot(document.getElementById('root')!).render(<Fixture />);
