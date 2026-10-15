import type { Attachment } from './types';
export interface RecoveredInput {
  id: string;
  kind: 'steer' | 'followUp';
  state: string;
  order: number;
  payload: {
    text: string;
    display: string;
    pastes?: Record<string, string>;
    attachments?: {
      kind: 'image' | 'document';
      filename: string;
      mime_type: string;
      data: string;
      sha256: string;
    }[];
  };
  createdAt: number;
  updatedAt: number;
}
/** Full prompt, not folded display, is restored. Media bytes stay exact. */
export function recoveredDraft(
  input: RecoveredInput,
  draft: string,
  attachments: Attachment[],
) {
  return {
    draft: [draft, input.payload.text].filter(Boolean).join('\n\n'),
    attachments: [
      ...attachments,
      ...(input.payload.attachments ?? [])
        .map((media, index): Attachment => ({
          id: `recovered-${input.id}-${index}`,
          name: media.filename,
          mime: media.mime_type,
          kind: media.kind,
          content: `data:${media.mime_type};base64,${media.data}`,
        }))
        .filter(
          (media) => !attachments.some((existing) => existing.id === media.id),
        ),
    ],
  };
}
