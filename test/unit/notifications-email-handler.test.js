import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createNotificationHandlers,
  registerNotificationHandlers,
} from '../../src/worker-handlers/notifications.js';
import { EMAIL_DELIVERY_JOB_TYPE } from '../../src/modules/notifications/service.js';

function fakeRepo({ status = 'pending', attempts = 0, max_attempts = 3 } = {}) {
  const state = {
    id: 'd1',
    status,
    attempts,
    max_attempts,
    recipient_email: 'reseller@example.test',
    subject: 'Saldo bajo',
    title: 'Saldo bajo',
    body: 'Tu saldo cruzo el umbral',
    last_error: null,
  };
  return {
    state,
    async findEmailDeliveryById(id) {
      return id === state.id ? { ...state } : null;
    },
    async markDeliverySent(id) {
      if (id === state.id) { state.status = 'sent'; state.attempts += 1; }
      return { ...state };
    },
    async recordDeliveryFailure(id, err) {
      if (id === state.id) {
        state.attempts += 1;
        state.status = state.attempts >= state.max_attempts ? 'dead' : 'failed';
        state.last_error = err;
      }
      return { ...state };
    },
  };
}

function fakeTransport(result = { messageId: 'm1' }) {
  const calls = [];
  return {
    calls,
    transport: { sendMail: async (msg) => { calls.push(msg); return result; } },
  };
}

const job = { payload: { deliveryId: 'd1' } };

test('email handler sends once and records sent', async () => {
  const repo = fakeRepo();
  const t = fakeTransport();
  const handlers = createNotificationHandlers({ repo, transport: t.transport });
  const result = await handlers[EMAIL_DELIVERY_JOB_TYPE](job);

  assert.equal(result.sent, true);
  assert.equal(t.calls.length, 1);
  assert.equal(t.calls[0].to, 'reseller@example.test');
  assert.equal(repo.state.status, 'sent');
});

test('replay of an already-sent delivery does not send again', async () => {
  const repo = fakeRepo({ status: 'sent' });
  const t = fakeTransport();
  const handlers = createNotificationHandlers({ repo, transport: t.transport });
  const result = await handlers[EMAIL_DELIVERY_JOB_TYPE](job);

  assert.deepEqual(result, { skipped: 'already_sent' });
  assert.equal(t.calls.length, 0, 'no duplicate event');
});

test('missing delivery is skipped, not retried forever', async () => {
  const handlers = createNotificationHandlers({ repo: fakeRepo(), transport: fakeTransport().transport });
  const result = await handlers[EMAIL_DELIVERY_JOB_TYPE]({ payload: { deliveryId: 'nope' } });
  assert.deepEqual(result, { skipped: 'not_found' });
});

test('failed email retries with limited attempts then goes dead without reverting business', async () => {
  const repo = fakeRepo({ max_attempts: 2 });
  const transport = { sendMail: async () => { throw new Error('smtp down'); } };
  const handlers = createNotificationHandlers({ repo, transport, logger: { warn() {} } });

  await assert.rejects(() => handlers[EMAIL_DELIVERY_JOB_TYPE](job), /smtp down/);
  assert.equal(repo.state.status, 'failed');
  assert.equal(repo.state.attempts, 1);

  const second = await handlers[EMAIL_DELIVERY_JOB_TYPE](job);
  assert.deepEqual(second, { dead: true, attempts: 2 });
  assert.equal(repo.state.status, 'dead');
});

test('a dead delivery is not retried again', async () => {
  const repo = fakeRepo({ status: 'dead', attempts: 2, max_attempts: 2 });
  const t = fakeTransport();
  const handlers = createNotificationHandlers({ repo, transport: t.transport });
  const result = await handlers[EMAIL_DELIVERY_JOB_TYPE](job);
  assert.deepEqual(result, { skipped: 'dead' });
  assert.equal(t.calls.length, 0);
});

test('registerNotificationHandlers wires the job type into the worker', () => {
  const registered = new Map();
  registerNotificationHandlers((type, handler) => registered.set(type, handler), {
    repo: fakeRepo(),
    transport: fakeTransport().transport,
  });
  assert.ok(registered.has(EMAIL_DELIVERY_JOB_TYPE));
});
