import { DataBlock } from './ui';
import { t } from '../i18n';
import type { Interaction } from '../model/types';

/**
 * A call before_tool hooks rewrote: the card's input is the rewrite. This says which hooks rewrote it and, folded,
 * what each changed argument was as the model sent it.
 */
export function HookRewrite({
  rewrite,
}: {
  rewrite: NonNullable<Interaction['hookChanged']>;
}) {
  const sent = Object.fromEntries(
    rewrite.changed
      .filter((key) => Object.hasOwn(rewrite.original, key))
      .map((key) => [key, rewrite.original[key]]),
  );
  return (
    <details className="request-input hook-rewrite">
      <summary>
        {t('rewritten by hook {names}', { names: rewrite.hooks.join(', ') })}
      </summary>
      <DataBlock title={t('as the model sent it')} value={sent} />
    </details>
  );
}
