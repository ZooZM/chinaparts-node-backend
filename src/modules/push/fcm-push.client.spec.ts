import { Logger } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { FakeRedis } from '../../common/redis/fake-redis.testing';
import { FcmPushClient } from './fcm-push.client';
import type {
  FirebaseMessaging,
  MulticastOutcome,
  MulticastRequest,
} from './firebase-messaging';
import { PushPayloadBuilder } from './push-payload.builder';

const message = new PushPayloadBuilder().build(
  { type: 'reelLike', recipientId: 'r', actorId: 'a', reelId: 'x' },
  'en',
  'Sara K.',
  0,
);

function setup(
  respond: (request: MulticastRequest) => MulticastOutcome = (request) => ({
    responses: request.tokens.map(() => ({ success: true })),
  }),
) {
  const calls: Array<{ app: string; request: MulticastRequest }> = [];
  const firebase: FirebaseMessaging = {
    sendEachForMulticast: (app, request) => {
      calls.push({ app, request });
      return Promise.resolve(respond(request));
    },
  };
  const redis = new FakeRedis();
  const client = new FcmPushClient(firebase, redis.asRedis());
  return { client, redis, calls };
}

const deadKey = (token: string) =>
  `push:dead:${createHash('sha256').update(token).digest('hex')}`;

describe('FcmPushClient (research R14)', () => {
  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation();
  });

  afterEach(() => jest.restoreAllMocks());

  it('sends the composed message to the tokens, in the app it was asked for', async () => {
    const { client, calls } = setup();

    const result = await client.sendMulticast('seller', ['t1', 't2'], message);

    expect(result).toEqual({ sent: 2, skippedDead: 0 });
    expect(calls).toHaveLength(1);
    expect(calls[0].app).toBe('seller');
    expect(calls[0].request).toEqual({ ...message, tokens: ['t1', 't2'] });
  });

  it('sends nothing for no tokens', async () => {
    const { client, calls } = setup();
    expect(await client.sendMulticast('customer', [], message)).toEqual({
      sent: 0,
      skippedDead: 0,
    });
    expect(calls).toHaveLength(0);
  });

  it('sends a token registered twice once', async () => {
    const { client, calls } = setup();
    await client.sendMulticast('customer', ['t1', 't1', 't2'], message);
    expect(calls[0].request.tokens).toEqual(['t1', 't2']);
  });

  it.each([
    'messaging/registration-token-not-registered',
    'messaging/invalid-registration-token',
  ])(
    'remembers a token Firebase reports as %s, and skips it next time',
    async (code) => {
      const { client, calls, redis } = setup((request) => ({
        responses: request.tokens.map((token) =>
          token === 'dead'
            ? { success: false, errorCode: code }
            : { success: true },
        ),
      }));

      const first = await client.sendMulticast(
        'customer',
        ['dead', 'alive'],
        message,
      );
      expect(first.sent).toBe(1);
      expect(await redis.get(deadKey('dead'))).toBe('1');

      const second = await client.sendMulticast(
        'customer',
        ['dead', 'alive'],
        message,
      );
      expect(second).toEqual({ sent: 1, skippedDead: 1 });
      expect(calls[1].request.tokens).toEqual(['alive']);
    },
  );

  it('keeps a token for 30 days, by its hash, never as itself', async () => {
    jest.useFakeTimers();
    try {
      const { client, redis, calls } = setup((request) => ({
        responses: request.tokens.map(() => ({
          success: false,
          errorCode: 'messaging/registration-token-not-registered',
        })),
      }));
      await client.sendMulticast('customer', ['secret-token'], message);

      expect(redis.keys()).toEqual([deadKey('secret-token')]);
      expect(redis.keys().join('')).not.toContain('secret-token');

      jest.advanceTimersByTime(30 * 24 * 60 * 60 * 1000 - 1000);
      expect(await redis.get(deadKey('secret-token'))).toBe('1');
      jest.advanceTimersByTime(2_000);
      expect(await redis.get(deadKey('secret-token'))).toBeNull();
      // After it expires the token is tried again.
      await client.sendMulticast('customer', ['secret-token'], message);
      expect(calls).toHaveLength(2);
    } finally {
      jest.useRealTimers();
    }
  });

  it('does not remember a token for a failure that may pass', async () => {
    const { client, redis } = setup((request) => ({
      responses: request.tokens.map(() => ({
        success: false,
        errorCode: 'messaging/server-unavailable',
      })),
    }));

    const result = await client.sendMulticast('customer', ['t1'], message);

    expect(result.sent).toBe(0);
    expect(redis.keys()).toEqual([]);
  });

  it('sends nothing when every token is dead, without calling Firebase', async () => {
    const { client, redis, calls } = setup();
    await redis.set(deadKey('t1'), '1');

    const result = await client.sendMulticast('customer', ['t1'], message);

    expect(result).toEqual({ sent: 0, skippedDead: 1 });
    expect(calls).toHaveLength(0);
  });

  it('sends in batches of at most 500', async () => {
    const { client, calls } = setup();
    const tokens = Array.from({ length: 1_200 }, (_, i) => `t${i}`);

    const result = await client.sendMulticast('customer', tokens, message);

    expect(result.sent).toBe(1_200);
    expect(calls.map((c) => c.request.tokens.length)).toEqual([500, 500, 200]);
  });

  it('still sends when Redis cannot say which tokens are dead', async () => {
    const { client, redis, calls } = setup();
    jest.spyOn(redis, 'mget').mockRejectedValue(new Error('redis is down'));

    const result = await client.sendMulticast('customer', ['t1'], message);

    expect(result.sent).toBe(1);
    expect(calls).toHaveLength(1);
  });

  it('lets a Firebase error through, so the job is retried', async () => {
    const firebase: FirebaseMessaging = {
      sendEachForMulticast: () => Promise.reject(new Error('Firebase is down')),
    };
    const client = new FcmPushClient(firebase, new FakeRedis().asRedis());

    await expect(
      client.sendMulticast('customer', ['t1'], message),
    ).rejects.toThrow('Firebase is down');
  });
});
