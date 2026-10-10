import { Inject, Injectable, Logger } from '@nestjs/common';
import Redis from 'ioredis';
import { createHash } from 'node:crypto';
import type { AccountType } from '../../common/http/viewer-request';
import { REDIS_CLIENT } from '../../common/redis/redis.module';
import { FIREBASE_MESSAGING } from './firebase-messaging';
import type { FirebaseMessaging } from './firebase-messaging';
import type { PushMessage } from './push-payload.builder';

/** Injection token for the client that sends a composed message to devices. */
export const FCM_SENDER_CLIENT = Symbol('FCM_SENDER_CLIENT');

export interface FcmSenderClient {
  sendMulticast(
    app: AccountType,
    tokens: string[],
    message: PushMessage,
  ): Promise<{ sent: number; skippedDead: number }>;
}

/** Firebase's own answers that mean "this token will never work again". */
const DEAD_TOKEN_CODES: ReadonlySet<string> = new Set([
  'messaging/registration-token-not-registered',
  'messaging/invalid-registration-token',
]);
const DEAD_TOKEN_SECONDS = 30 * 24 * 60 * 60;
/** FCM takes at most 500 tokens in one multicast. */
const MULTICAST_LIMIT = 500;

const deadKey = (token: string) =>
  `push:dead:${createHash('sha256').update(token).digest('hex')}`;

/**
 * Sends a composed message to devices (research R14). It takes only a `PushMessage`, the type only
 * `PushPayloadBuilder` makes, so nothing here can add to what a push says.
 *
 * China Parts owns the device table and this service cannot delete from it, so a token Firebase
 * reports as unregistered is remembered in Redis for 30 days, by hash, and left out of later sends.
 * The token itself is never stored or logged here.
 */
@Injectable()
export class FcmPushClient implements FcmSenderClient {
  private readonly logger = new Logger(FcmPushClient.name);

  constructor(
    @Inject(FIREBASE_MESSAGING) private readonly firebase: FirebaseMessaging,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
  ) {}

  async sendMulticast(
    app: AccountType,
    tokens: string[],
    message: PushMessage,
  ): Promise<{ sent: number; skippedDead: number }> {
    const unique = [...new Set(tokens)];
    if (unique.length === 0) return { sent: 0, skippedDead: 0 };

    const live = await this.withoutDead(unique);
    let sent = 0;
    for (let index = 0; index < live.length; index += MULTICAST_LIMIT) {
      const batch = live.slice(index, index + MULTICAST_LIMIT);
      const outcome = await this.firebase.sendEachForMulticast(app, {
        ...message,
        tokens: batch,
      });
      sent += outcome.responses.filter((response) => response.success).length;
      await this.rememberDead(batch, outcome);
    }
    return { sent, skippedDead: unique.length - live.length };
  }

  private async withoutDead(tokens: string[]): Promise<string[]> {
    try {
      const flags = await this.redis.mget(...tokens.map(deadKey));
      return tokens.filter((_, index) => flags[index] === null);
    } catch (error) {
      // Without the list a dead token is tried again, which costs a send and nothing more.
      this.logger.warn(`Dead push tokens could not be read: ${String(error)}`);
      return tokens;
    }
  }

  private async rememberDead(
    batch: string[],
    outcome: { responses: Array<{ success: boolean; errorCode?: string }> },
  ): Promise<void> {
    for (const [index, response] of outcome.responses.entries()) {
      if (response.success || !DEAD_TOKEN_CODES.has(response.errorCode ?? ''))
        continue;
      try {
        await this.redis.set(
          deadKey(batch[index]),
          '1',
          'EX',
          DEAD_TOKEN_SECONDS,
        );
      } catch (error) {
        this.logger.warn(
          `A dead push token could not be remembered: ${String(error)}`,
        );
      }
    }
  }
}
