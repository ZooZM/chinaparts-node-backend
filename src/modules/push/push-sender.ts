/** Injection token for whatever delivers a push notification. */
export const PUSH_SENDER = Symbol('PUSH_SENDER');

export type PushJobType =
  'newFollower' | 'reelLike' | 'reelMention' | 'reelRejected';

/**
 * A notification to deliver, by id only. The text (in the recipient's language) and the device
 * list are worked out where it is sent, so a job carries nothing that could go stale or leak
 * (FR-073a, research R14).
 */
export interface PushJob {
  recipientId: string;
  type: PushJobType;
  actorId?: string;
  reelId?: string;
}

export interface PushSender {
  /** Queues or sends the notification. Failures are the caller's to log, never to propagate (FR-066). */
  send(job: PushJob): Promise<void>;
}
