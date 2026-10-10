import { Injectable } from '@nestjs/common';
import type { PushJob, PushJobType } from './push-sender';
import { renderMessage } from './templates';

/** A push is held by the platform for at most this long if the device is off (research R14). */
const MESSAGE_TTL_MS = 24 * 60 * 60 * 1000;

declare const composedByBuilder: unique symbol;

/**
 * A message ready to send. Only `PushPayloadBuilder` makes one, and the sender accepts nothing
 * else, so there is exactly one place where the contents of a push are decided (FR-073a, SC-015).
 */
export interface PushMessage {
  notification: { title: string; body: string };
  data: {
    source: 'reels';
    type: PushJobType;
    actorId?: string;
    reelId?: string;
  };
  android: { ttl: number };
  apns: { headers: { 'apns-expiration': string } };
  readonly [composedByBuilder]?: never;
}

/**
 * The one place a push message is composed (research R14).
 *
 * FCM and APNs relay messages outside Saudi Arabia, which FR-073a permits for this content only:
 * the title and body in the recipient's language, which may contain the actor's public name, and a
 * `data` block of `source`, `type`, and the ids of the actor and the reel. Nothing else: no reel
 * text, no comment, no handle, no China Parts field. The unit test for this class fails on any
 * other key, and `PushMessage` is the only type the sender takes.
 */
@Injectable()
export class PushPayloadBuilder {
  build(
    job: PushJob,
    recipientLocale: string | undefined,
    actorName?: string,
    now: number = Date.now(),
  ): PushMessage {
    const text = renderMessage(recipientLocale, job.type, { actorName });
    const data: PushMessage['data'] = { source: 'reels', type: job.type };
    if (job.actorId) data.actorId = job.actorId;
    if (job.reelId) data.reelId = job.reelId;

    return {
      notification: { title: text.title, body: text.body },
      data,
      android: { ttl: MESSAGE_TTL_MS },
      apns: {
        headers: {
          // Seconds since the epoch, as APNs wants it.
          'apns-expiration': String(Math.floor((now + MESSAGE_TTL_MS) / 1000)),
        },
      },
    };
  }
}
