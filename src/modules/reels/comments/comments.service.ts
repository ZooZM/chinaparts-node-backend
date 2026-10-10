import {
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Types } from 'mongoose';
import { ErrorCode } from '../../../common/errors/error-codes';
import type { AuthenticatedUser } from '../../../common/http/viewer-request';
import { REELS_REPOSITORY } from '../reels.repository';
import type { ReelsRepository } from '../reels.repository';
import type { CommentDeletedBy } from '../schemas/reel-comment.schema';
import { CommentsRepository } from './comments.repository';

/** Who is deleting: a signed-in user, or the operator (who is not a user and has no standing). */
export type CommentActor = { user: AuthenticatedUser } | { operator: true };

/** Deleting, and (later) reporting, comments. The rules live here; the repository only writes. */
@Injectable()
export class CommentsService {
  constructor(
    private readonly comments: CommentsRepository,
    @Inject(REELS_REPOSITORY) private readonly reels: ReelsRepository,
  ) {}

  /**
   * Who may delete a comment (FR-008, EP22):
   * - its author, always: leaving a comment is allowed out of good standing, so taking one back is;
   * - the reel's creator, only in good standing, because removing someone else's words is a write
   *   in the ordinary sense;
   * - the operator;
   * - nobody else.
   *
   * A missing comment, a deleted one and a comment on another reel are all `404 COMMENT_NOT_FOUND`.
   */
  async deleteComment(
    reelId: string,
    commentId: string,
    actor: CommentActor,
  ): Promise<{ deleted: true }> {
    if (!Types.ObjectId.isValid(reelId) || !Types.ObjectId.isValid(commentId)) {
      throw this.notFound();
    }
    const comment = await this.comments.findActive(reelId, commentId);
    if (!comment) throw this.notFound();

    const role = await this.roleOf(reelId, comment.authorId, actor);

    // Of simultaneous deletes exactly one gets here with `true`, and only that one adjusts the
    // count, so the counter drops once however many deletes arrive.
    const deleted = await this.comments.softDelete(reelId, commentId, role);
    if (!deleted) throw this.notFound();
    await this.reels.adjustCommentsCount(reelId, -1);
    return { deleted: true };
  }

  private async roleOf(
    reelId: string,
    authorId: string,
    actor: CommentActor,
  ): Promise<CommentDeletedBy> {
    if ('operator' in actor) return 'operator';
    const { user } = actor;
    if (user.userId === authorId) return 'author';

    const reel = await this.reels.getSnapshot(reelId);
    if (reel && reel.creatorId === user.userId) {
      if (user.standing !== 'good') {
        throw new ForbiddenException({
          error: ErrorCode.ACCOUNT_NOT_IN_GOOD_STANDING,
          message: 'Your account is not in good standing',
        });
      }
      return 'reel_owner';
    }
    throw new ForbiddenException({
      error: ErrorCode.COMMENT_NOT_DELETABLE,
      message: 'You cannot delete this comment',
    });
  }

  private notFound(): NotFoundException {
    return new NotFoundException({
      error: ErrorCode.COMMENT_NOT_FOUND,
      message: 'Comment not found',
    });
  }
}
