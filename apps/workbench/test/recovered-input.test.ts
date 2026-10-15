import test from 'node:test';
import assert from 'node:assert/strict';
import {
  recoveredDraft,
  type RecoveredInput,
} from '../src/model/recovered-input';
test('recovering folded 600-line input keeps full text, original media bytes and existing draft', () => {
  const text = Array.from({ length: 600 }, (_, i) => `original line ${i}`).join(
    '\n',
  );
  const input: RecoveredInput = {
    id: 'input-1',
    kind: 'followUp',
    state: 'recovery_pending',
    order: 1,
    createdAt: 1,
    updatedAt: 2,
    payload: {
      text,
      display: '[Pasted text #1]',
      pastes: { '1': text },
      attachments: [
        {
          kind: 'image',
          filename: 'original.png',
          mime_type: 'image/png',
          data: 'AAECAw==',
          sha256: 'a'.repeat(64),
        },
      ],
    },
  };
  const before = structuredClone(input);
  const patch = recoveredDraft(input, 'existing unsent draft', []);
  assert.equal(patch.draft, 'existing unsent draft\n\n' + text);
  assert.equal(patch.attachments[0].content, 'data:image/png;base64,AAECAw==');
  assert.equal(patch.attachments[0].name, 'original.png');
  assert.deepEqual(input, before);
  const again = recoveredDraft(input, '', patch.attachments);
  assert.equal(again.attachments.length, 1);
});
