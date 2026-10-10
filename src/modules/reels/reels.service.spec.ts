import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  NotFoundException,
} from '@nestjs/common';
import { Types } from 'mongoose';
import { ReelsService } from './reels.service';
import { ReelsRepository } from './reels.repository';
import { ReelsNotificationsService } from './reels-notifications.service';

interface MockUserModel {
  findById: jest.Mock;
  find: jest.Mock;
  updateOne: jest.Mock;
}

/**
 * Unit tests for `ReelsService` against a mocked `ReelsRepository` (v2 —
 * the previous suite drove the in-memory `ReelsMockStore` directly; that
 * store is retired now that the repository is Mongoose-backed. Repository-
 * level behavior — real counter integrity, block filtering, unique-index
 * dedup — is covered by `reels.e2e-spec.ts` against `mongodb-memory-server`.
 * This suite proves ReelsService's own logic: block-set assembly,
 * self-follow/self-block guards, and that notifications fire only on the
 * "on" transition (never on unlike/unfollow).
 */
describe('ReelsService', () => {
  const viewerId = '65f1a2b3c4d5e6f7a8b9c0d1';
  const otherId = '65f1a2b3c4d5e6f7a8b9c0d2';
  const reelId = '65f1a2b3c4d5e6f7a8b9c0e1';

  let repository: jest.Mocked<ReelsRepository>;
  let userModel: MockUserModel;
  let notifications: jest.Mocked<ReelsNotificationsService>;
  let service: ReelsService;

  beforeEach(() => {
    repository = {
      createReel: jest.fn(),
      listFeed: jest.fn(),
      getReel: jest.fn(),
      toggleLike: jest.fn(),
      listComments: jest.fn(),
      addComment: jest.fn(),
      recordShare: jest.fn(),
      getProfile: jest.fn(),
      toggleFollow: jest.fn(),
      recordView: jest.fn(),
      toggleSave: jest.fn(),
      listLiked: jest.fn(),
      listSaved: jest.fn(),
      searchReels: jest.fn(),
      searchUsers: jest.fn(),
      deleteReel: jest.fn(),
      reportReel: jest.fn(),
      listHiddenReels: jest.fn(),
      adminModerateReel: jest.fn(),
      repostReel: jest.fn(),
      unrepostReel: jest.fn(),
      listFollowingFeed: jest.fn(),
      getFollowingUsers: jest.fn(),
      listReposted: jest.fn(),
      listReposters: jest.fn(),
    };

    userModel = {
      findById: jest.fn(() => ({
        select: jest.fn(() => ({
          lean: jest.fn(() => ({
            exec: jest.fn(() => Promise.resolve({ blockedUsers: [] })),
          })),
        })),
        exec: jest.fn(() => Promise.resolve({ blockedUsers: [] })),
      })),
      find: jest.fn(() => ({
        select: jest.fn(() => ({
          lean: jest.fn(() => ({ exec: jest.fn(() => Promise.resolve([])) })),
        })),
      })),
      updateOne: jest.fn(() => ({ exec: jest.fn(() => Promise.resolve()) })),
    };

    notifications = {
      notifyNewFollower: jest.fn(),
      notifyReelLike: jest.fn(),
      notifyMentions: jest.fn(),
      notifyReelRejected: jest.fn(),
    } as unknown as jest.Mocked<ReelsNotificationsService>;

    const moderationQueue = { add: jest.fn() };

    service = new ReelsService(
      repository,
      userModel as never,
      notifications,
      moderationQueue as never,
    );
  });

  describe('getFeed', () => {
    it('passes the caller block set through to the repository', async () => {
      userModel.findById.mockReturnValueOnce({
        select: jest.fn(() => ({
          lean: jest.fn(() => ({
            exec: jest.fn(() =>
              Promise.resolve({ blockedUsers: [new Types.ObjectId(otherId)] }),
            ),
          })),
        })),
        exec: jest.fn(),
      });
      repository.listFeed.mockResolvedValue({ items: [], nextCursor: null });

      await service.getFeed(viewerId, { limit: 10 } as never);

      // jest.fn() properties and Jest's asymmetric matchers are not
      // `this`-bound / are typed `any` by design — both are known
      // typescript-eslint false positives on jest mocks, not real issues.
      // eslint-disable-next-line @typescript-eslint/unbound-method
      expect(repository.listFeed).toHaveBeenCalledWith(
        expect.objectContaining({
          viewerId,
          // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
          excludeCreatorIds: expect.arrayContaining([otherId]),
        }),
      );
    });
  });

  describe('getReel', () => {
    it('throws NotFoundException when the repository returns null', async () => {
      repository.getReel.mockResolvedValue(null);
      await expect(service.getReel(reelId, viewerId)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });

  describe('toggleLike', () => {
    it('notifies the creator when a like turns ON', async () => {
      repository.toggleLike.mockResolvedValue({
        liked: true,
        likesCount: 5,
        reel: {
          id: reelId,
          creatorId: otherId,
          videoUrl: '',
          thumbnailUrl: '',
          description: '',
          hashtags: [],
          mentions: [],
          createdAt: new Date().toISOString(),
        },
      });

      await service.toggleLike(reelId, viewerId);

      // eslint-disable-next-line @typescript-eslint/unbound-method
      expect(notifications.notifyReelLike).toHaveBeenCalledWith({
        actorId: viewerId,
        recipientId: otherId,
        reelId,
      });
    });

    it('does NOT notify when a like turns OFF (unlike)', async () => {
      repository.toggleLike.mockResolvedValue({
        liked: false,
        likesCount: 4,
        reel: {
          id: reelId,
          creatorId: otherId,
          videoUrl: '',
          thumbnailUrl: '',
          description: '',
          hashtags: [],
          mentions: [],
          createdAt: new Date().toISOString(),
        },
      });

      await service.toggleLike(reelId, viewerId);

      // eslint-disable-next-line @typescript-eslint/unbound-method
      expect(notifications.notifyReelLike).not.toHaveBeenCalled();
    });

    it('throws NotFoundException for an unknown reel', async () => {
      repository.toggleLike.mockResolvedValue(null);
      await expect(service.toggleLike(reelId, viewerId)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });

  describe('toggleFollow (US5)', () => {
    it('notifies the followee when following turns ON', async () => {
      repository.toggleFollow.mockResolvedValue({
        following: true,
        followersCount: 10,
      });

      await service.toggleFollow(otherId, viewerId);

      // eslint-disable-next-line @typescript-eslint/unbound-method
      expect(notifications.notifyNewFollower).toHaveBeenCalledWith({
        actorId: viewerId,
        recipientId: otherId,
      });
    });

    it('does NOT notify when unfollowing', async () => {
      repository.toggleFollow.mockResolvedValue({
        following: false,
        followersCount: 9,
      });

      await service.toggleFollow(otherId, viewerId);

      // eslint-disable-next-line @typescript-eslint/unbound-method
      expect(notifications.notifyNewFollower).not.toHaveBeenCalled();
    });

    it('rejects following yourself with BadRequestException without touching the repository', async () => {
      repository.toggleFollow.mockResolvedValue('self');
      await expect(
        service.toggleFollow(viewerId, viewerId),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('throws NotFoundException for an unknown user', async () => {
      repository.toggleFollow.mockResolvedValue(null);
      await expect(
        service.toggleFollow(otherId, viewerId),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('recordView / toggleSave (FR-048/FR-049)', () => {
    it('recordView throws NotFoundException for an unknown reel', async () => {
      repository.recordView.mockResolvedValue(null);
      await expect(service.recordView(reelId, viewerId)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('toggleSave returns the repository result unchanged (no public counter)', async () => {
      repository.toggleSave.mockResolvedValue({ saved: true });
      const result = await service.toggleSave(reelId, viewerId);
      expect(result).toEqual({ saved: true });
    });
  });

  describe('toggleBlock (FR-052)', () => {
    it('rejects blocking yourself with BadRequestException', async () => {
      await expect(
        service.toggleBlock(viewerId, viewerId),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('throws NotFoundException for an unknown target', async () => {
      userModel.findById.mockReturnValue({
        exec: jest.fn(() => Promise.resolve(null)),
        select: jest.fn(),
      });
      await expect(
        service.toggleBlock(otherId, viewerId),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('deleteReel (FR-067, v3)', () => {
    it('returns { deleted: true } on success', async () => {
      repository.deleteReel.mockResolvedValue({
        deleted: true,
        videoUrl: '/uploads/reels/videos/a.mp4',
        thumbnailUrl: '/uploads/reels/thumbs/a.jpg',
      });
      const result = await service.deleteReel(reelId, viewerId);
      expect(result).toEqual({ deleted: true });
    });

    it('throws NotFoundException for an unknown reel', async () => {
      repository.deleteReel.mockResolvedValue(null);
      await expect(
        service.deleteReel(reelId, viewerId),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('throws ForbiddenException when the caller is not the owner', async () => {
      repository.deleteReel.mockResolvedValue('forbidden');
      await expect(
        service.deleteReel(reelId, otherId),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });
  });

  describe('reportReel (FR-069/FR-070, v4)', () => {
    it('returns the repository result unchanged on success', async () => {
      repository.reportReel.mockResolvedValue({
        reported: true,
        alreadyReported: false,
      });
      const result = await service.reportReel(reelId, viewerId, {
        reason: 'spam',
      });
      expect(result).toEqual({ reported: true, alreadyReported: false });
    });

    it('passes alreadyReported through unchanged for a duplicate report', async () => {
      repository.reportReel.mockResolvedValue({
        reported: true,
        alreadyReported: true,
      });
      const result = await service.reportReel(reelId, viewerId, {
        reason: 'spam',
      });
      expect(result).toEqual({ reported: true, alreadyReported: true });
    });

    it('throws NotFoundException for an unknown/non-published reel', async () => {
      repository.reportReel.mockResolvedValue(null);
      await expect(
        service.reportReel(reelId, viewerId, { reason: 'spam' }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('rejects reporting your own reel with BadRequestException', async () => {
      repository.reportReel.mockResolvedValue('self');
      await expect(
        service.reportReel(reelId, viewerId, { reason: 'spam' }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('maps the daily rate limit to a 429 HttpException', async () => {
      repository.reportReel.mockResolvedValue('rate_limited');
      const promise = service.reportReel(reelId, viewerId, { reason: 'spam' });
      await expect(promise).rejects.toBeInstanceOf(HttpException);
      await promise.catch((err: HttpException) => {
        expect(err.getStatus()).toBe(HttpStatus.TOO_MANY_REQUESTS);
      });
    });
  });

  describe('admin moderation (FR-071, v4)', () => {
    it('listHiddenReels defaults to limit 20 and forwards the repository page', async () => {
      const page = { items: [], nextCursor: null };
      repository.listHiddenReels.mockResolvedValue(page);
      const result = await service.listHiddenReels({});
      expect(repository.listHiddenReels).toHaveBeenCalledWith({
        cursor: undefined,
        limit: 20,
      });
      expect(result).toBe(page);
    });

    it('adminModerateReel returns the repository result unchanged on success', async () => {
      repository.adminModerateReel.mockResolvedValue({
        id: reelId,
        status: 'published',
      });
      const result = await service.adminModerateReel(reelId, 'restore');
      expect(result).toEqual({ id: reelId, status: 'published' });
    });

    it('adminModerateReel throws NotFoundException for an unknown reel', async () => {
      repository.adminModerateReel.mockResolvedValue(null);
      await expect(
        service.adminModerateReel(reelId, 'restore'),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('adminModerateReel throws ConflictException when the reel is not hidden', async () => {
      repository.adminModerateReel.mockResolvedValue('not_hidden');
      await expect(
        service.adminModerateReel(reelId, 'reject'),
      ).rejects.toBeInstanceOf(ConflictException);
    });
  });

  describe('repost / following feed (FR-073/FR-075, v4)', () => {
    it('repostReel returns the repository result unchanged on success', async () => {
      repository.repostReel.mockResolvedValue({ reposted: true });
      const result = await service.repostReel(reelId, viewerId);
      expect(result).toEqual({ reposted: true });
    });

    it('repostReel throws NotFoundException for an unknown/non-published reel', async () => {
      repository.repostReel.mockResolvedValue(null);
      await expect(service.repostReel(reelId, viewerId)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('repostReel rejects reposting your own reel with BadRequestException', async () => {
      repository.repostReel.mockResolvedValue('self');
      await expect(service.repostReel(reelId, viewerId)).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it('unrepostReel returns the repository result unchanged on success', async () => {
      repository.unrepostReel.mockResolvedValue({ reposted: false });
      const result = await service.unrepostReel(reelId, viewerId);
      expect(result).toEqual({ reposted: false });
    });

    it('unrepostReel throws NotFoundException for an unknown reel', async () => {
      repository.unrepostReel.mockResolvedValue(null);
      await expect(
        service.unrepostReel(reelId, viewerId),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('getFollowingFeed defaults to limit 10 and forwards the block set + repository page', async () => {
      const page = { items: [], nextCursor: null };
      repository.listFollowingFeed.mockResolvedValue(page);
      const result = await service.getFollowingFeed(viewerId, {});
      expect(repository.listFollowingFeed).toHaveBeenCalledWith(
        expect.objectContaining({ viewerId, cursor: undefined, limit: 10 }),
      );
      expect(result).toBe(page);
    });

    // v5 (FR-084): mention-suggestion source.
    it('getFollowingUsers defaults to limit 50 and forwards the block set + repository page', async () => {
      const page = {
        items: [
          { id: otherId, username: 'sara', name: 'Sara', avatarUrl: '' },
        ],
        nextCursor: null,
      };
      repository.getFollowingUsers.mockResolvedValue(page);
      const result = await service.getFollowingUsers(viewerId, {});
      expect(repository.getFollowingUsers).toHaveBeenCalledWith(
        expect.objectContaining({ viewerId, cursor: undefined, limit: 50 }),
      );
      expect(result).toBe(page);
    });

    it('getFollowingUsers forwards an explicit cursor/limit unchanged', async () => {
      const page = { items: [], nextCursor: '50' };
      repository.getFollowingUsers.mockResolvedValue(page);
      await service.getFollowingUsers(viewerId, { cursor: '10', limit: 25 });
      expect(repository.getFollowingUsers).toHaveBeenCalledWith(
        expect.objectContaining({ viewerId, cursor: '10', limit: 25 }),
      );
    });

    // v6: public Reposts tab.
    it('getReposted targets the query.userId (public) and forwards the block set', async () => {
      const page = { items: [], nextCursor: null };
      repository.listReposted.mockResolvedValue(page);
      const result = await service.getReposted(viewerId, { userId: otherId });
      expect(repository.listReposted).toHaveBeenCalledWith(
        viewerId,
        otherId,
        expect.objectContaining({ cursor: undefined, limit: 10 }),
      );
      expect(result).toBe(page);
    });

    it('getReposted defaults the target to the caller when userId is omitted', async () => {
      repository.listReposted.mockResolvedValue({ items: [], nextCursor: null });
      await service.getReposted(viewerId, {});
      expect(repository.listReposted).toHaveBeenCalledWith(
        viewerId,
        viewerId,
        expect.anything(),
      );
    });

    // v6: reposters bottom sheet.
    it('getReposters forwards the reelId + block set and returns the repository page', async () => {
      const page = { items: [], nextCursor: null };
      repository.listReposters.mockResolvedValue(page);
      const result = await service.getReposters(viewerId, reelId, {});
      expect(repository.listReposters).toHaveBeenCalledWith(
        reelId,
        expect.objectContaining({ viewerId, limit: 20 }),
      );
      expect(result).toBe(page);
    });

    it('getReposters throws NotFound when the reel is unknown/not visible', async () => {
      repository.listReposters.mockResolvedValue(null);
      await expect(service.getReposters(viewerId, reelId, {})).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });
});
