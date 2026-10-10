import { QUEUE_REELS_PUSH } from '../../src/common/queues/queue-names';
import {
  FIREBASE_MESSAGING,
  FirebaseMessaging,
  MulticastOutcome,
  MulticastRequest,
} from '../../src/modules/push/firebase-messaging';
import { createTestApp, TestApp } from '../utils/app';
import { createPublishedReel, drainQueue, eventually } from '../utils/fixtures';
import { createPerson, Person } from '../utils/people';
import { issueToken } from '../utils/tokens';

interface Captured {
  app: string;
  request: MulticastRequest;
}

/** What stands in for Firebase: it records every message, and can fail or call tokens dead. */
class CapturingFirebase implements FirebaseMessaging {
  readonly sent: Captured[] = [];
  failWith: Error | undefined;
  readonly deadTokens = new Set<string>();

  sendEachForMulticast(
    app: 'customer' | 'seller',
    request: MulticastRequest,
  ): Promise<MulticastOutcome> {
    if (this.failWith) return Promise.reject(this.failWith);
    this.sent.push({ app, request });
    return Promise.resolve({
      responses: request.tokens.map((token) =>
        this.deadTokens.has(token)
          ? {
              success: false,
              errorCode: 'messaging/registration-token-not-registered',
            }
          : { success: true },
      ),
    });
  }

  to(token: string): Captured[] {
    return this.sent.filter((entry) => entry.request.tokens.includes(token));
  }
}

