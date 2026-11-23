import test from 'node:test';
import assert from 'node:assert/strict';
import { setLanguage } from '../src/i18n/index.ts';
import {
  botIdentityKey,
  deliveryText,
  isHubConnected,
  mergeDeliveryStates,
} from '../src/model/remote-bot.ts';

test('isHubConnected matches only a connected Hub entry', () => {
  assert.equal(isHubConnected({ mcp: [] }), false);
  assert.equal(
    isHubConnected({
      mcp: [
        {
          id: 'hub',
          name: 'Hub',
          url: 'https://127.0.0.1:7420/mcp',
          transport: 'streamable_http',
          command: '',
          args: '',
          enabled: true,
          status: 'not connected',
          tools: [],
        },
      ],
    }),
    false,
  );
  assert.equal(
    isHubConnected({
      mcp: [
        {
          id: 'hub',
          name: 'Hub',
          url: 'https://127.0.0.1:7420/mcp',
          transport: 'streamable_http',
          command: '',
          args: '',
          enabled: true,
          status: 'connected',
          tools: [],
        },
      ],
    }),
    true,
  );
});

test('mergeDeliveryStates combines message and attachment delivery states', () => {
  assert.deepEqual(
    mergeDeliveryStates({
      deliveries: [{ id: 'ev-1', state: 'sent' }],
      fileDeliveries: [
        { id: 'ev-1', slot: 0, state: 'queued' },
        { id: 'ev-2', slot: 1, state: 'unknown' },
      ],
    }),
    {
      'ev-1': 'sent',
      'ev-1:0': 'queued',
      'ev-2:1': 'unknown',
    },
  );
});

test('deliveryText translates known delivery states in zh-CN and keeps English keys', (context) => {
  context.after(() => setLanguage('en'));
  assert.equal(deliveryText(null), null);
  assert.equal(deliveryText('other'), null);
  setLanguage('en');
  assert.equal(deliveryText('sent'), 'private chat acknowledged');
  assert.equal(deliveryText('unknown'), 'private chat delivery unknown');
  setLanguage('zh-CN');
  assert.equal(deliveryText('sent'), '企微已确认接收');
  assert.equal(deliveryText('unknown'), '企微送达未知');
  assert.equal(deliveryText('refused'), '企微未送达');
  assert.equal(deliveryText('unbound'), '尚未绑定企微身份');
  assert.equal(deliveryText('queued'), '等待企微送达');
});

test('botIdentityKey distinguishes bindings, bot ids and conversations', () => {
  const a = botIdentityKey({ binding: 'b1', id: 'bot', current: 'c1' });
  const b = botIdentityKey({ binding: 'b1', id: 'bot', current: 'c2' });
  assert.notEqual(a, b);
});
