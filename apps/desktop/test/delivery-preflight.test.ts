import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { DeliveryService } from '../src/workspace/delivery.ts';
import { OperationLedger } from '../src/workspace/operation-ledger.ts';
import { DeliveryPreflightError } from '../src/workspace/delivery-preflight.ts';

test('dirty candidate publish remains a safe actionable rejection through the real ledger, without Git or GitHub effects', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'circle-publish-preflight-'));
  const workspace = path.join(root, 'workspace');
  await mkdir(workspace);
  const delivery = new DeliveryService(workspace, process.execPath);
  const ledger = await OperationLedger.open({
    directory: path.join(root, 'ledger'),
    redactError: () => 'operation failed; inspect effects before retrying',
  });
  try {
    await delivery.git.git(['init']);
    await delivery.git.git(['branch', '-M', 'main']);
    await delivery.git.git(['config', 'user.name', 'Fixture']);
    await delivery.git.git(['config', 'user.email', 'fixture@example.invalid']);
    await writeFile(path.join(workspace, 'tracked.txt'), 'baseline\n');
    await delivery.git.git(['add', '--', 'tracked.txt']);
    await delivery.git.git(['commit', '-m', 'Baseline']);
    await delivery.git.git(['switch', '-c', 'codex/preflight']);
    await writeFile(path.join(workspace, 'tracked.txt'), 'manual change\n');
    const before = await delivery.git.snapshot();
    let externalCalls = 0;
    delivery.gh = async () => {
      externalCalls++;
      throw Error('unexpected synthetic-secret dispatch');
    };
    const operation = {
      id: 'dirty-publish',
      sessionId: 'session',
      service: 'delivery',
      method: 'publish',
      paramsHash: createHash('sha256').update(before.revision).digest('hex'),
    };
    let attempts = 0;
    const publish = () =>
      ledger.run(operation, async () => {
        attempts++;
        return delivery.call('publish', {
          revision: before.revision,
          title: 'Fixture',
          body: 'Fixture',
        });
      });
    for (let n = 0; n < 2; n++)
      await assert.rejects(
        publish(),
        (error: unknown) =>
          error instanceof DeliveryPreflightError &&
          error.code === 'DELIVERY_WORKSPACE_DIRTY' &&
          /remaining workspace changes.*nothing was pushed/.test(error.message),
      );
    await assert.rejects(
      delivery.publishPushed({
        revision: before.revision,
        head: before.head,
        title: 'Fixture',
        body: 'Fixture',
      }),
      (error: unknown) =>
        error instanceof Error &&
        !(error instanceof DeliveryPreflightError) &&
        !error.message.includes('nothing was pushed'),
    );
    assert.equal(attempts, 1);
    assert.equal(externalCalls, 0);
    assert.equal(ledger.list({ sessionId: 'session' })[0]?.state, 'rejected');
    assert.equal((await delivery.git.snapshot()).revision, before.revision);
    await assert.rejects(
      ledger.run({ ...operation, id: 'stale-publish' }, () =>
        delivery.call('publish', { revision: 'stale' }),
      ),
      (error: unknown) =>
        error instanceof DeliveryPreflightError &&
        error.code === 'DELIVERY_CANDIDATE_CHANGED',
    );
    await delivery.git.git(['add', '--', 'tracked.txt']);
    await delivery.git.git(['commit', '-m', 'Preserve manual change']);
    await delivery.git.git(['switch', 'main']);
    const main = await delivery.git.snapshot();
    await assert.rejects(
      ledger.run({ ...operation, id: 'main-publish' }, () =>
        delivery.call('publish', { revision: main.revision }),
      ),
      (error: unknown) =>
        error instanceof DeliveryPreflightError &&
        error.code === 'DELIVERY_FEATURE_BRANCH_REQUIRED',
    );
    assert.equal(externalCalls, 0);
    const unknown = { ...operation, id: 'unknown-write' };
    await assert.rejects(
      ledger.run(unknown, async () => {
        throw Error('synthetic-secret remote result unknown');
      }),
      /inspect effects/,
    );
    assert.equal(
      ledger
        .list({ sessionId: 'session' })
        .find((x) => x.id === 'unknown-write')?.state,
      'needs_review',
    );
  } finally {
    await ledger.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("publishing from the repository's default branch is refused even when it is not main or master", async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'circle-publish-default-'));
  try {
    for (const source of ['local', 'gh'] as const) {
      const workspace = path.join(root, source),
        origin = path.join(root, `${source}.git`);
      await mkdir(workspace);
      const delivery = new DeliveryService(workspace, process.execPath);
      const git = (args: string[]) => delivery.git.git(args);
      await git(['init', '--bare', '--initial-branch=trunk', origin]);
      await git(['init', '--initial-branch=trunk']);
      await git(['config', 'user.name', 'Fixture']);
      await git(['config', 'user.email', 'fixture@example.invalid']);
      await writeFile(path.join(workspace, 'tracked.txt'), 'baseline\n');
      await git(['add', '--', 'tracked.txt']);
      await git(['commit', '-m', 'Baseline']);
      await git(['remote', 'add', 'origin', origin]);
      if (source === 'local') {
        // The local origin/HEAD names the default without asking GitHub.
        await git(['update-ref', 'refs/remotes/origin/trunk', 'HEAD']);
        await git([
          'symbolic-ref',
          'refs/remotes/origin/HEAD',
          'refs/remotes/origin/trunk',
        ]);
      }
      const calls: string[][] = [];
      delivery.gh = async (args) => {
        calls.push(args);
        if (
          source === 'gh' &&
          args.join(' ') === 'repo view --json defaultBranchRef'
        )
          return JSON.stringify({ defaultBranchRef: { name: 'trunk' } });
        throw Error('unexpected GitHub call');
      };
      const before = await delivery.git.snapshot();
      await assert.rejects(
        delivery.call('publish', {
          revision: before.revision,
          title: 'Fixture',
          body: 'Fixture',
        }),
        (error: unknown) =>
          error instanceof DeliveryPreflightError &&
          error.code === 'DELIVERY_FEATURE_BRANCH_REQUIRED',
        source,
      );
      await assert.rejects(
        delivery.publishPushed({
          revision: before.revision,
          head: before.head,
          title: 'Fixture',
          body: 'Fixture',
        }),
        /publish from a feature branch/,
        source,
      );
      assert.deepEqual(
        calls,
        source === 'local'
          ? []
          : [
              ['repo', 'view', '--json', 'defaultBranchRef'],
              ['repo', 'view', '--json', 'defaultBranchRef'],
            ],
      );
      assert.equal(await git(['ls-remote', '--heads', origin]), '');
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
