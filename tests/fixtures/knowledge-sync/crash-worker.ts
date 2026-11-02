import { KnowledgeStore } from '../../../src/knowledge/store.js';

const [home, phase, encoded] = process.argv.slice(2);
if (!home || !encoded)
  throw Error('synthetic crash worker needs a scratch home');
const store = new KnowledgeStore(home, {
  onPhase: (at) => {
    if (at === phase) process.exit(73);
  },
});
const payload = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8'));
if (payload.object) store.put(payload.object);
else store.commit(payload.snapshot, payload.expected);
throw Error('crash point was not reached');
