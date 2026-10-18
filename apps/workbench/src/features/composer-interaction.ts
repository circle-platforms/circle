import { BUILTIN_SLASH } from '../../../../src/tui/slash_commands';
import type { Attachment, WorkbenchSnapshot } from '../model/types';
import { slashText } from '../model/slash-text';

/** Completion names and routing are shared by the first and later messages. */
export function commandCompletions(
  draft: string,
  snapshot: Pick<WorkbenchSnapshot, 'skills' | 'commands'>,
) {
  if (!draft.startsWith('/') || /\s/.test(draft)) return [];
  const seen = new Set<string>();
  return [
    ...BUILTIN_SLASH.map((item) => ({
      name: '/' + item.name,
      description: slashText(item.name, item.description),
      kind: 'command' as const,
    })),
    ...snapshot.skills.map((item) => ({
      name: '/skill:' + item.name,
      description: item.description,
      kind: 'command' as const,
    })),
    ...snapshot.commands.map((item) => ({
      name: '/' + item.name,
      description: item.description,
      kind: 'command' as const,
    })),
  ]
    .filter((item) => {
      if (!item.name.toLowerCase().includes(draft.toLowerCase())) return false;
      if (seen.has(item.name)) return false;
      seen.add(item.name);
      return true;
    })
    .slice(0, 7);
}

/** A completed submission owns only the draft and attachments it started with. */
export function ownsHomeSubmission(
  submitted: { text: string; attachments: readonly Attachment[] },
  current: { text: string; attachments: readonly Attachment[] },
): boolean {
  return (
    submitted.text === current.text &&
    submitted.attachments.length === current.attachments.length &&
    submitted.attachments.every(
      (item, index) =>
        item.id === current.attachments[index]?.id &&
        item.content === current.attachments[index]?.content,
    )
  );
}
