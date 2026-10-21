import type { ChatCompletionContentPart } from 'openai/resources/chat/completions';
import type {
  ImageBlockParam,
  DocumentBlockParam,
  TextBlockParam,
} from '@anthropic-ai/sdk/resources/messages';
import type { MediaAttachment, Message } from './types.js';
import { validateAttachments } from './media.js';

export function checkRequestMedia(messages: Message[]): void {
  let size = 0;
  for (const message of messages) {
    if (!message.attachments) continue;
    if (!['user', 'tool'].includes(message.role))
      throw new Error('attachments require a user or tool message');
    validateAttachments(message.attachments);
    size += message.attachments.reduce(
      (sum, item) => sum + item.data.length,
      0,
    );
  }
  if (size > 28 * 1024 * 1024)
    throw new Error(
      'media in this request exceeds 28 MiB of encoded data; compact the conversation or use smaller files',
    );
}
// What pictures are called where an endpoint says it takes none
const PICTURES =
  '(?:images?|image[\\s_-]*(?:inputs?|content|urls?|parts?|blocks?)(?:\\s+(?:content\\s+)?(?:types?|parts?|blocks?))?|vision|visual\\s+inputs?|multi-?modal(?:\\s+(?:inputs?|content))?)';
// The sentence ends there, or goes on to the model ("for this model"), never to a kind of
// picture ("images larger than…", "not allowed in system messages")
const ENDS = '(?=\\s*(?:$|[.,;:!)\\-–—])|\\s+(?:for|by|on|with)\\b)';
const NO_IMAGES = [
  // "does not support images", "doesn't accept image input", "cannot support multi-modal inputs"
  new RegExp(
    `\\b(?:does|do|did|can)\\s*(?:not|n't)\\s+(?:support|accept)\\s+(?:(?:the|any)\\s+)?${PICTURES}${ENDS}`,
    'i',
  ),
  // "image input is not supported" (llama.cpp), "image content parts are not supported"
  new RegExp(
    `\\b${PICTURES}(?:\\s+(?:content\\s+)?(?:parts?|types?|blocks?|messages?))?\\s+(?:is|are)\\s+not\\s+(?:supported|accepted|allowed|enabled|available)${ENDS}`,
    'i',
  ),
  // "… is not a multimodal model"
  /\bnot\s+an?\s+(?:multi-?modal|vision|visual|vlm)\s+model\b/i,
  // OpenAI: "Invalid content type. image_url is only supported by certain models."
  /\bimage_url\b[^.]*\bonly\s+supported\s+by\s+certain\s+models\b/i,
  // A strict parser that knows no picture part: "unknown variant `image_url`" (DeepSeek),
  // "Unsupported content part type: image_url", "Input tag 'image' found …"
  /\bunknown\s+variant\W+(?:input_)?image/i,
  /\b(?:unsupported|unknown|invalid)\s+(?:content\s+)?(?:part\s+)?type\W+["'`]?(?:image_url|input_image|image)["'`]?(?=\s*(?:$|[.,;:!)]))/i,
  /\binput\s+tag\s+["'`]image["'`]\s+found\b/i,
  // vLLM serving a model with no picture input: "At most 0 image(s) may be provided"
  /\bat\s+most\s+0\s+image/i,
  // Ollama: "this model is missing data required for image input"
  /\bmissing\s+data\s+required\s+for\s+image\s+input\b/i,
];
/**
 * Whether an endpoint's refusal says the model takes no pictures at all. One that only
 * mentions them (a picture too large, too many pictures, a context limit counted in image
 * tokens, a tool named `generate_image`) is not such a refusal and keeps its own error.
 */
export function endpointRefusesImages(reason: string): boolean {
  return NO_IMAGES.some((pattern) => pattern.test(reason));
}
/**
 * History keeps the pictures a prompt came with; a model that does not read images gets
 * their names in the message instead, on every request, not only the first. A name is no
 * path: a picture pasted in the desktop while a model that reads images was in use was
 * never written anywhere, so the note claims no file. Where the message or the result
 * gives a path (`@shot.png`, a screenshot's "saved as"), the model reads it there.
 */
export function leaveOutImages(
  messages: Message[],
  leaveOut: boolean,
): Message[] {
  if (!leaveOut) return messages;
  return messages.map((message) => {
    const images =
      message.attachments?.filter((item) => item.kind === 'image') ?? [];
    if (!images.length) return message;
    const rest = message.attachments!.filter((item) => item.kind !== 'image');
    return {
      ...message,
      attachments: rest.length ? rest : undefined,
      content: `${message.content}\n\n[${images.map((item) => item.filename).join(', ')} left out: the model in use does not read images.]`,
    };
  });
}
export function openAIContent(
  text: string,
  attachments: MediaAttachment[] = [],
): ChatCompletionContentPart[] {
  return [
    ...(text ? [{ type: 'text' as const, text }] : []),
    ...attachments.map((item): ChatCompletionContentPart =>
      item.kind === 'image'
        ? {
            type: 'image_url',
            image_url: { url: `data:${item.mime_type};base64,${item.data}` },
          }
        : {
            type: 'file',
            file: {
              filename: item.filename,
              file_data: `data:application/pdf;base64,${item.data}`,
            },
          },
    ),
  ];
}
export function anthropicContent(
  text: string,
  attachments: MediaAttachment[] = [],
): (TextBlockParam | ImageBlockParam | DocumentBlockParam)[] {
  return [
    ...(text ? [{ type: 'text' as const, text }] : []),
    ...attachments.map((item): ImageBlockParam | DocumentBlockParam =>
      item.kind === 'image'
        ? {
            type: 'image',
            source: {
              type: 'base64',
              media_type: item.mime_type as Exclude<
                MediaAttachment['mime_type'],
                'application/pdf'
              >,
              data: item.data,
            },
          }
        : {
            type: 'document',
            title: item.filename,
            source: {
              type: 'base64',
              media_type: 'application/pdf',
              data: item.data,
            },
          },
    ),
  ];
}
