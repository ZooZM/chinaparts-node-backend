import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { Types } from 'mongoose';
import { ErrorCode } from '../../../common/errors/error-codes';
import { user } from '../../../common/guards/testing';
import type { ReelSnapshot, ReelsRepository } from '../reels.repository';
import type { CommentsRepository } from './comments.repository';
import { CommentsService } from './comments.service';

const reelId = new Types.ObjectId().toString();
const commentId = new Types.ObjectId().toString();
const authorId = new Types.ObjectId().toString();
const ownerId = new Types.ObjectId().toString();
const strangerId = new Types.ObjectId().toString();

function setup(
  options: {
    comment?: { authorId: string } | null;
    reelCreator?: string | null;
    softDeleted?: boolean;
  } = {},
) {
  const findActive = jest
    .fn()
    .mockResolvedValue('comment' in options ? options.comment : { authorId });
  const softDelete = jest.fn().mockResolvedValue(options.softDeleted ?? true);
  const getSnapshot = jest.fn().mockResolvedValue(
    options.reelCreator === null
      ? null
      : ({
          id: reelId,
          creatorId: options.reelCreator ?? ownerId,
        } as ReelSnapshot),
  );
  const adjustCommentsCount = jest.fn().mockResolvedValue(undefined);
  const service = new CommentsService(
    { findActive, softDelete } as unknown as CommentsRepository,
    { getSnapshot, adjustCommentsCount } as unknown as ReelsRepository,
  );
  return { service, findActive, softDelete, getSnapshot, adjustCommentsCount };
}

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    if (
      error instanceof ForbiddenException ||
      error instanceof NotFoundException
    ) {
      return (error.getResponse() as { error: string }).error;
    }
    throw error;
  }
  return 'no error';
}

describe('CommentsService.deleteComment (FR-008, EP22)', () => {
  describe('as a user', () => {
    it("lets the author delete, with the role author, and takes the reel's count down once", async () => {
      const { service, softDelete, adjustCommentsCount } = setup();

      await expect(
        service.deleteComment(reelId, commentId, {
          user: user({ userId: authorId }),
        }),
      ).resolves.toEqual({ deleted: true });

      expect(softDelete).toHaveBeenCalledWith(reelId, commentId, 'author');
      expect(adjustCommentsCount).toHaveBeenCalledWith(reelId, -1);
    });

    it('lets the author delete whatever their standing', async () => {
      const { service, softDelete } = setup();

      await service.deleteComment(reelId, commentId, {
        user: user({ userId: authorId, standing: 'suspended' }),
      });

      expect(softDelete).toHaveBeenCalledWith(reelId, commentId, 'author');
    });

    it("lets the reel's creator delete, with the role reel_owner, in good standing", async () => {
      const { service, softDelete, adjustCommentsCount } = setup();

      await service.deleteComment(reelId, commentId, {
        user: user({ userId: ownerId }),
      });

      expect(softDelete).toHaveBeenCalledWith(reelId, commentId, 'reel_owner');
      expect(adjustCommentsCount).toHaveBeenCalledWith(reelId, -1);
    });

    it("needs the reel's creator to be in good standing", async () => {
      const { service, softDelete, adjustCommentsCount } = setup();

      const code = await codeOf(
        service.deleteComment(reelId, commentId, {
          user: user({ userId: ownerId, standing: 'suspended' }),
        }),
      );

      expect(code).toBe(ErrorCode.ACCOUNT_NOT_IN_GOOD_STANDING);
      expect(softDelete).not.toHaveBeenCalled();
      expect(adjustCommentsCount).not.toHaveBeenCalled();
    });

    it('refuses anyone else', async () => {
      const { service, softDelete } = setup();

      const code = await codeOf(
        service.deleteComment(reelId, commentId, {
          user: user({ userId: strangerId }),
        }),
      );

      expect(code).toBe(ErrorCode.COMMENT_NOT_DELETABLE);
      expect(softDelete).not.toHaveBeenCalled();
    });

    it('treats a comment that is missing or already deleted as not found, and does not look at the reel', async () => {
      const { service, getSnapshot, softDelete } = setup({ comment: null });

      const code = await codeOf(
        service.deleteComment(reelId, commentId, {
          user: user({ userId: authorId }),
        }),
      );

      expect(code).toBe(ErrorCode.COMMENT_NOT_FOUND);
      expect(getSnapshot).not.toHaveBeenCalled();
      expect(softDelete).not.toHaveBeenCalled();
    });

    it('treats an id that is not an id as not found', async () => {
      const { service, findActive } = setup();

      const code = await codeOf(
        service.deleteComment('nope', 'nope', {
          user: user({ userId: authorId }),
        }),
      );

      expect(code).toBe(ErrorCode.COMMENT_NOT_FOUND);
      expect(findActive).not.toHaveBeenCalled();
    });

    it('loses a race quietly: if someone else deleted it first, it is not found and the count is not touched', async () => {
      const { service, adjustCommentsCount } = setup({ softDeleted: false });

      const code = await codeOf(
        service.deleteComment(reelId, commentId, {
          user: user({ userId: authorId }),
        }),
      );

      expect(code).toBe(ErrorCode.COMMENT_NOT_FOUND);
      expect(adjustCommentsCount).not.toHaveBeenCalled();
    });

    it('refuses a creator-looking caller when the reel is gone', async () => {
      const { service } = setup({ reelCreator: null });

      const code = await codeOf(
        service.deleteComment(reelId, commentId, {
          user: user({ userId: ownerId }),
        }),
      );

      expect(code).toBe(ErrorCode.COMMENT_NOT_DELETABLE);
    });
  });

  describe('as an operator', () => {
    it('deletes with the role operator, whoever wrote it and whatever the reel', async () => {
      const { service, softDelete, getSnapshot, adjustCommentsCount } = setup();

      await service.deleteComment(reelId, commentId, { operator: true });

      expect(softDelete).toHaveBeenCalledWith(reelId, commentId, 'operator');
      expect(getSnapshot).not.toHaveBeenCalled();
      expect(adjustCommentsCount).toHaveBeenCalledWith(reelId, -1);
    });
  });
});
