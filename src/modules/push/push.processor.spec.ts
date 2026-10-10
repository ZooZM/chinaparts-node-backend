import type { ConfigService } from '@nestjs/config';
import type { Job } from 'bullmq';
import { Types } from 'mongoose';
import type { AccountsRepository } from '../accounts/accounts.repository';
import type { ChinaPartsDevicesRepository } from '../china-parts/devices.repository';
import { PushPayloadBuilder } from './push-payload.builder';
import type { PushMessage } from './push-payload.builder';
import { PushProcessor } from './push.processor';
import type { PushJob } from './push-sender';

const recipientId = new Types.ObjectId();
const actorId = new Types.ObjectId();

function account(id: Types.ObjectId, over: Record<string, unknown> = {}) {
  return {
    _id: id,
    accountType: 'seller',
    externalId: 1,
    locale: 'ar',
    name: 'Ahmed S.',
    standing: 'good',
    ...over,
  };
}

function setup(
  accounts = [
    account(recipientId),
    account(actorId, { accountType: 'customer', name: 'Sara K.' }),
  ],
) {
  const findByIdsLean = jest
    .fn<Promise<unknown[]>, [string[], string[]]>()
    .mockResolvedValue(accounts);
  const getTokens = jest
    .fn()
    .mockResolvedValue([{ token: 'fcm-token-seller-1', platform: 'ios' }]);
  const sendMulticast = jest
    .fn<
      Promise<{ sent: number; skippedDead: number }>,
      [string, string[], PushMessage]
    >()
    .mockResolvedValue({ sent: 1, skippedDead: 0 });
  const processor = new PushProcessor(
    { findByIdsLean } as unknown as AccountsRepository,
    { getTokens } as unknown as ChinaPartsDevicesRepository,
    new PushPayloadBuilder(),
    { sendMulticast },
    { get: () => 'worker' } as unknown as ConfigService,
  );
  const run = (job: PushJob) =>
    processor.process({ data: job } as Job<PushJob>);
  return { run, findByIdsLean, getTokens, sendMulticast };
}

const like: PushJob = {
  type: 'reelLike',
  recipientId: recipientId.toString(),
  actorId: actorId.toString(),
  reelId: 'reel-1',
};

describe('PushProcessor (research R14, FR-063 to FR-066)', () => {
  it("sends to exactly the recipient's devices, in their own app", async () => {
    const { run, getTokens, sendMulticast } = setup();

    await run(like);

    expect(getTokens).toHaveBeenCalledWith('seller', 1);
    expect(sendMulticast).toHaveBeenCalledTimes(1);
    expect(sendMulticast.mock.calls[0][0]).toBe('seller');
    expect(sendMulticast.mock.calls[0][1]).toEqual(['fcm-token-seller-1']);
  });

  it("writes the message in the recipient's language, naming the actor", async () => {
    const english = setup([
      account(recipientId, { locale: 'en' }),
      account(actorId, { accountType: 'customer', name: 'Sara K.' }),
    ]);
    await english.run(like);
    const message = english.sendMulticast.mock.calls[0][2];
    expect(message.notification).toEqual({
      title: 'New like',
      body: 'Sara K. liked your reel',
    });

    const arabic = setup();
    await arabic.run(like);
    const arabicMessage = arabic.sendMulticast.mock.calls[0][2];
    expect(arabicMessage.notification.title).toBe('إعجاب جديد');
  });

  it('sends a rejection, which has no actor, without looking one up', async () => {
    const { run, findByIdsLean, sendMulticast } = setup([account(recipientId)]);

    await run({
      type: 'reelRejected',
      recipientId: recipientId.toString(),
      reelId: 'r',
    });

    expect(findByIdsLean.mock.calls[0][0]).toEqual([recipientId.toString()]);
    expect(sendMulticast).toHaveBeenCalledTimes(1);
  });

  it('sends nothing for an account that has no devices', async () => {
    const { run, getTokens, sendMulticast } = setup();
    getTokens.mockResolvedValue([]);

    await run(like);

    expect(sendMulticast).not.toHaveBeenCalled();
  });

  it.each([
    ['gone', []],
    ['deleted', [account(recipientId, { standing: 'deleted' })]],
  ])(
    'sends nothing for a recipient that is %s, and does not ask for devices',
    async (_label, accounts) => {
      const { run, getTokens, sendMulticast } = setup(accounts);

      await run(like);

      expect(getTokens).not.toHaveBeenCalled();
      expect(sendMulticast).not.toHaveBeenCalled();
    },
  );

  it('still sends when the actor is gone, with no name', async () => {
    const { run, sendMulticast } = setup([account(recipientId)]);

    await run(like);

    const message = sendMulticast.mock.calls[0][2] as {
      notification: { body: string };
    };
    expect(message.notification.body).toContain('شخص ما');
  });

  it('lets a failure through, so the queue retries it', async () => {
    const { run, getTokens } = setup();
    getTokens.mockRejectedValue(new Error('UPSTREAM_UNAVAILABLE'));
    await expect(run(like)).rejects.toThrow('UPSTREAM_UNAVAILABLE');

    const second = setup();
    second.sendMulticast.mockRejectedValue(new Error('Firebase is down'));
    await expect(second.run(like)).rejects.toThrow('Firebase is down');
  });
});
