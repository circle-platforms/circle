import { createContext, useContext } from 'react';
import { useRuntime } from './context';
import {
  addDraftAttachment,
  type AddToDraft,
} from '../model/draft-attachments';

const DraftContext = createContext<AddToDraft | undefined>(undefined);
/**
 * Where a window's modes put what they add to a message box, when the window does not keep
 * the message box itself: a mode's window of its own sends it to the main window.
 */
export const DraftProvider = DraftContext.Provider;

/** How this window's modes add to a conversation's message box. */
export function useAddToDraft(): AddToDraft {
  const { runtime } = useRuntime();
  const elsewhere = useContext(DraftContext);
  return (
    elsewhere ??
    (async (sessionId, attachment) =>
      addDraftAttachment(runtime, sessionId, attachment))
  );
}
