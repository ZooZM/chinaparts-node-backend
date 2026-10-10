import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { BaseRepository } from '../../../common/repositories/base.repository';
import {
  CommentDeletedBy,
  ReelComment,
  ReelCommentDocument,
} from '../schemas/reel-comment.schema';

/** Reads and writes comments, and nothing else (constitution II). */
@Injectable()
export class CommentsRepository extends BaseRepository<ReelCommentDocument> {
  constructor(
    @InjectModel(ReelComment.name) model: Model<ReelCommentDocument>,
  ) {
    super(model);
  }

  /** A comment that exists on this reel and has not been deleted, or null. */
  async findActive(
    reelId: string,
    commentId: string,
  ): Promise<{ authorId: string } | null> {
    const comment = await this.model
      .findOne({
        _id: new Types.ObjectId(commentId),
        videoId: new Types.ObjectId(reelId),
        deletedAt: null,
      })
      .select({ authorId: 1 })
      .lean<{ authorId: Types.ObjectId }>()
      .exec();
    return comment ? { authorId: comment.authorId.toString() } : null;
  }

  /**
   * Soft-deletes the comment, and says whether this call was the one that did it. The filter
   * requires `deletedAt: null`, so of any number of simultaneous deletes exactly one matches. The
   * caller adjusts the reel's counter only for that one, which is what keeps the count right.
   */
  async softDelete(
    reelId: string,
    commentId: string,
    role: CommentDeletedBy,
  ): Promise<boolean> {
    const deleted = await this.findOneAndUpdate(
      {
        _id: new Types.ObjectId(commentId),
        videoId: new Types.ObjectId(reelId),
        deletedAt: null,
      },
      { $set: { deletedAt: new Date(), deletedByRole: role } },
    );
    return deleted !== null;
  }
}
