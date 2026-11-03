import { KnowledgeStore } from '../../../src/knowledge/store.js';
const store = new KnowledgeStore(process.argv[2]!);
const now = Number(process.argv[4]);
try {
  if (process.argv[3] === 'acquire')
    console.log(
      JSON.stringify({
        acquired: store.acquireSyncLease(process.argv[5]!, now, 30000),
      }),
    );
  else if (process.argv[3] === 'hold') {
    console.log(
      JSON.stringify({
        acquired: store.acquireSyncLease(process.argv[5]!, now, 30000),
      }),
    );
    setInterval(() => {}, 1000);
    await new Promise<void>(() => {});
  } else if (process.argv[3] === 'assert') {
    store.assertSyncLease(process.argv[5]!, now);
    console.log('active');
  }
} finally {
  store.close();
}
