import {
  Maximize2,
  Minimize2,
  PanelRight,
  PictureInPicture2,
} from 'lucide-react';
import { createContext, useContext, type ReactNode } from 'react';
import { IconButton } from '../components/common';
import { t } from '../i18n';
import '../styles/modes.css';

/**
 * What the drawer's window offers a mode: the mode across the whole workspace, and
 * for the browser and the terminal a window of their own. Each mode puts these at the
 * end of its own toolbar, where it has one.
 */
export interface ModeChromeValue {
  canBeWhole: boolean;
  whole: boolean;
  onWhole: () => void;
  /** Offered by the modes that can live in a window of their own. */
  onPopOut?: () => void;
  /** This mode is in a window of its own now, and the drawer leaves its page alone. */
  poppedOut?: boolean;
  /** Set in that window: the way back to the drawer. */
  onDock?: () => void;
}

const ModeChrome = createContext<ModeChromeValue | undefined>(undefined);

export function ModeChromeProvider({
  value,
  children,
}: {
  value: ModeChromeValue;
  children: ReactNode;
}) {
  return <ModeChrome.Provider value={value}>{children}</ModeChrome.Provider>;
}

export function useModeChrome(): ModeChromeValue | undefined {
  return useContext(ModeChrome);
}

/** The buttons a mode's toolbar ends with. A mode that offers neither renders nothing. */
export function ModeButtons({ popOut = false }: { popOut?: boolean }) {
  const chrome = useModeChrome();
  if (!chrome) return null;
  // In a window of its own the mode has no full view or window to offer, only the way back.
  if (chrome.onDock)
    return (
      <IconButton label={t('put back in the drawer')} onClick={chrome.onDock}>
        <PanelRight size={14} />
      </IconButton>
    );
  return (
    <>
      {popOut && chrome.onPopOut && (
        <IconButton label={t('open in a window')} onClick={chrome.onPopOut}>
          <PictureInPicture2 size={14} />
        </IconButton>
      )}
      {chrome.canBeWhole && (
        <IconButton
          label={chrome.whole ? t('exit full view') : t('full view')}
          aria-pressed={chrome.whole}
          className={`icon-button ${chrome.whole ? 'active' : ''}`}
          onClick={chrome.onWhole}
        >
          {chrome.whole ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
        </IconButton>
      )}
    </>
  );
}