/** FR-063 to FR-066, FR-073a and research R14: pushes to China Parts' registered devices. */
describe('Notifications (e2e)', () => {
  let testApp: TestApp;
  const firebase = new CapturingFirebase();

  beforeAll(async () => {
    testApp = await createTestApp({
      configure: (builder) => {
        builder.overrideProvider(FIREBASE_MESSAGING).useValue(firebase);
      },
    });
  }, 120_000);

  afterAll(async () => {
    await testApp.close();
  });

  const api = () => testApp.api;
  const settle = () => drainQueue(testApp, QUEUE_REELS_PUSH);
  const like = (token: string, reelId: string) =>
    api().post(`/api/reels/${reelId}/like`, { token });
  const sellerDevice = async (person: Person, token: string) =>
    testApp.infra.rootQuery(
      `INSERT INTO device_tokens
         (tokenable_type, tokenable_id, token, token_hash, platform, app, created_at, updated_at)
       VALUES ('App\\\\Models\\\\Seller', ?, ?, SHA2(?, 256), 'android', 'seller', NOW(), NOW())`,
      [person.externalId, token, token],
    );

  describe('who is told (FR-063)', () => {
    it("a like on seller 1's reel goes to seller 1's seller-app device, and to no other", async () => {
      const reel = await createPublishedReel(testApp, 1);
      const fan = await issueToken(testApp.infra, 'customer', 2);

      const res = await like(fan, reel.id);

      expect(res.status).toBe(201);
      await eventually(() => {
        expect(firebase.to('fcm-token-seller-1')).toHaveLength(1);
      });
      const [sent] = firebase.to('fcm-token-seller-1');
      expect(sent.app).toBe('seller');
      expect(sent.request.tokens).toEqual(['fcm-token-seller-1']);
      // Customer 1 shares seller 1's number and has a device of their own: it is never used.
      await settle();
      expect(firebase.to('fcm-token-customer-1')).toEqual([]);
    });

    it("a follow of customer 1 goes to customer 1's customer-app device, not seller 1's", async () => {
      const follower = await issueToken(testApp.infra, 'customer', 2);
      const me = await api().get<{ id: string }>('/api/users/me', {
        token: await issueToken(testApp.infra, 'customer', 1),
      });

      await api().post(`/api/users/${me.data.id}/follow`, { token: follower });

      await eventually(() => {
        expect(firebase.to('fcm-token-customer-1')).toHaveLength(1);
      });
      expect(firebase.to('fcm-token-customer-1')[0].app).toBe('customer');
      expect(firebase.to('fcm-token-customer-1')[0].request.tokens).toEqual([
        'fcm-token-customer-1',
      ]);
    });

    it('an account with no registered device is simply not told', async () => {
      const creator = await createPerson(testApp, 'seller');
      const fan = await createPerson(testApp, 'customer');
      const reel = await createPublishedReel(testApp, creator.externalId);
      const before = firebase.sent.length;

      expect((await like(fan.token, reel.id)).status).toBe(201);
      await settle();

      expect(firebase.sent.length).toBe(before);
    });
  });

  describe('who is not told (FR-054)', () => {
    it('does not tell anyone about their own like', async () => {
      const creator = await createPerson(testApp, 'seller');
      await sellerDevice(creator, 'fcm-self-like');
      const reel = await createPublishedReel(testApp, creator.externalId);

      expect((await like(creator.token, reel.id)).status).toBe(201);
      await settle();

      expect(firebase.to('fcm-self-like')).toEqual([]);
    });

    it('tells once about a follow, however often it is undone and redone', async () => {
      const creator = await createPerson(testApp, 'seller');
      await sellerDevice(creator, 'fcm-refollow');
      const fan = await createPerson(testApp, 'customer');
      const toggle = () =>
        api().post(`/api/users/${creator.id}/follow`, { token: fan.token });

      await toggle();
      await eventually(() => {
        expect(firebase.to('fcm-refollow')).toHaveLength(1);
      });
      await toggle(); // unfollow
      await toggle(); // follow again
      await settle();

      expect(firebase.to('fcm-refollow')).toHaveLength(1);
    });
  });

  describe('the language (FR-065)', () => {
    it('is Arabic until the recipient has been seen using English, and English after', async () => {
      const creator = await createPerson(testApp, 'seller');
      await sellerDevice(creator, 'fcm-language');
      const fan = await createPerson(testApp, 'customer', {
        firstName: 'Sara',
      });
      const first = await createPublishedReel(testApp, creator.externalId);
      const second = await createPublishedReel(testApp, creator.externalId);

      await like(fan.token, first.id);
      await eventually(() => {
        expect(firebase.to('fcm-language')).toHaveLength(1);
      });
      expect(firebase.to('fcm-language')[0].request.notification.title).toBe(
        'إعجاب جديد',
      );

      // The recipient's next request says English.
      await api().get('/api/users/me', {
        token: creator.token,
        language: 'en',
      });

      await like(fan.token, second.id);
      await eventually(() => {
        expect(firebase.to('fcm-language')).toHaveLength(2);
      });
      const english = firebase.to('fcm-language')[1].request.notification;
      expect(english.title).toBe('New like');
      expect(english.body).toBe('Sara N. liked your reel');
    });
  });

  describe('what a message carries (FR-073a, SC-015)', () => {
    it('is the title and body, the type and the ids, and an expiry of 24 hours on both platforms', async () => {
      const creator = await createPerson(testApp, 'seller');
      await sellerDevice(creator, 'fcm-payload');
      const fan = await createPerson(testApp, 'customer');
      const reel = await createPublishedReel(testApp, creator.externalId, {
        description: 'a description that must never leave the country',
      });
      const before = Date.now();

      await like(fan.token, reel.id);
      await eventually(() => {
        expect(firebase.to('fcm-payload')).toHaveLength(1);
      });

      const { tokens, ...message } = firebase.to('fcm-payload')[0].request;
      expect(tokens).toEqual(['fcm-payload']);
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
      expect(message.data).toEqual({
        source: 'reels',
        type: 'reelLike',
        actorId: fan.id,
        reelId: reel.id,
      });
      expect(message.android).toEqual({ ttl: 24 * 60 * 60 * 1000 });
      const expiration = Number(message.apns.headers['apns-expiration']);
      expect(expiration).toBeGreaterThanOrEqual(
        Math.floor(before / 1000) + 24 * 60 * 60,
      );
      expect(expiration).toBeLessThanOrEqual(
        Math.floor(Date.now() / 1000) + 24 * 60 * 60,
      );
      // Nothing private travels: not the description, the handle, the numbers or the email.
      const wire = JSON.stringify(firebase.to('fcm-payload')[0].request);
      expect(wire).not.toContain('must never leave the country');
      expect(wire).not.toContain(fan.username);
      expect(wire).not.toContain('@example.test');
      expect(wire).not.toContain('+966');
    });

    it('is the same shape for a mention and a rejection', async () => {
      const creator = await createPerson(testApp, 'seller');
      const mentioned = await createPerson(testApp, 'seller');
      await sellerDevice(creator, 'fcm-rejected');
      await sellerDevice(mentioned, 'fcm-mentioned');
      const upload = (description: string) =>
        api().post('/api/reels', {
          token: creator.token,
          multipart: {
            fields: { description },
            files: [
              {
                field: 'video',
                path: `${__dirname}/../fixtures/media/sample-10s.mp4`,
                contentType: 'video/mp4',
              },
            ],
          },
        });

      await upload(`hello @${mentioned.username}`);
      await upload('flagged nsfw-test');

      await eventually(() => {
        expect(firebase.to('fcm-mentioned')).toHaveLength(1);
        expect(firebase.to('fcm-rejected')).toHaveLength(1);
      });
      const mention = firebase.to('fcm-mentioned')[0].request;
      const rejection = firebase.to('fcm-rejected')[0].request;
      expect(Object.keys(mention.data).sort()).toEqual([
        'actorId',
        'reelId',
        'source',
        'type',
      ]);
      expect(mention.data.type).toBe('reelMention');
      expect(Object.keys(rejection.data).sort()).toEqual([
        'reelId',
        'source',
        'type',
      ]);
      expect(rejection.data.type).toBe('reelRejected');
    });
  });

  describe('dead tokens', () => {
    it('skips a token Firebase reported as unregistered on the next send', async () => {
      const creator = await createPerson(testApp, 'seller');
      await sellerDevice(creator, 'fcm-dead');
      await sellerDevice(creator, 'fcm-alive');
      firebase.deadTokens.add('fcm-dead');
      const fan = await createPerson(testApp, 'customer');
      const reel = await createPublishedReel(testApp, creator.externalId);

      await like(fan.token, reel.id);
      await eventually(() => {
        expect(firebase.to('fcm-alive')).toHaveLength(1);
      });
      expect(firebase.to('fcm-alive')[0].request.tokens.sort()).toEqual([
        'fcm-alive',
        'fcm-dead',
      ]);

      // A different notification to the same account.
      await api().post(`/api/users/${creator.id}/follow`, { token: fan.token });
      await eventually(() => {
        expect(firebase.to('fcm-alive')).toHaveLength(2);
      });
      expect(firebase.to('fcm-alive')[1].request.tokens).toEqual(['fcm-alive']);
      expect(firebase.to('fcm-dead')).toHaveLength(1);
    });
  });

  // Last: a failing sender leaves a job to retry later, and a late retry must not land in another test.
  describe('when sending fails (FR-066)', () => {
    afterAll(() => {
      firebase.failWith = undefined;
    });

    it('never fails the like that caused it, and the like and its event still stand', async () => {
      const creator = await createPerson(testApp, 'seller');
      await sellerDevice(creator, 'fcm-failing');
      const fan = await createPerson(testApp, 'customer');
      const reel = await createPublishedReel(testApp, creator.externalId);
      firebase.failWith = new Error('Firebase is down');

      const res = await like(fan.token, reel.id);

      expect(res.status).toBe(201);
      expect((res.data as { liked: boolean }).liked).toBe(true);
      const read = await api().get<{
        viewerLiked: boolean;
        likesCount: number;
      }>(`/api/reels/${reel.id}`, { token: fan.token });
      expect(read.data).toMatchObject({ viewerLiked: true, likesCount: 1 });
      expect(firebase.to('fcm-failing')).toEqual([]);
    });
  });
});
