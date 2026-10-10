import { PushPayloadBuilder } from './push-payload.builder';
import type { PushJob, PushJobType } from './push-sender';

const NOW = Date.UTC(2026, 9, 10, 12, 0, 0);
const builder = new PushPayloadBuilder();

const jobs: Array<[PushJobType, PushJob, string[]]> = [
  [
    'newFollower',
    { type: 'newFollower', recipientId: 'r', actorId: 'a' },
    ['source', 'type', 'actorId'],
  ],
  [
    'reelLike',
    { type: 'reelLike', recipientId: 'r', actorId: 'a', reelId: 'x' },
    ['source', 'type', 'actorId', 'reelId'],
  ],
  [
    'reelMention',
    { type: 'reelMention', recipientId: 'r', actorId: 'a', reelId: 'x' },
    ['source', 'type', 'actorId', 'reelId'],
  ],
  [
    'reelRejected',
    { type: 'reelRejected', recipientId: 'r', reelId: 'x' },
    ['source', 'type', 'reelId'],
  ],
];

describe('PushPayloadBuilder (FR-073a, SC-015)', () => {
  it.each(jobs)(
    '%s carries exactly the allowed keys and nothing else',
    (_type, job, dataKeys) => {
      const message = builder.build(job, 'ar', 'Sara K.', NOW);

      expect(Object.keys(message).sort()).toEqual([
        'android',
        'apns',
        'data',
        'notification',
      ]);
      expect(Object.keys(message.notification).sort()).toEqual([
        'body',
        'title',
      ]);
      expect(Object.keys(message.data).sort()).toEqual([...dataKeys].sort());
      expect(Object.keys(message.android)).toEqual(['ttl']);
      expect(Object.keys(message.apns)).toEqual(['headers']);
      expect(Object.keys(message.apns.headers)).toEqual(['apns-expiration']);
    },
  );

  it.each(jobs)('%s sends the type and the ids, as they are', (_type, job) => {
    const { data } = builder.build(job, 'ar', 'Sara K.', NOW);

    expect(data.source).toBe('reels');
    expect(data.type).toBe(job.type);
    expect(data.actorId).toBe(job.actorId);
    expect(data.reelId).toBe(job.reelId);
  });

  it('copies nothing a job should not have carried, even if it did', () => {
    const job = {
      type: 'reelLike',
      recipientId: 'r',
      actorId: 'a',
      reelId: 'x',
      // A future change that put these on a job must not reach a device.
      reelText: 'a private description',
      email: 'sara@example.test',
      phone: '+966500000001',
    } as unknown as PushJob;

    const message = builder.build(job, 'en', 'Sara K.', NOW);

    const serialized = JSON.stringify(message);
    expect(serialized).not.toContain('a private description');
    expect(serialized).not.toContain('sara@example.test');
    expect(serialized).not.toContain('+966');
    expect(serialized).not.toContain('recipientId');
  });

  it("puts the actor's public name in the text, and not in the data", () => {
    const message = builder.build(jobs[1][1], 'en', 'Sara K.', NOW);

    expect(message.notification.body).toContain('Sara K.');
    expect(JSON.stringify(message.data)).not.toContain('Sara');
  });

  it("writes the text in the recipient's language, Arabic by default", () => {
    expect(builder.build(jobs[1][1], 'en', 'A', NOW).notification.title).toBe(
      'New like',
    );
    expect(builder.build(jobs[1][1], 'ar', 'A', NOW).notification.title).toBe(
      'إعجاب جديد',
    );
    expect(
      builder.build(jobs[1][1], undefined, 'A', NOW).notification.title,
    ).toBe('إعجاب جديد');
  });

  it('expires after 24 hours on both platforms', () => {
    const message = builder.build(jobs[0][1], 'ar', 'A', NOW);

    expect(message.android.ttl).toBe(24 * 60 * 60 * 1000);
    expect(message.apns.headers['apns-expiration']).toBe(
      String(Math.floor(NOW / 1000) + 24 * 60 * 60),
    );
  });

  it('uses the current time when none is given', () => {
    const before = Math.floor(Date.now() / 1000) + 24 * 60 * 60;
    const message = builder.build(jobs[0][1], 'ar');
    const expiration = Number(message.apns.headers['apns-expiration']);
    expect(expiration).toBeGreaterThanOrEqual(before);
    expect(expiration).toBeLessThanOrEqual(before + 5);
  });

  it('only strings go in the data block, which FCM requires', () => {
    for (const [, job] of jobs) {
      const { data } = builder.build(job, 'ar', 'A', NOW);
      expect(
        Object.values(data).every((value) => typeof value === 'string'),
      ).toBe(true);
    }
  });
});
