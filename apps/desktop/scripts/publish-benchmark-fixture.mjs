// The history both publish benchmarks store: turns of a prompt, a reply with a tool call,
// its result and an answer, about 1.25 KB per message. Synthetic, with no real content.
const sentence = 'synthetic history for the publish benchmark ';

export function publishBenchmarkMessages(sessionId, count) {
  const messages = [];
  for (let index = 0; messages.length < count; index++) {
    const id = `${sessionId}-${index}`;
    messages.push({
      id: `${id}-prompt`,
      role: 'user',
      content: `prompt ${index} ${sentence.repeat(6)}`,
    });
    messages.push({
      id: `${id}-call`,
      role: 'assistant',
      content: '',
      tool_calls: [
        {
          id: `${id}-tool`,
          name: 'read_file',
          args: { file_path: `src/file-${index}.ts` },
        },
      ],
    });
    messages.push({
      id: `${id}-result`,
      role: 'tool',
      tool_call_id: `${id}-tool`,
      content: `result ${index} ${sentence.repeat(70)}`,
    });
    messages.push({
      id: `${id}-answer`,
      role: 'assistant',
      content: `answer ${index} ${sentence.repeat(30)}`,
    });
  }
  return messages.slice(0, count - (count % 4));
}
