import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { isDuplicateKeyError } from '../../common/mongo/duplicate-key';
import { BaseRepository } from '../../common/repositories/base.repository';
import {
  NotificationEvent,
  NotificationEventDocument,
  NotificationEventType,
} from './schemas/notification-event.schema';

/** Durable record of notification-worthy actions, which is also what stops duplicates. */
@Injectable()
export class NotificationEventsRepository extends BaseRepository<NotificationEventDocument> {
  constructor(
    @InjectModel(NotificationEvent.name)
    model: Model<NotificationEventDocument>,
  ) {
    super(model);
  }

  /**
   * Writes the event unless an identical one exists. The unique index on
   * `{type, actorId, recipientId, reelId}` is what makes un-liking and re-liking, or unfollowing
   * and following again, a silent no-op instead of a second notification. Returns whether this
   * call wrote a new event. Any failure other than a duplicate is a real error and is thrown.
   */
  async recordIfNew(event: {
    type: NotificationEventType;
    actorId: string | null;
    recipientId: string;
    reelId?: string;
  }): Promise<boolean> {
    try {
      await this.model.create({
        type: event.type,
        actorId: event.actorId ? new Types.ObjectId(event.actorId) : null,
        recipientId: new Types.ObjectId(event.recipientId),
        reelId: event.reelId ? new Types.ObjectId(event.reelId) : undefined,
      });
      return true;
    } catch (error) {
      if (isDuplicateKeyError(error)) return false;
      throw error;
    }
  }
}
