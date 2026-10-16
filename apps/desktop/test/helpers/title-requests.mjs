import { TITLE_MAX_TOKENS } from '../../../../src/session_title.ts';

/** The title fixtures give a session. It is none of the replies a test waits for. */
export const FIXTURE_TITLE = 'Fixture session';

/**
 * After a turn Circle asks the model for a short session title, with this
 * output cap. A fixture that scripts a turn answers it apart, so the request
 * does not take one of the turn's replies or count as a turn.
 */
export function isTitleRequest(body) {
  return body?.max_tokens === TITLE_MAX_TOKENS;
}

/** Answer a title request as the protocol streams it. */
export function answerTitle(response, body, protocol = 'openai') {
  response.writeHead(200, { 'Content-Type': 'text/event-stream' });
  if (protocol === 'anthropic') {
    const events = [
      {
        type: 'message_start',
        message: {
          id: 'fixture-title',
          type: 'message',
          role: 'assistant',
          model: body.model,
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 1, output_tokens: 0 },
        },
      },
      {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'text', text: '' },
      },
      {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: FIXTURE_TITLE },
      },
      { type: 'content_block_stop', index: 0 },
      {
        type: 'message_delta',
        delta: { stop_reason: 'end_turn', stop_sequence: null },
        usage: { output_tokens: 2 },
      },
      { type: 'message_stop' },
    ];
    response.end(
      events
        .map(
          (event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
        )
        .join(''),
    );
    return;
  }
  response.end(
    `data: ${JSON.stringify({
      id: 'fixture-title',
      object: 'chat.completion.chunk',
      model: body.model,
      choices: [
        {
          index: 0,
          delta: { role: 'assistant', content: FIXTURE_TITLE },
          finish_reason: 'stop',
        },
      ],
    })}\n\ndata: [DONE]\n\n`,
  );
}
