import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  NotFoundException,
} from '@nestjs/common';
import { LimitsService } from '../../common/config/limits';
import type { AuthenticatedUser } from '../../common/http/viewer-request';
import { AccountsService } from '../accounts/accounts.service';
import { StandingService } from '../accounts/standing.service';
import type { HashtagStatsService } from './hashtags/hashtag-stats.service';
import { ReelLifecycleService } from './lifecycle/reel-lifecycle.service';
import { ReelPresenter } from './presentation/reel-presenter.service';
import { ReelsNotificationsService } from './reels-notifications.service';
import type {
  ReelRecord,
  ReelSnapshot,
  ReelsRepository,
} from './reels.repository';
import { ReelsService } from './reels.service';

/** Every repository mock here resolves a promise; the value is whatever a test sets. */
type AnyMock = jest.Mock<Promise<unknown>, unknown[]>;

/** The argument a mock was called with. Typed here once, because `mock.calls` is `any` otherwise. */
function argOf<T>(mock: AnyMock, call = 0, index = 0): T {
  return mock.mock.calls[call][index] as T;
}

/** Every call a mock received, as `unknown[][]`. */
function callsOf(mock: AnyMock): unknown[][] {
  return mock.mock.calls;
}

const meId = '65f1a2b3c4d5e6f7a8b9c0d1';
const otherId = '65f1a2b3c4d5e6f7a8b9c0d2';
const reelId = '65f1a2b3c4d5e6f7a8b9c0e1';

const me: AuthenticatedUser = {
  userId: meId,
  accountType: 'customer',
  externalId: 1,
  standing: 'good',
  locale: 'ar',
  preferredCurrency: null,
};

function snapshot(overrides: Partial<ReelSnapshot> = {}): ReelSnapshot {
  return {
    id: reelId,
    creatorId: otherId,
    status: 'published',
    media: { videoKey: 'v', thumbnailKey: 't', location: 'public' },
    hashtags: [],
    hashtagsNormalized: [],
    ...overrides,
  };
}

const LIMIT_VALUES: Record<string, number> = {
  FEED_PAGE_SIZE_DEFAULT: 10,
  FEED_PAGE_SIZE_MAX: 25,
  COMMENTS_PAGE_SIZE_DEFAULT: 20,
  COMMENTS_PAGE_SIZE_MAX: 50,
  REEL_REPORT_DAILY_LIMIT: 20,
  REEL_REPORT_AUTOHIDE_THRESHOLD: 25,
};

function setup() {
  // Typed once so `argOf` and `callsOf` can take any of these mocks.
  const fn = (): AnyMock => jest.fn<Promise<unknown>, unknown[]>();
  const repository = {
    listFeed: fn().mockResolvedValue({ items: [], nextCursor: '10' }),
    listFollowingFeed: fn().mockResolvedValue({ items: [], nextCursor: null }),
    getFollowingUsers: fn().mockResolvedValue({ items: [], nextCursor: null }),
    listReposters: fn().mockResolvedValue({ items: [], nextCursor: null }),
    listLiked: fn().mockResolvedValue({ items: [], nextCursor: null }),
    listSaved: fn().mockResolvedValue({ items: [], nextCursor: null }),
    listReposted: fn().mockResolvedValue({ items: [], nextCursor: null }),
    searchReels: fn().mockResolvedValue({ items: [], nextCursor: null }),
    searchUsers: fn().mockResolvedValue({ items: [], nextCursor: null }),
    getReel: fn(),
    toggleLike: fn(),
    listComments: fn(),
    addComment: fn(),
    recordShare: fn(),
    getProfile: fn(),
    toggleFollow: fn(),
    recordView: fn(),
    recordGuestView: fn(),
    recordProductTap: fn(),
    toggleSave: fn(),
    deleteReelCascade: fn(),
    reportReel: fn(),
    countRecentReelReports: fn().mockResolvedValue(0),
    getSnapshot: fn(),
    listHiddenReels: fn().mockResolvedValue({ items: [], nextCursor: null }),
    adminModerateReel: fn(),
    repostReel: fn(),
    unrepostReel: fn(),
  };
  const accounts = {
    getBlockSet: jest.fn().mockResolvedValue([]),
    toggleBlock: jest.fn(),
  };
  const standing = {
    members: jest.fn().mockResolvedValue(new Set<string>()),
  };
  const presenter = {
    present: jest.fn((items: ReelRecord[]) =>
      Promise.resolve(items.map((item) => ({ ...item, presented: true }))),
    ),
    presentOne: jest.fn((item: ReelRecord) =>
      Promise.resolve({ ...item, presented: true }),
    ),
    presentProfile: jest.fn((record: object) =>
      Promise.resolve({ ...record, presented: true }),
    ),
    presentHidden: jest.fn((items: object[]) => Promise.resolve(items)),
  };
  const lifecycle = {
    onDeleted: jest.fn().mockResolvedValue(undefined),
    onUnpublished: jest.fn().mockResolvedValue(undefined),
    onRestored: jest.fn().mockResolvedValue(undefined),
  };
  const notifications = {
    notifyReelLike: jest.fn().mockResolvedValue(undefined),
    notifyNewFollower: jest.fn().mockResolvedValue(undefined),
  };
  const hashtags = {
    findMatching: jest.fn().mockResolvedValue([]),
  };
  const limits = new LimitsService({
    get: (key: string) => LIMIT_VALUES[key],
  } as never);

  const service = new ReelsService(
    repository as unknown as ReelsRepository,
    accounts as unknown as AccountsService,
    standing as unknown as StandingService,
    presenter as unknown as ReelPresenter,
    lifecycle as unknown as ReelLifecycleService,
    notifications as unknown as ReelsNotificationsService,
    limits,
    hashtags as unknown as HashtagStatsService,
  );
  return {
    service,
    repository,
    accounts,
    standing,
    presenter,
    lifecycle,
    notifications,
    hashtags,
  };
}

