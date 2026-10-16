import type { RuntimePort } from './types';
import { t } from '../i18n';
export type GitHubExampleOrigin = {
  sessionId: string;
  epoch: number | undefined;
};
export type PreparedGitHubExample = {
  sessionId: string;
  draft: string;
  example: string;
  saved: boolean;
};
/** A local draft operation, never an authorization or model request. */
export function prepareGitHubExample(
  runtime: RuntimePort,
  origin: GitHubExampleOrigin,
  text: string,
  previous?: PreparedGitHubExample,
): PreparedGitHubExample {
  const snapshot = runtime.getSnapshot();
  const session = snapshot.sessions.find(
    (item) => item.id === origin.sessionId,
  );
  if (
    runtime.presentationEpoch !== origin.epoch ||
    snapshot.activeSessionId !== origin.sessionId ||
    !session ||
    session.lifecycle === 'deleting'
  )
    throw Error(
      t(
        'the original conversation changed; return to it before trying the plugin',
      ),
    );
  const retrying = previous?.sessionId === session.id && !previous.saved;
  if (retrying && !session.draft.includes(previous.example))
    throw Error(
      t('the draft changed; review it before trying the example again'),
    );
  const draft = retrying
    ? session.draft
    : [session.draft, text].filter(Boolean).join('\n\n');
  return {
    sessionId: session.id,
    draft,
    example: retrying ? previous.example : text,
    saved: runtime.updateSessionView(session.id, { draft }),
  };
}
