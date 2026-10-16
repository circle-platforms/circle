import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { DeliveryService } from '../src/workspace/delivery.ts';
import { OperationLedger } from '../src/workspace/operation-ledger.ts';

for (const mode of ['eventual', 'pending'] as const)
  test(`publication ${mode} never returns a pre-push head or repeats its push`, async (t) => {
    const root = await mkdtemp(
      path.join(tmpdir(), 'circle-publication-confirm-'),
    );
    const workspace = path.join(root, 'workspace'),
      remote = path.join(root, 'remote.git');
    await mkdir(workspace);
    const service = new DeliveryService(workspace);
    let ledger = await OperationLedger.open({
      directory: path.join(root, 'operations'),
      redactError: () => 'operation failed; inspect effects before retrying',
    });
    try {
      await service.git.git(['init', '--initial-branch=codex/feature']);
      await service.git.git(['config', 'user.name', 'Fixture']);
      await service.git.git([
        'config',
        'user.email',
        'fixture@example.invalid',
      ]);
      await service.git.git(['init', '--bare', remote]);
      await service.git.git(['remote', 'add', 'origin', remote]);
      await writeFile(path.join(workspace, 'file'), 'old\n');
      await service.git.git(['add', '--', 'file']);
      await service.git.git(['commit', '-m', 'Old']);
      const old = (await service.git.snapshot()).head;
      await service.git.git(['push', 'origin', 'codex/feature']);
      await writeFile(path.join(workspace, 'file'), 'reviewed\n');
      await service.git.git(['add', '--', 'file']);
      await service.git.git(['commit', '-m', 'Reviewed']);
      const candidate = await service.git.snapshot();
      let pushes = 0,
        postReads = 0,
        creates = 0;
      const git = service.git.git.bind(service.git);
      t.mock.method(
        service.git,
        'git',
        async (args: string[], input?: string) => {
          const output = await git(args, input);
          if (args[0] === 'push') pushes++;
          return output;
        },
      );
      t.mock.method(service, 'gh', async (args: string[]) => {
        if (args[0] === 'pr' && args[1] === 'create') creates++;
        if (pushes) postReads++;
        return JSON.stringify({
          number: 1,
          url: 'https://github.com/fixture/repo/pull/1',
          isDraft: true,
          headRefOid:
            mode === 'eventual' && postReads >= 3 ? candidate.head : old,
          headRefName: candidate.branch,
          state: 'OPEN',
        });
      });
      const identity = {
        id: 'publication',
        sessionId: 'owner',
        service: 'delivery',
        method: 'publish',
        paramsHash: createHash('sha256')
          .update(candidate.revision)
          .digest('hex'),
      };
      let attempts = 0;
      const publish = () =>
        ledger.run(identity, () => {
          attempts++;
          return service.call('publish', {
            revision: candidate.revision,
            title: 'Fixture',
            body: 'Fixture',
          });
        });
      if (mode === 'eventual') {
        const result = (await publish()) as { headRefOid: string };
        assert.equal(result.headRefOid, candidate.head);
        assert.equal(
          ((await publish()) as { headRefOid: string }).headRefOid,
          candidate.head,
        );
        assert.equal(ledger.list()[0]?.state, 'completed');
        assert.equal(postReads, 3);
      } else {
        for (let i = 0; i < 2; i++)
          await assert.rejects(
            publish(),
            /publication was sent.*not confirmed.*do not repeat the push/,
          );
        assert.equal(ledger.list()[0]?.state, 'needs_review');
        assert.equal(postReads, 4);
        await ledger.close();
        ledger = await OperationLedger.open({
          directory: path.join(root, 'operations'),
        });
        await assert.rejects(
          publish(),
          /publication was sent.*not confirmed.*do not repeat the push/,
        );
        assert.equal(postReads, 4);
      }
      assert.equal(attempts, 1);
      assert.equal(pushes, 1);
      assert.equal(creates, 0);
      assert.equal(
        (
          await git([
            '--git-dir',
            remote,
            'rev-parse',
            'refs/heads/codex/feature',
          ])
        ).trim(),
        candidate.head,
      );
    } finally {
      await ledger.close();
      await rm(root, { recursive: true, force: true });
    }
  });