describe('ReelsService', () => {
  describe('the exclusion set (FR-009, FR-047)', () => {
    it("is the viewer's block set joined with the accounts not in good standing", async () => {
      const { service, repository, accounts, standing } = setup();
      accounts.getBlockSet.mockResolvedValue(['blocked-1']);
      standing.members.mockResolvedValue(new Set(['suspended-1']));

      await service.getFeed({ user: me }, {});

      expect(accounts.getBlockSet).toHaveBeenCalledWith(meId);
      const params = argOf<unknown>(repository.listFeed, 0, 0) as {
        excludeCreatorIds: string[];
      };
      expect(params.excludeCreatorIds.sort()).toEqual([
        'blocked-1',
        'suspended-1',
      ]);
    });

    it('never contains the viewer: an owner still sees their own content while out of good standing', async () => {
      const { service, repository, standing } = setup();
      standing.members.mockResolvedValue(new Set([meId, 'other-suspended']));

      await service.getFeed({ user: me }, {});

      const params = argOf<unknown>(repository.listFeed, 0, 0) as {
        excludeCreatorIds: string[];
      };
      expect(params.excludeCreatorIds).toEqual(['other-suspended']);
    });

    it('is just the standing set for a signed-out visitor, who has no block list', async () => {
      const { service, repository, accounts, standing } = setup();
      standing.members.mockResolvedValue(new Set(['suspended-1']));

      await service.getFeed({}, {});

      expect(accounts.getBlockSet).not.toHaveBeenCalled();
      expect(
        argOf<{
          excludeCreatorIds: string[];
        }>(repository.listFeed, 0, 0).excludeCreatorIds,
      ).toEqual(['suspended-1']);
    });

    it.each([
      [
        'getFollowingFeed',
        (s: ReelsService) => s.getFollowingFeed(me, {}),
        'listFollowingFeed',
      ],
      ['getLiked', (s: ReelsService) => s.getLiked(me, {}), 'listLiked'],
      ['getSaved', (s: ReelsService) => s.getSaved(me, {}), 'listSaved'],
      [
        'searchReels',
        (s: ReelsService) => s.searchReels(me, { q: 'x' }),
        'searchReels',
      ],
    ])('is applied to %s', async (_name, call, method) => {
      const harness = setup();
      harness.standing.members.mockResolvedValue(new Set(['suspended-1']));

      await call(harness.service);

      const repository = harness.repository as unknown as Record<
        string,
        jest.Mock
      >;
      expect(JSON.stringify(repository[method].mock.calls[0])).toContain(
        'suspended-1',
      );
    });
  });

  describe('getFeed', () => {
    it('presents the page for this viewer and forwards the cursor', async () => {
      const { service, repository, presenter } = setup();
      const record = { id: 'r1' } as ReelRecord;
      repository.listFeed.mockResolvedValue({
        items: [record],
        nextCursor: 'next',
      });

      const page = await service.getFeed({ user: me }, { cursor: 'abc' });

      expect(page.nextCursor).toBe('next');
      expect(presenter.present).toHaveBeenCalledWith([record], { user: me });
      expect(page.items).toEqual([{ id: 'r1', presented: true }]);
      expect(argOf<{ cursor: string }>(repository.listFeed, 0, 0).cursor).toBe(
        'abc',
      );
    });

    it('uses the configured default page size, and clamps a larger request (FR-019, FR-070)', async () => {
      const { service, repository } = setup();

      await service.getFeed({ user: me }, {});
      await service.getFeed({ user: me }, { limit: 7 });
      await service.getFeed({ user: me }, { limit: 100 });

      const limits = callsOf(repository.listFeed).map(
        (call) => (call[0] as { limit: number }).limit,
      );
      expect(limits).toEqual([10, 7, 25]);
    });

    it('normalizes a hashtag so the # and the spelling variant do not matter (FR-049a)', async () => {
      const { service, repository } = setup();

      await service.getFeed({ user: me }, { hashtag: '#إطارات' });
      await service.getFeed({ user: me }, { hashtag: 'OilFilter' });
      await service.getFeed({ user: me }, { hashtag: '' });

      const tags = callsOf(repository.listFeed).map(
        (call) => (call[0] as { hashtag?: string }).hashtag,
      );
      expect(tags).toEqual(['اطارات', 'oilfilter', undefined]);
    });

    it('works for a signed-out visitor, with no viewer id', async () => {
      const { service, repository } = setup();
      await service.getFeed({}, {});
      expect(
        argOf<{ viewerId: string }>(repository.listFeed, 0, 0).viewerId,
      ).toBe('');
    });
  });

  describe('getReel', () => {
    it('is a 404 REEL_NOT_FOUND when the repository returns null', async () => {
      const { service, repository } = setup();
      repository.getReel.mockResolvedValue(null);

      const error = await service
        .getReel({ user: me }, reelId)
        .catch((e: unknown) => e);

      expect(error).toBeInstanceOf(NotFoundException);
      expect((error as NotFoundException).getResponse()).toMatchObject({
        error: 'REEL_NOT_FOUND',
      });
    });

    it('presents the reel for this viewer', async () => {
      const { service, repository, presenter } = setup();
      const record = { id: reelId } as ReelRecord;
      repository.getReel.mockResolvedValue(record);

      await service.getReel({ user: me }, reelId);

      expect(presenter.presentOne).toHaveBeenCalledWith(record, { user: me });
    });

    it("filters the exclusion set into the read, so a suspended creator's reel is a 404 for others", async () => {
      const { service, repository, standing } = setup();
      standing.members.mockResolvedValue(new Set([otherId]));
      repository.getReel.mockResolvedValue(null);

      await expect(
        service.getReel({ user: me }, reelId),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(repository.getReel).toHaveBeenCalledWith(reelId, meId, [otherId]);
    });
  });

  describe('toggleLike', () => {
    it('notifies the creator when a like turns ON', async () => {
      const { service, repository, notifications } = setup();
      repository.toggleLike.mockResolvedValue({
        liked: true,
        likesCount: 4,
        reel: { id: reelId, creatorId: otherId },
      });

      expect(await service.toggleLike(me, reelId)).toEqual({
        liked: true,
        likesCount: 4,
      });
      expect(notifications.notifyReelLike).toHaveBeenCalledWith({
        actorId: meId,
        recipientId: otherId,
        reelId,
      });
    });

    it('does NOT notify when a like turns OFF', async () => {
      const { service, repository, notifications } = setup();
      repository.toggleLike.mockResolvedValue({
        liked: false,
        likesCount: 3,
        reel: { id: reelId, creatorId: otherId },
      });

      await service.toggleLike(me, reelId);

      expect(notifications.notifyReelLike).not.toHaveBeenCalled();
    });

    it('is a 404 for an unknown reel', async () => {
      const { service, repository } = setup();
      repository.toggleLike.mockResolvedValue(null);
      await expect(service.toggleLike(me, reelId)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });

  describe('toggleFollow', () => {
    it('notifies the followee when following turns ON', async () => {
      const { service, repository, notifications } = setup();
      repository.toggleFollow.mockResolvedValue({
        following: true,
        followersCount: 5,
      });

      await service.toggleFollow(me, otherId);

      expect(notifications.notifyNewFollower).toHaveBeenCalledWith({
        actorId: meId,
        recipientId: otherId,
      });
    });

    it('does NOT notify when unfollowing', async () => {
      const { service, repository, notifications } = setup();
      repository.toggleFollow.mockResolvedValue({
        following: false,
        followersCount: 4,
      });

      await service.toggleFollow(me, otherId);

      expect(notifications.notifyNewFollower).not.toHaveBeenCalled();
    });

    it('rejects following yourself with CANNOT_FOLLOW_SELF', async () => {
      const { service, repository } = setup();
      repository.toggleFollow.mockResolvedValue('self');

      const error = await service
        .toggleFollow(me, meId)
        .catch((e: unknown) => e);

      expect(error).toBeInstanceOf(BadRequestException);
      expect((error as BadRequestException).getResponse()).toMatchObject({
        error: 'CANNOT_FOLLOW_SELF',
      });
    });

    it('is a 404 ACCOUNT_NOT_FOUND for an unknown account', async () => {
      const { service, repository } = setup();
      repository.toggleFollow.mockResolvedValue(null);

      const error = await service
        .toggleFollow(me, otherId)
        .catch((e: unknown) => e);

      expect((error as NotFoundException).getResponse()).toMatchObject({
        error: 'ACCOUNT_NOT_FOUND',
      });
    });
  });

  describe('recordView (FR-024)', () => {
    it('records a signed-in view per account', async () => {
      const { service, repository } = setup();
      repository.recordView.mockResolvedValue({ viewsCount: 3 });

      expect(await service.recordView({ user: me }, reelId)).toEqual({
        viewsCount: 3,
      });
      expect(repository.recordView).toHaveBeenCalledWith(reelId, meId);
      expect(repository.recordGuestView).not.toHaveBeenCalled();
    });

    it('records a signed-out view per installation', async () => {
      const { service, repository } = setup();
      repository.recordGuestView.mockResolvedValue({ viewsCount: 9 });

      expect(
        await service.recordView({ installationId: 'inst-1' }, reelId),
      ).toEqual({ viewsCount: 9 });
      expect(repository.recordGuestView).toHaveBeenCalledWith(reelId, 'inst-1');
      expect(repository.recordView).not.toHaveBeenCalled();
    });

    it('records nothing for a signed-out visitor without an installation id, and reports the count', async () => {
      const { service, repository } = setup();
      repository.getReel.mockResolvedValue({ viewsCount: 12 });

      expect(await service.recordView({}, reelId)).toEqual({ viewsCount: 12 });
      expect(repository.recordView).not.toHaveBeenCalled();
      expect(repository.recordGuestView).not.toHaveBeenCalled();
    });

    it('is a 404 for an unknown reel in every case', async () => {
      const { service, repository } = setup();
      repository.recordView.mockResolvedValue(null);
      repository.recordGuestView.mockResolvedValue(null);
      repository.getReel.mockResolvedValue(null);

      await expect(
        service.recordView({ user: me }, reelId),
      ).rejects.toBeInstanceOf(NotFoundException);
      await expect(
        service.recordView({ installationId: 'i' }, reelId),
      ).rejects.toBeInstanceOf(NotFoundException);
      await expect(service.recordView({}, reelId)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });

  describe('toggleSave (FR-041)', () => {
    it('returns the repository result unchanged: no public counter', async () => {
      const { service, repository } = setup();
      repository.toggleSave.mockResolvedValue({ saved: true });
      expect(await service.toggleSave(me, reelId)).toEqual({ saved: true });
    });

    it('is a 404 for an unknown reel', async () => {
      const { service, repository } = setup();
      repository.toggleSave.mockResolvedValue(null);
      await expect(service.toggleSave(me, reelId)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });

  describe('toggleBlock (FR-047)', () => {
    it('delegates to the accounts service, which owns blocks', async () => {
      const { service, accounts } = setup();
      accounts.toggleBlock.mockResolvedValue({ blocked: true });

      expect(await service.toggleBlock(me, otherId)).toEqual({ blocked: true });
      expect(accounts.toggleBlock).toHaveBeenCalledWith(meId, otherId);
    });
  });

  describe('deleteReel (FR-032)', () => {
    it('deletes, then lets the lifecycle remove the media and the hashtag counts', async () => {
      const { service, repository, lifecycle } = setup();
      const deleted = snapshot({ creatorId: meId });
      repository.deleteReelCascade.mockResolvedValue(deleted);

      expect(await service.deleteReel(me, reelId)).toEqual({ deleted: true });
      expect(lifecycle.onDeleted).toHaveBeenCalledWith(deleted);
    });

    it('is a 404 for an unknown reel, and touches no media', async () => {
      const { service, repository, lifecycle } = setup();
      repository.deleteReelCascade.mockResolvedValue(null);

      await expect(service.deleteReel(me, reelId)).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(lifecycle.onDeleted).not.toHaveBeenCalled();
    });

    it("is a 403 NOT_REEL_OWNER for someone else's reel, and touches no media", async () => {
      const { service, repository, lifecycle } = setup();
      repository.deleteReelCascade.mockResolvedValue('forbidden');

      const error = await service
        .deleteReel(me, reelId)
        .catch((e: unknown) => e);

      expect(error).toBeInstanceOf(ForbiddenException);
      expect((error as ForbiddenException).getResponse()).toMatchObject({
        error: 'NOT_REEL_OWNER',
      });
      expect(lifecycle.onDeleted).not.toHaveBeenCalled();
    });
  });

  describe('reportReel (FR-053 to FR-056)', () => {
    const dto = { reason: 'spam' as const };

    it('reports once, with the configured auto-hide threshold', async () => {
      const { service, repository } = setup();
      repository.reportReel.mockResolvedValue('reported');

      expect(await service.reportReel(me, reelId, dto)).toEqual({
        reported: true,
        alreadyReported: false,
      });
      expect(repository.reportReel).toHaveBeenCalledWith(
        reelId,
        meId,
        'spam',
        undefined,
        25,
      );
    });

    it('accepts a repeat report silently (FR-054)', async () => {
      const { service, repository, lifecycle } = setup();
      repository.reportReel.mockResolvedValue('duplicate');

      expect(await service.reportReel(me, reelId, dto)).toEqual({
        reported: true,
        alreadyReported: true,
      });
      expect(lifecycle.onUnpublished).not.toHaveBeenCalled();
    });

    it('takes the media down when this report hid the reel (FR-056)', async () => {
      const { service, repository, lifecycle } = setup();
      const hidden = snapshot({ status: 'hidden' });
      repository.reportReel.mockResolvedValue('hidden');
      repository.getSnapshot.mockResolvedValue(hidden);

      await service.reportReel(me, reelId, dto);

      expect(lifecycle.onUnpublished).toHaveBeenCalledWith(hidden);
    });

    it('does not run the lifecycle for a report that did not hide anything', async () => {
      const { service, repository, lifecycle } = setup();
      repository.reportReel.mockResolvedValue('reported');
      await service.reportReel(me, reelId, dto);
      expect(lifecycle.onUnpublished).not.toHaveBeenCalled();
    });

    it('is a 404 for an unknown or non-published reel', async () => {
      const { service, repository } = setup();
      repository.reportReel.mockResolvedValue(null);
      await expect(service.reportReel(me, reelId, dto)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('refuses reporting your own reel with CANNOT_REPORT_OWN_REEL', async () => {
      const { service, repository } = setup();
      repository.reportReel.mockResolvedValue('self');

      const error = await service
        .reportReel(me, reelId, dto)
        .catch((e: unknown) => e);

      expect(error).toBeInstanceOf(BadRequestException);
      expect((error as BadRequestException).getResponse()).toMatchObject({
        error: 'CANNOT_REPORT_OWN_REEL',
      });
    });

    it('answers 429 REPORT_DAILY_LIMIT at the limit, before recording anything (FR-055)', async () => {
      const { service, repository } = setup();
      repository.countRecentReelReports.mockResolvedValue(20);

      const error = await service
        .reportReel(me, reelId, dto)
        .catch((e: unknown) => e);

      expect(error).toBeInstanceOf(HttpException);
      expect((error as HttpException).getStatus()).toBe(429);
      expect((error as HttpException).getResponse()).toMatchObject({
        error: 'REPORT_DAILY_LIMIT',
      });
      expect(repository.reportReel).not.toHaveBeenCalled();
    });

    it('counts reports over a rolling 24 hours, not a calendar day', async () => {
      const { service, repository } = setup();
      repository.reportReel.mockResolvedValue('reported');
      const before = Date.now();

      await service.reportReel(me, reelId, dto);

      const [reporter, since] = repository.countRecentReelReports.mock
        .calls[0] as [string, Date];
      expect(reporter).toBe(meId);
      expect(before - since.getTime()).toBeGreaterThanOrEqual(
        24 * 60 * 60 * 1000 - 5,
      );
      expect(before - since.getTime()).toBeLessThan(
        24 * 60 * 60 * 1000 + 5_000,
      );
    });

    it('allows a report one below the limit', async () => {
      const { service, repository } = setup();
      repository.countRecentReelReports.mockResolvedValue(19);
      repository.reportReel.mockResolvedValue('reported');
      await expect(service.reportReel(me, reelId, dto)).resolves.toBeDefined();
    });
  });

  describe('operator review (FR-057, FR-058)', () => {
    it('listHiddenReels defaults to 20, caps at 50, and presents with operator links', async () => {
      const { service, repository, presenter } = setup();
      const hidden = [{ id: 'h1' }];
      repository.listHiddenReels.mockResolvedValue({
        items: hidden,
        nextCursor: 'n',
      });

      const page = await service.listHiddenReels({});
      await service.listHiddenReels({ limit: 500 });

      const limits = callsOf(repository.listHiddenReels).map(
        (c) => (c[0] as { limit: number }).limit,
      );
      expect(limits).toEqual([20, 50]);
      expect(presenter.presentHidden).toHaveBeenCalledWith(hidden);
      expect(page.nextCursor).toBe('n');
    });

    it('a restore puts the media back through the lifecycle', async () => {
      const { service, repository, lifecycle } = setup();
      const restored = snapshot({ status: 'published' });
      repository.adminModerateReel.mockResolvedValue(restored);

      expect(await service.adminModerateReel(reelId, 'restore')).toEqual({
        id: reelId,
        status: 'published',
      });
      expect(lifecycle.onRestored).toHaveBeenCalledWith(restored);
      expect(lifecycle.onUnpublished).not.toHaveBeenCalled();
    });

    it('a reject keeps the media private through the lifecycle', async () => {
      const { service, repository, lifecycle } = setup();
      const rejected = snapshot({ status: 'rejected' });
      repository.adminModerateReel.mockResolvedValue(rejected);

      expect(await service.adminModerateReel(reelId, 'reject')).toEqual({
        id: reelId,
        status: 'rejected',
      });
      // The reel was hidden, so its tags were already taken off then: not a second time.
      expect(lifecycle.onUnpublished).toHaveBeenCalledWith(rejected, {
        wasPublished: false,
      });
      expect(lifecycle.onRestored).not.toHaveBeenCalled();
    });

    it('is a 404 for an unknown reel', async () => {
      const { service, repository } = setup();
      repository.adminModerateReel.mockResolvedValue(null);
      await expect(
        service.adminModerateReel(reelId, 'restore'),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('is a 409 REEL_NOT_HIDDEN when it is not hidden, and runs no side effect', async () => {
      const { service, repository, lifecycle } = setup();
      repository.adminModerateReel.mockResolvedValue('not_hidden');

      const error = await service
        .adminModerateReel(reelId, 'restore')
        .catch((e: unknown) => e);

      expect(error).toBeInstanceOf(ConflictException);
      expect((error as ConflictException).getResponse()).toMatchObject({
        error: 'REEL_NOT_HIDDEN',
      });
      expect(lifecycle.onRestored).not.toHaveBeenCalled();
    });
  });

  describe('reposts and lists', () => {
    it('repostReel returns the result unchanged', async () => {
      const { service, repository } = setup();
      repository.repostReel.mockResolvedValue({ reposted: true });
      expect(await service.repostReel(me, reelId)).toEqual({ reposted: true });
    });

    it('repostReel is a 404 for an unknown or non-published reel', async () => {
      const { service, repository } = setup();
      repository.repostReel.mockResolvedValue(null);
      await expect(service.repostReel(me, reelId)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('repostReel refuses your own reel with CANNOT_REPOST_OWN_REEL', async () => {
      const { service, repository } = setup();
      repository.repostReel.mockResolvedValue('self');
      const error = await service
        .repostReel(me, reelId)
        .catch((e: unknown) => e);
      expect((error as BadRequestException).getResponse()).toMatchObject({
        error: 'CANNOT_REPOST_OWN_REEL',
      });
    });

    it('unrepostReel returns the result, and is a 404 for an unknown reel', async () => {
      const { service, repository } = setup();
      repository.unrepostReel.mockResolvedValueOnce({ reposted: false });
      expect(await service.unrepostReel(me, reelId)).toEqual({
        reposted: false,
      });

      repository.unrepostReel.mockResolvedValueOnce(null);
      await expect(service.unrepostReel(me, reelId)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('getFollowingFeed uses the default page size and presents the page', async () => {
      const { service, repository } = setup();
      await service.getFollowingFeed(me, {});
      expect(
        argOf<{ limit: number }>(repository.listFollowingFeed, 0, 0).limit,
      ).toBe(10);
    });

    it('getFollowingUsers defaults to 50, caps at 100, and forwards the cursor', async () => {
      const { service, repository } = setup();
      await service.getFollowingUsers(me, {});
      await service.getFollowingUsers(me, { cursor: 'c', limit: 30 });
      await service.getFollowingUsers(me, { limit: 500 });

      const calls = callsOf(repository.getFollowingUsers).map(
        (c) => c[0] as { limit: number; cursor?: string },
      );
      expect(calls.map((c) => c.limit)).toEqual([50, 30, 100]);
      expect(calls[1].cursor).toBe('c');
    });

    it('getReposted targets query.userId, which is public', async () => {
      const { service, repository } = setup();
      await service.getReposted({ user: me }, { userId: otherId });
      expect(repository.listReposted).toHaveBeenCalledWith(
        meId,
        otherId,
        expect.objectContaining({ limit: 10 }),
      );
    });

    it('getReposted defaults the target to the caller when signed in', async () => {
      const { service, repository } = setup();
      await service.getReposted({ user: me }, {});
      expect(argOf<unknown>(repository.listReposted, 0, 1)).toBe(meId);
    });

    it('getReposted needs a userId from a signed-out visitor: VALIDATION_FAILED (FR-004)', async () => {
      const { service } = setup();
      const error = await service.getReposted({}, {}).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(BadRequestException);
      expect((error as BadRequestException).getResponse()).toMatchObject({
        error: 'VALIDATION_FAILED',
      });
    });

    it('getReposted works for a signed-out visitor who names the account', async () => {
      const { service, repository } = setup();
      await service.getReposted({}, { userId: otherId });
      expect(repository.listReposted).toHaveBeenCalledWith(
        '',
        otherId,
        expect.anything(),
      );
    });

    it('getReposters uses the comment-sized page and forwards the exclusion set', async () => {
      const { service, repository, standing } = setup();
      standing.members.mockResolvedValue(new Set(['x']));
      await service.getReposters({ user: me }, reelId, {});
      expect(repository.listReposters).toHaveBeenCalledWith(
        reelId,
        expect.objectContaining({
          viewerId: meId,
          limit: 20,
          excludeUserIds: ['x'],
        }),
      );
    });

    it('getReposters is a 404 when the reel is unknown or not visible', async () => {
      const { service, repository } = setup();
      repository.listReposters.mockResolvedValue(null);
      await expect(
        service.getReposters({ user: me }, reelId, {}),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('product taps (FR-038)', () => {
    it('records a tap for a signed-in viewer, with the exclusion set, and answers null', async () => {
      const { service, repository, standing } = setup();
      standing.members.mockResolvedValue(new Set(['suspended']));
      repository.recordProductTap.mockResolvedValue('recorded');

      await expect(
        service.recordProductTap({ user: me }, reelId, '101'),
      ).resolves.toBeNull();

      expect(repository.recordProductTap).toHaveBeenCalledWith({
        reelId,
        productId: 101,
        viewerId: me.userId,
        installationId: undefined,
        excludeCreatorIds: ['suspended'],
      });
    });

    it('records a signed-out tap with the installation id', async () => {
      const { service, repository } = setup();
      repository.recordProductTap.mockResolvedValue('recorded');

      await service.recordProductTap(
        { installationId: 'inst-1' },
        reelId,
        '101',
      );

      expect(repository.recordProductTap).toHaveBeenCalledWith(
        expect.objectContaining({ viewerId: '', installationId: 'inst-1' }),
      );
    });

    it('is PRODUCT_LINK_NOT_FOUND for a product the reel does not link', async () => {
      const { service, repository } = setup();
      repository.recordProductTap.mockResolvedValue('not_linked');

      const error = await service
        .recordProductTap({ user: me }, reelId, '103')
        .catch((e: unknown) => e);

      expect(error).toBeInstanceOf(NotFoundException);
      expect((error as NotFoundException).getResponse()).toMatchObject({
        error: 'PRODUCT_LINK_NOT_FOUND',
      });
    });

    it('is REEL_NOT_FOUND for a reel the viewer cannot see', async () => {
      const { service, repository } = setup();
      repository.recordProductTap.mockResolvedValue(null);

      const error = await service
        .recordProductTap({ user: me }, reelId, '101')
        .catch((e: unknown) => e);

      expect((error as NotFoundException).getResponse()).toMatchObject({
        error: 'REEL_NOT_FOUND',
      });
    });

    it.each(['abc', '0', '-5', '1.5', ''])(
      'is PRODUCT_LINK_NOT_FOUND for a product id that is %p, without asking the repository',
      async (productId) => {
        const { service, repository } = setup();

        const error = await service
          .recordProductTap({ user: me }, reelId, productId)
          .catch((e: unknown) => e);

        expect((error as NotFoundException).getResponse()).toMatchObject({
          error: 'PRODUCT_LINK_NOT_FOUND',
        });
        expect(repository.recordProductTap).not.toHaveBeenCalled();
      },
    );
  });

  describe('comments', () => {
    it('clamps the page size to the configured maximum and forwards the exclusion set', async () => {
      const { service, repository, standing } = setup();
      standing.members.mockResolvedValue(new Set(['suspended']));
      repository.listComments.mockResolvedValue({
        items: [],
        nextCursor: null,
        commentsCount: 0,
      });

      await service.getComments({ user: me }, reelId, { limit: 500 });

      expect(repository.listComments).toHaveBeenCalledWith(
        reelId,
        expect.objectContaining({ limit: 50, excludeAuthorIds: ['suspended'] }),
      );
    });

    it('tells the repository who is asking, so it can say what they may do with each comment', async () => {
      const { service, repository } = setup();
      repository.listComments.mockResolvedValue({
        items: [],
        nextCursor: null,
        commentsCount: 0,
      });

      await service.getComments({ user: me }, reelId, {});
      await service.getComments({}, reelId, {});

      expect(repository.listComments).toHaveBeenNthCalledWith(
        1,
        reelId,
        expect.objectContaining({ viewerId: me.userId }),
      );
      // A signed-out visitor has no id, so every flag comes back false.
      expect(repository.listComments).toHaveBeenNthCalledWith(
        2,
        reelId,
        expect.objectContaining({ viewerId: '' }),
      );
    });

    it('is a 404 when the reel is unknown', async () => {
      const { service, repository } = setup();
      repository.listComments.mockResolvedValue(null);
      await expect(service.getComments({}, reelId, {})).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('addComment and recordShare are 404s for an unknown reel', async () => {
      const { service, repository } = setup();
      repository.addComment.mockResolvedValue(null);
      repository.recordShare.mockResolvedValue(null);
      await expect(service.addComment(me, reelId, 'hi')).rejects.toBeInstanceOf(
        NotFoundException,
      );
      await expect(service.recordShare(me, reelId)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });

  describe('profiles', () => {
    it('is a 404 ACCOUNT_NOT_FOUND when the account is unknown or excluded', async () => {
      const { service, repository } = setup();
      repository.getProfile.mockResolvedValue(null);

      const error = await service
        .getProfile({ user: me }, otherId)
        .catch((e: unknown) => e);

      expect((error as NotFoundException).getResponse()).toMatchObject({
        error: 'ACCOUNT_NOT_FOUND',
      });
    });

    it('presents the profile for this viewer, thumbnails included', async () => {
      const { service, repository, presenter } = setup();
      const record = { user: { id: otherId } };
      repository.getProfile.mockResolvedValue(record);

      await service.getProfile({ user: me }, otherId);

      expect(presenter.presentProfile).toHaveBeenCalledWith(record, {
        user: me,
      });
    });

    it('searches accounts with the normalized query (FR-049a)', async () => {
      const { service, repository } = setup();
      await service.searchUsers(me, { q: 'أحمد' });
      expect(argOf<{ q: string }>(repository.searchUsers, 0, 0).q).toBe('احمد');
    });

    describe('searching reels (FR-049, research R9)', () => {
      it('normalizes the query, finds the matching tags in the dictionary, and searches by them', async () => {
        const { service, repository, hashtags } = setup();
        hashtags.findMatching.mockResolvedValue(['اطارات', 'اطارات_جديده']);

        await service.searchReels(me, { q: 'إطار' });

        expect(hashtags.findMatching).toHaveBeenCalledWith('اطار');
        expect(repository.searchReels).toHaveBeenCalledWith(
          expect.objectContaining({
            viewerId: me.userId,
            tags: ['اطارات', 'اطارات_جديده'],
          }),
        );
      });

      it('ignores a leading #, and treats a query of only # as no query', async () => {
        const { service, hashtags } = setup();

        await service.searchReels(me, { q: '#فلتر' });
        await service.searchReels(me, { q: '##' });

        expect(hashtags.findMatching).toHaveBeenNthCalledWith(1, 'فلتر');
        expect(hashtags.findMatching).toHaveBeenNthCalledWith(2, '');
      });

      it('passes the exclusion set and the clamped page size on', async () => {
        const { service, repository, standing } = setup();
        standing.members.mockResolvedValue(new Set(['suspended']));

        await service.searchReels(me, { q: 'x', limit: 500 });

        expect(repository.searchReels).toHaveBeenCalledWith(
          expect.objectContaining({
            limit: 25,
            excludeCreatorIds: ['suspended'],
          }),
        );
      });
    });
  });
});
